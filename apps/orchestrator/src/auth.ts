import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

const SESSION_COOKIE = "think_tank_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ApiAuthConfig {
  username?: string;
  password?: string;
  serviceApiKey?: string;
}

interface Session {
  username: string;
  expiresAt: number;
}

export interface AuthService {
  readonly enabled: boolean;
  readonly username: string | undefined;
  authenticate(username: string, password: string): string | undefined;
  isBrowserAuthenticated(request: IncomingMessage): boolean;
  isServiceAuthenticated(request: IncomingMessage): boolean;
  clear(request: IncomingMessage): string | undefined;
  cookie(token: string): string;
  expiredCookie(): string;
}

export function createAuthService(config: ApiAuthConfig = {}): AuthService {
  const username = config.username?.trim() || undefined;
  const password = config.password || undefined;
  const serviceApiKey = config.serviceApiKey?.trim() || undefined;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("APP_AUTH_USERNAME and APP_AUTH_PASSWORD must be configured together.");
  }
  const enabled = Boolean(username && password);
  const sessions = new Map<string, Session>();

  const configuredMatches = (actual: string, expected: string): boolean => {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  };

  const getCookie = (headers: IncomingHttpHeaders, name: string): string | undefined => {
    const raw = headers.cookie;
    if (typeof raw !== "string") return undefined;
    return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  };

  const purgeExpired = () => {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  };

  const sessionFor = (request: IncomingMessage): Session | undefined => {
    purgeExpired();
    const token = getCookie(request.headers, SESSION_COOKIE);
    if (!token) return undefined;
    return sessions.get(token);
  };

  return {
    enabled,
    username,
    authenticate(actualUsername, actualPassword) {
      if (!enabled || !username || !password || !configuredMatches(actualUsername, username) || !configuredMatches(actualPassword, password)) return undefined;
      const token = randomUUID();
      sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
      return token;
    },
    isBrowserAuthenticated(request) {
      return !enabled || Boolean(sessionFor(request));
    },
    isServiceAuthenticated(request) {
      if (!serviceApiKey) return false;
      const value = request.headers["x-think-tank-service-key"];
      return typeof value === "string" && configuredMatches(value, serviceApiKey);
    },
    clear(request) {
      const token = getCookie(request.headers, SESSION_COOKIE);
      if (token) sessions.delete(token);
      return token;
    },
    cookie(token) {
      return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1_000}`;
    },
    expiredCookie() {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
  };
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiAuthConfig {
  return {
    username: env.APP_AUTH_USERNAME?.trim() || undefined,
    password: env.APP_AUTH_PASSWORD || undefined,
    serviceApiKey: env.ORCHESTRATOR_SERVICE_API_KEY?.trim() || undefined,
  };
}

export function isServiceTaskApiRequest(method: string | undefined, pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (method === "POST" && pathname === "/api/tasks") return true;
  if (method !== "GET" || segments[0] !== "api" || segments[1] !== "tasks" || !segments[2]) {
    return false;
  }
  if (segments.length === 3) return true;
  if (segments.length === 4 && segments[3] === "report-document") return true;
  return segments.length === 5 &&
    segments[3] === "export" &&
    ["markdown", "docx", "pdf"].includes(segments[4] ?? "");
}

export { SESSION_COOKIE };
