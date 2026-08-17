import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import type { ApiAuthConfig } from "./auth.js";
import type { PostgresDatabase } from "./postgres.js";

const SESSION_COOKIE = "think_tank_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSWORD_KEY_LENGTH = 64;

export type UserRole = "admin" | "member";

export interface AuthenticatedPrincipal {
  id: string;
  username: string;
  role: UserRole;
}

export interface ManagedUser extends AuthenticatedPrincipal {
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface IdentityService {
  readonly serviceOwnerId: string;
  initialize(): Promise<void>;
  authenticate(username: string, password: string): Promise<{ principal: AuthenticatedPrincipal; token: string } | undefined>;
  principalFor(request: IncomingMessage): Promise<AuthenticatedPrincipal | undefined>;
  logout(request: IncomingMessage): Promise<void>;
  getUser(id: string): Promise<ManagedUser | undefined>;
  changePassword(id: string, currentPassword: string, nextPassword: string): Promise<boolean>;
  listUsers(): Promise<ManagedUser[]>;
  createUser(input: { username: string; password: string; role?: UserRole }): Promise<ManagedUser>;
  updateUser(id: string, input: { active?: boolean; role?: UserRole; password?: string }): Promise<ManagedUser | undefined>;
  deleteUser(id: string): Promise<boolean>;
  cookie(token: string): string;
  expiredCookie(): string;
}

export class DatabaseIdentityService implements IdentityService {
  readonly #database: PostgresDatabase;
  readonly #bootstrapUsername: string | undefined;
  readonly #bootstrapPassword: string | undefined;
  #serviceOwnerId: string | undefined;

