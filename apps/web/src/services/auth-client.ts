export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  profileAvailable?: boolean;
  username?: string;
  role?: "admin" | "member";
}

export interface CurrentUserProfile {
  id: string;
  username: string;
  role: "admin" | "member";
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export const AUTH_REQUIRED_EVENT = "think-tank:auth-required";

export class AuthRequiredError extends Error {
  constructor() {
    super("请先登录");
    this.name = "AuthRequiredError";
  }
}

export function notifyAuthRequired(response: Response): void {
  if (response.status !== 401) return;
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  throw new AuthRequiredError();
}

async function requestAuth<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return requestAuth<AuthStatus>("/api/auth/status");
}

export function login(username: string, password: string): Promise<AuthStatus> {
  return requestAuth<AuthStatus>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<AuthStatus> {
  return requestAuth<AuthStatus>("/api/auth/logout", { method: "POST" });
}

export async function getCurrentUserProfile(): Promise<CurrentUserProfile> {
  const response = await requestAuth<{ user: CurrentUserProfile }>("/api/auth/me");
  return response.user;
}

export function changeCurrentUserPassword(
  currentPassword: string,
  nextPassword: string,
): Promise<AuthStatus> {
  return requestAuth<AuthStatus>("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, nextPassword }),
  });
}
