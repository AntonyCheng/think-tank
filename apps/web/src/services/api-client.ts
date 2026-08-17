import type {
  ExpertEvidenceBundle,
  ResearchHistoryFilter,
  ResearchHistoryPage,
  ResearchTaskDiagnostic,
  ResearchTaskSnapshot,
} from "../domain/task";
import type {
  RuntimeSettings,
  RuntimeSettingsSaveResult,
  RuntimeSettingsUpdate,
  SettingsPreflightCheck,
} from "../domain/settings";
import type { AgentCatalogEntry } from "../domain/agent";
import {
  TASK_EVENT_TYPES,
  type TaskEvent,
  type TaskEventType,
} from "../domain/research-events";
import { notifyAuthRequired } from "./auth-client";

export interface ResearchTopicRecommendation {
  id: string;
  category: string;
  title: string;
  summary: string;
  sources: Array<{
    title: string;
    url: string;
    domain: string;
  }>;
}

export interface ResearchTopicRecommendationResponse {
  items: ResearchTopicRecommendation[];
  updatedAt: string | null;
  nextRefreshAt: string | null;
  source: "generated" | "fallback";
  refreshing: boolean;
}

export interface ManagedUser {
  id: string;
  username: string;
  role: "admin" | "member";
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  notifyAuthRequired(response);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export interface CreateResearchTaskInput {
  topic: string;
  taskId?: string;
  researchProfile?: Record<string, unknown>;
}

export async function createResearchTask(input: CreateResearchTaskInput): Promise<ResearchTaskSnapshot> {
  return requestJson<ResearchTaskSnapshot>("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function uploadResearchDocument(taskId: string, name: string, contentBase64: string): Promise<{ documentId: string }> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, contentBase64 }),
  });
}

export function getResearchTask(taskId: string): Promise<ResearchTaskSnapshot> {
  return requestJson<ResearchTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function getExpertResearchResult(taskId: string, stepId: string): Promise<ExpertEvidenceBundle> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/experts/${encodeURIComponent(stepId)}`);
}

export async function getTaskDiagnostics(taskId: string): Promise<ResearchTaskDiagnostic[]> {
  const response = await requestJson<{ diagnostics?: unknown }>(`/api/tasks/${encodeURIComponent(taskId)}/diagnostics`);
  if (!Array.isArray(response.diagnostics)) return [];
  return response.diagnostics.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const diagnostic = value as Partial<ResearchTaskDiagnostic>;
    if (typeof diagnostic.id !== "number" || typeof diagnostic.timestamp !== "string" || typeof diagnostic.stage !== "string" || typeof diagnostic.message !== "string") return [];
    return [{ id: diagnostic.id, timestamp: diagnostic.timestamp, stage: diagnostic.stage, message: diagnostic.message }];
  });
}

export async function getAgentCatalog(): Promise<AgentCatalogEntry[]> {
  const response = await requestJson<{ agents?: unknown }>("/api/agents");
  if (!Array.isArray(response.agents)) throw new Error("专家目录格式无效");
  return response.agents.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const agent = value as Partial<AgentCatalogEntry>;
    if (typeof agent.id !== "string" || typeof agent.name !== "string" || typeof agent.emoji !== "string") return [];
    return [{ id: agent.id, name: agent.name, emoji: agent.emoji }];
  });
}

export function getResearchTopicRecommendations(): Promise<ResearchTopicRecommendationResponse> {
  return requestJson<ResearchTopicRecommendationResponse>("/api/recommendations/research-topics");
}

export function listResearchHistory(input: {
  filter?: ResearchHistoryFilter;
  query?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<ResearchHistoryPage> {
  const search = new URLSearchParams();
  if (input.filter && input.filter !== "all") search.set("filter", input.filter);
  if (input.query?.trim()) search.set("q", input.query.trim());
  if (input.limit) search.set("limit", String(input.limit));
  if (input.cursor) search.set("cursor", input.cursor);
  const suffix = search.size ? `?${search.toString()}` : "";
  return requestJson<ResearchHistoryPage>(`/api/tasks${suffix}`);
}

export async function deleteResearchTask(taskId: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export function getRuntimeSettings(): Promise<RuntimeSettings> {
  return requestJson<RuntimeSettings>("/api/settings");
}

export function updateRuntimeSettings(
  input: RuntimeSettingsUpdate,
  scope: "models" | "fallbackModels" | "embedding" | "retrievers" | "scheduling" = "models",
): Promise<RuntimeSettingsSaveResult> {
  return requestSettingsSave("/api/settings", { ...input, scope }, "PUT");
}

export function preflightRuntimeSettings(
  input: RuntimeSettingsUpdate,
  scope: "models" | "fallbackModels" | "embedding" | "retrievers",
): Promise<SettingsPreflightCheck[]> {
  return requestSettingsSave("/api/settings/preflight", { ...input, scope }, "POST")
    .then((result) => result.checks);
}

export function listManagedUsers(): Promise<{ users: ManagedUser[] }> {
  return requestJson<{ users: ManagedUser[] }>("/api/admin/users");
}

export function createManagedUser(input: { username: string; password: string; role: "admin" | "member" }): Promise<{ user: ManagedUser }> {
  return requestJson<{ user: ManagedUser }>("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateManagedUser(id: string, input: { active?: boolean; role?: "admin" | "member"; password?: string }): Promise<{ user: ManagedUser }> {
  return requestJson<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteManagedUser(id: string): Promise<void> {
  await requestJson(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function requestSettingsSave(
  url: string,
  input: RuntimeSettingsUpdate & { scope?: string },
  method: "POST" | "PUT",
): Promise<RuntimeSettingsSaveResult> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  notifyAuthRequired(response);
  const payload = await response.json().catch(() => ({})) as RuntimeSettingsSaveResult & {
    error?: string;
    checks?: SettingsPreflightCheck[];
  };
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（${response.status}）`) as Error & {
      checks?: SettingsPreflightCheck[];
    };
    error.checks = payload.checks;
    throw error;
  }
  return payload;
}

export function answerResearchInput(taskId: string, requestId: string, answer: string) {
  return requestJson<ResearchTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, answer }),
  });
}

export function cancelResearchTask(taskId: string) {
  return requestJson<ResearchTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
}

export function retryResearchTask(taskId: string) {
  return requestJson<ResearchTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
}

export function continueResearchTask(taskId: string) {
  return requestJson<ResearchTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/continue`, { method: "POST" });
}

export function subscribeToTaskEvents(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  onState: (state: "open" | "closed") => void,
): () => void {
  const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
  const handleEvent = (event: Event) => {
    const message = event as MessageEvent<string>;
    try {
      const payload = JSON.parse(message.data) as TaskEvent;
      if (payload && typeof payload.id === "number") {
        onEvent(payload);
      }
    } catch {
      // Ignore malformed event frames; the snapshot remains the source of truth.
    }
  };
  const listeners = TASK_EVENT_TYPES.map((type) => {
    source.addEventListener(type, handleEvent);
    return type as TaskEventType;
  });
  source.onopen = () => onState("open");
  source.onerror = () => onState("closed");
  return () => {
    listeners.forEach((type) => source.removeEventListener(type, handleEvent));
    source.close();
  };
}
