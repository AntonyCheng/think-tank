import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApiServer } from "../src/api-server.js";
import {
  createAuthService,
  isServiceTaskApiRequest,
} from "../src/auth.js";
import type { IdentityService } from "../src/identity.js";
import { ResearchTaskManager } from "../src/research-tasks.js";

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

test("rejects a partially configured browser login", () => {
  assert.throws(
    () => createAuthService({ username: "admin" }),
    /APP_AUTH_USERNAME and APP_AUTH_PASSWORD must be configured together/u,
  );
  assert.throws(
    () => createAuthService({ password: "secret" }),
    /APP_AUTH_USERNAME and APP_AUTH_PASSWORD must be configured together/u,
  );
});

test("limits service authentication to the MCP task contract", () => {
  assert.equal(isServiceTaskApiRequest("POST", "/api/tasks"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1/report-document"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1/export/markdown"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1/export/docx"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1/export/pdf"), true);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks"), false);
  assert.equal(isServiceTaskApiRequest("POST", "/api/tasks/task-1/cancel"), false);
  assert.equal(isServiceTaskApiRequest("GET", "/api/tasks/task-1/diagnostics"), false);
  assert.equal(isServiceTaskApiRequest("GET", "/api/settings"), false);
});

test("protects browser APIs and limits the MCP key to its required task routes", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }));
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { username: "admin", password: "secret", serviceApiKey: "service-secret" },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const initialStatus = await fetch(`${baseUrl}/api/auth/status`).then((response) => response.json()) as { enabled: boolean; authenticated: boolean };
  assert.deepEqual(initialStatus, { enabled: true, authenticated: false });
  const anonymous = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(anonymous.status, 401);

  const wrongLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" }),
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret" }),
  });
  assert.equal(login.status, 200);
  const browserCookie = cookieFrom(login);
  assert.ok(browserCookie);
  assert.equal((await fetch(`${baseUrl}/api/tasks`, { headers: { Cookie: browserCookie } })).status, 200);

  const serviceSubmit = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Think-Tank-Service-Key": "service-secret",
    },
    body: JSON.stringify({ topic: "MCP 鉴权测试" }),
  });
  assert.equal(serviceSubmit.status, 202);
  const serviceTask = await serviceSubmit.json() as { id: string };
  assert.ok(serviceTask.id);
  const serviceStatusResponse = await fetch(`${baseUrl}/api/tasks/${serviceTask.id}`, {
    headers: { "X-Think-Tank-Service-Key": "service-secret" },
  });
  assert.equal(serviceStatusResponse.status, 200);
  const serviceStatus = await serviceStatusResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(serviceStatus).sort(), ["id", "reportReady", "status", "topic"]);
  assert.equal((await fetch(`${baseUrl}/api/tasks`, {
    headers: { "X-Think-Tank-Service-Key": "service-secret" },
  })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${serviceTask.id}/cancel`, {
    method: "POST",
    headers: { "X-Think-Tank-Service-Key": "service-secret" },
  })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/agents`, { headers: { "X-Think-Tank-Service-Key": "service-secret" } })).status, 401);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { headers: { Cookie: browserCookie }, method: "POST" });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/tasks`, { headers: { Cookie: browserCookie } })).status, 401);
});

test("isolates every task route by the authenticated task owner", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }));
  const users = {
    alice: { id: "user-alice", username: "alice", role: "member" as const },
    bob: { id: "user-bob", username: "bob", role: "member" as const },
  };
  const identity: IdentityService = {
    serviceOwnerId: "user-admin",
    async initialize() {},
    async authenticate() { return undefined; },
    async principalFor(request) {
      const cookie = request.headers.cookie;
      return cookie === "session=alice" ? users.alice : cookie === "session=bob" ? users.bob : undefined;
    },
    async logout() {},
    async getUser(id) {
      const user = Object.values(users).find((candidate) => candidate.id === id);
      return user && { ...user, active: true, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
    },
    async changePassword(id, currentPassword, nextPassword) {
      return id === users.alice.id && currentPassword === "old-password" && nextPassword === "new-password";
    },
    async listUsers() { return []; },
    async createUser() { throw new Error("not used"); },
    async updateUser() { return undefined; },
    async deleteUser() { return false; },
    cookie(token) { return `session=${token}`; },
    expiredCookie() { return "session=; Max-Age=0"; },
  };
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    identity,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const profile = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: "session=alice" } });
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), {
    user: {
      id: "user-alice",
      username: "alice",
      role: "member",
      active: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  });
  const rejectedPassword = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=alice" },
    body: JSON.stringify({ currentPassword: "wrong", nextPassword: "new-password" }),
  });
  assert.equal(rejectedPassword.status, 401);
  const changedPassword = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=alice" },
    body: JSON.stringify({ currentPassword: "old-password", nextPassword: "new-password" }),
  });
  assert.equal(changedPassword.status, 200);
  assert.match(changedPassword.headers.get("set-cookie") ?? "", /Max-Age=0/u);

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=alice" },
    body: JSON.stringify({ topic: "Alice 的私有研究" }),
  });
  assert.equal(created.status, 202);
  const task = await created.json() as { id: string };

  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: { Cookie: "session=bob" } })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}/diagnostics`, { headers: { Cookie: "session=bob" } })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: { Cookie: "session=bob" } })).status, 404);
  const history = await fetch(`${baseUrl}/api/tasks`, { headers: { Cookie: "session=bob" } }).then((response) => response.json()) as { items: unknown[] };
  assert.deepEqual(history.items, []);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: { Cookie: "session=alice" } })).status, 200);
});

test("allows an administrator to delete another user but never itself", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }));
  let deletedId: string | undefined;
  const identity: IdentityService = {
    serviceOwnerId: "user-admin",
    async initialize() {},
    async authenticate() { return undefined; },
    async principalFor(request) {
      return request.headers.cookie === "session=admin"
        ? { id: "user-admin", username: "admin", role: "admin" }
        : undefined;
    },
    async logout() {},
    async getUser() { return undefined; },
    async changePassword() { return false; },
    async listUsers() { return []; },
    async createUser() { throw new Error("not used"); },
    async updateUser() { return undefined; },
    async deleteUser(id) { deletedId = id; return true; },
    cookie(token) { return `session=${token}`; },
    expiredCookie() { return "session=; Max-Age=0"; },
  };
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    identity,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const other = await fetch(`${baseUrl}/api/admin/users/user-member`, {
    headers: { Cookie: "session=admin" },
    method: "DELETE",
  });
  assert.equal(other.status, 204);
  assert.equal(deletedId, "user-member");

  const self = await fetch(`${baseUrl}/api/admin/users/user-admin`, {
    headers: { Cookie: "session=admin" },
    method: "DELETE",
  });
  assert.equal(self.status, 409);
});