  constructor(database: PostgresDatabase, config: ApiAuthConfig) {
    this.#database = database;
    this.#bootstrapUsername = config.username?.trim() || undefined;
    this.#bootstrapPassword = config.password || undefined;
    if (Boolean(this.#bootstrapUsername) !== Boolean(this.#bootstrapPassword)) {
      throw new Error("APP_AUTH_USERNAME and APP_AUTH_PASSWORD must be configured together.");
    }
  }

  async initialize(): Promise<void> {
    const rows = await this.#database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM app_users");
    if (Number(rows[0]?.count ?? "0") === 0) {
      if (!this.#bootstrapUsername || !this.#bootstrapPassword) {
        throw new Error("首次启用多用户功能时，必须设置 APP_AUTH_USERNAME 和 APP_AUTH_PASSWORD 以创建管理员账号。");
      }
      await this.createUser({
        username: this.#bootstrapUsername,
        password: this.#bootstrapPassword,
        role: "admin",
      });
    }
    const bootstrap = this.#bootstrapUsername
      ? await this.findByUsername(this.#bootstrapUsername)
      : undefined;
    if (!bootstrap) {
      throw new Error("找不到由 APP_AUTH_USERNAME 指定的管理员账号。请恢复该账号或更新部署配置。");
    }
    this.#serviceOwnerId = bootstrap.id;
    await this.#database.query(`
      UPDATE research_tasks
      SET owner_user_id = $1,
          snapshot_json = jsonb_set(snapshot_json, '{ownerUserId}', to_jsonb($1::text), true)
      WHERE owner_user_id IS NULL
    `, [bootstrap.id]);
  }

  get serviceOwnerId(): string {
    if (!this.#serviceOwnerId) throw new Error("身份服务尚未初始化。");
    return this.#serviceOwnerId;
  }

  async authenticate(username: string, password: string): Promise<{ principal: AuthenticatedPrincipal; token: string } | undefined> {
    const user = await this.findByUsername(username);
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) return undefined;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.#database.transaction(async (client) => {
      await client.query(
        "INSERT INTO app_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
        [randomUUID(), user.id, tokenHash(token), expiresAt],
      );
      await client.query("UPDATE app_users SET last_login_at=now(), updated_at=now() WHERE id=$1", [user.id]);
    });
    return { principal: publicPrincipal(user), token };
  }

  async principalFor(request: IncomingMessage): Promise<AuthenticatedPrincipal | undefined> {
    const token = cookie(request.headers, SESSION_COOKIE);
    if (!token) return undefined;
    const rows = await this.#database.query<UserRow>(`
      SELECT u.id, u.username, u.role, u.active, u.password_hash,
             u.created_at::text, u.updated_at::text, u.last_login_at::text
      FROM app_sessions s
      JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active=true
    `, [tokenHash(token)]);
    const user = rows[0];
    return user ? publicPrincipal(user) : undefined;
  }

  async logout(request: IncomingMessage): Promise<void> {
    const token = cookie(request.headers, SESSION_COOKIE);
    if (!token) return;
    await this.#database.query("UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash(token)]);
  }

  async getUser(id: string): Promise<ManagedUser | undefined> {
    const user = await this.findById(id);
    return user ? managedUser(user) : undefined;
  }

  async changePassword(
    id: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<boolean> {
    const user = await this.findById(id);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return false;
    }
    await this.updateUser(id, { password: nextPassword });
    return true;
  }

  async listUsers(): Promise<ManagedUser[]> {
    const rows = await this.#database.query<UserRow>(`
      SELECT id, username, role, active, password_hash,
             created_at::text, updated_at::text, last_login_at::text
      FROM app_users ORDER BY created_at, username
    `);
    return rows.map(managedUser);
  }

  async createUser(input: { username: string; password: string; role?: UserRole }): Promise<ManagedUser> {
    const username = normalizeUsername(input.username);
    validatePassword(input.password);
    const id = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const rows = await this.#database.query<UserRow>(`
      INSERT INTO app_users(id,username,username_normalized,password_hash,role,active)
      VALUES($1,$2,$3,$4,$5,true)
      RETURNING id, username, role, active, password_hash,
                created_at::text, updated_at::text, last_login_at::text
    `, [id, username, username.toLocaleLowerCase(), passwordHash, input.role ?? "member"]);
    return managedUser(required(rows[0], "用户创建失败。"));
  }

  async updateUser(id: string, input: { active?: boolean; role?: UserRole; password?: string }): Promise<ManagedUser | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;
    if (input.password !== undefined) validatePassword(input.password);
    const passwordHash = input.password === undefined ? existing.password_hash : await hashPassword(input.password);
    const active = input.active ?? existing.active;
    const role = input.role ?? existing.role;
    if (existing.role === "admin" && existing.active && (role !== "admin" || !active)) {
      const rows = await this.#database.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM app_users WHERE role='admin' AND active=true",
      );
      if (Number(rows[0]?.count ?? "0") <= 1) {
        throw new Error("至少需要保留一个启用状态的管理员账号。");
      }
    }
    const rows = await this.#database.query<UserRow>(`
      UPDATE app_users SET password_hash=$2, active=$3, role=$4, updated_at=now()
      WHERE id=$1
      RETURNING id, username, role, active, password_hash,
                created_at::text, updated_at::text, last_login_at::text
    `, [id, passwordHash, active, role]);
    if (!active || input.password !== undefined) {
      await this.#database.query("UPDATE app_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
    }
    return managedUser(required(rows[0], "用户更新失败。"));
  }

  async deleteUser(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;
    if (id === this.serviceOwnerId) {
      throw new Error("不能删除 MCP 服务归属的管理员账号。请先在部署配置中切换服务账号。");
    }
    if (existing.role === "admin" && existing.active) {
      const rows = await this.#database.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM app_users WHERE role='admin' AND active=true",
      );
      if (Number(rows[0]?.count ?? "0") <= 1) {
        throw new Error("至少需要保留一个启用状态的管理员账号。");
      }
    }
    const taskRows = await this.#database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM research_tasks WHERE owner_user_id=$1",
      [id],
    );
    const taskCount = Number(taskRows[0]?.count ?? "0");
    if (taskCount > 0) {
      throw new Error(`该用户仍有 ${taskCount} 条研究记录，请先清理其研究记录后再删除账号。`);
    }
    await this.#database.query("DELETE FROM app_users WHERE id=$1", [id]);
    return true;
  }

  cookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1_000}${process.env.APP_COOKIE_SECURE === "true" ? "; Secure" : ""}`;
  }

  expiredCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.APP_COOKIE_SECURE === "true" ? "; Secure" : ""}`;
  }

  async #findByUsername(username: string): Promise<UserRow | undefined> {
    const normalized = username.trim().toLocaleLowerCase();
    if (!normalized) return undefined;
    const rows = await this.#database.query<UserRow>(`
      SELECT id, username, role, active, password_hash,
             created_at::text, updated_at::text, last_login_at::text
      FROM app_users WHERE username_normalized=$1
    `, [normalized]);
    return rows[0];
  }

  async findByUsername(username: string): Promise<UserRow | undefined> {
    return this.#findByUsername(username);
  }

  async #findById(id: string): Promise<UserRow | undefined> {
    const rows = await this.#database.query<UserRow>(`
      SELECT id, username, role, active, password_hash,
             created_at::text, updated_at::text, last_login_at::text
      FROM app_users WHERE id=$1
    `, [id]);
    return rows[0];
  }

  async findById(id: string): Promise<UserRow | undefined> {
    return this.#findById(id);
  }
}

interface UserRow {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  password_hash: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function publicPrincipal(user: UserRow): AuthenticatedPrincipal {
  return { id: user.id, username: user.username, role: user.role };
}

function managedUser(user: UserRow): ManagedUser {
  return {
    ...publicPrincipal(user),
    active: user.active,
    createdAt: new Date(user.created_at).toISOString(),
    updatedAt: new Date(user.updated_at).toISOString(),
    ...(user.last_login_at ? { lastLoginAt: new Date(user.last_login_at).toISOString() } : {}),
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, PASSWORD_KEY_LENGTH, 16_384, 8, 1);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !saltText || !hashText) return false;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await derivePassword(password, Buffer.from(saltText, "base64url"), expected.length, n, r, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derivePassword(password: string, salt: Buffer, length: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function cookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers.cookie;
  if (typeof raw !== "string") return undefined;
  return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function normalizeUsername(value: string): string {
  const username = value.trim();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/u.test(username)) {
    throw new Error("账号只能包含 3 至 64 个字母、数字、点、下划线或连字符。");
  }
  return username;
}

function validatePassword(value: string): void {
  if (value.length < 8 || value.length > 256) {
    throw new Error("密码长度必须在 8 至 256 个字符之间。");
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
