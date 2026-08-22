import type {
  ReportConversation,
  ReportDocument,
  ReportDocumentVersion,
  ReportEditorResponse,
  ReportOperation,
} from "../domain/report";
import { notifyAuthRequired } from "./auth-client";

export interface ReportSessionData {
  document: ReportDocument;
  conversations: ReportConversation[];
  operations: ReportOperation[];
}

export type ReportExportFormat = "docx" | "pdf" | "markdown";

const reportSessionCache = new Map<string, ReportSessionData>();

function reportSessionKey(taskId: string, scopeKey: string): string {
  return `${taskId}:${scopeKey}`;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  notifyAuthRequired(response);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function getReportDocument(taskId: string): Promise<ReportDocument> {
  return requestJson<ReportDocument>(`/api/tasks/${encodeURIComponent(taskId)}/report-document`);
}

export function getReportVersions(taskId: string): Promise<{ versions: ReportDocumentVersion[] }> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/report-document/versions`);
}

export function restoreReportVersion(input: {
  taskId: string;
  version: number;
  documentVersion: number;
}): Promise<{ operation: ReportOperation; document: ReportDocument }> {
  return requestJson(`/api/tasks/${encodeURIComponent(input.taskId)}/report-document/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: input.version, documentVersion: input.documentVersion }),
  });
}

export function getReportConversations(taskId: string): Promise<{
  conversations: ReportConversation[];
  operations: ReportOperation[];
}> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/report-editor/conversations`);
}

export function getCachedReportSession(taskId: string): ReportSessionData | undefined {
  return reportSessionCache.get(reportSessionKey(taskId, "document"));
}

export async function loadReportSession(taskId: string): Promise<ReportSessionData> {
  const [document, history] = await Promise.all([getReportDocument(taskId), getReportConversations(taskId)]);
  const data = { document, conversations: history.conversations, operations: history.operations };
  reportSessionCache.set(reportSessionKey(taskId, "document"), data);
  return data;
}

export function preloadReportSession(taskId: string): void {
  void loadReportSession(taskId).catch(() => undefined);
}

export function invalidateReportSession(taskId: string): void {
  for (const key of reportSessionCache.keys()) {
    if (key.startsWith(`${taskId}:`)) reportSessionCache.delete(key);
  }
}

export function sendReportMessage(input: {
  taskId: string;
  documentVersion: number;
  instruction: string;
  conversationId?: string;
  scope?: "blocks" | "document";
  blockIds?: string[];
  originalFingerprint?: string;
}): Promise<ReportEditorResponse> {
  return requestJson<ReportEditorResponse>(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: input.scope ?? "document",
      documentVersion: input.documentVersion,
      instruction: input.instruction,
      ...(input.blockIds?.length ? { blockIds: input.blockIds } : {}),
      ...(input.originalFingerprint ? { originalFingerprint: input.originalFingerprint } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    }),
  });
}

export type ReportMessageStreamEvent =
  | { type: "status"; message: string }
  | { type: "delta"; content: string };

export async function streamReportMessage(
  input: {
    taskId: string;
    documentVersion: number;
    instruction: string;
    conversationId?: string;
    scope?: "blocks" | "document";
    blockIds?: string[];
    originalFingerprint?: string;
  },
  onEvent: (event: ReportMessageStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ fallback: boolean; conversationId?: string }> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    signal,
    body: JSON.stringify({
      scope: input.scope ?? "document",
      documentVersion: input.documentVersion,
      instruction: input.instruction,
      ...(input.blockIds?.length ? { blockIds: input.blockIds } : {}),
      ...(input.originalFingerprint ? { originalFingerprint: input.originalFingerprint } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    }),
  });
  notifyAuthRequired(response);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("流式回答未返回内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fallback = false;
  let conversationId: string | undefined;
  let completed = false;
  const consume = (raw: string) => {
    const lines = raw.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!event || !data) return;
    const payload = JSON.parse(data) as { message?: unknown; content?: unknown; error?: unknown; conversationId?: unknown };
    if (event === "status" && typeof payload.message === "string") onEvent({ type: "status", message: payload.message });
    if (event === "delta" && typeof payload.content === "string") onEvent({ type: "delta", content: payload.content });
    if (event === "fallback") fallback = true;
    if (event === "done") {
      completed = true;
      conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
    }
    if (event === "error") throw new Error(typeof payload.error === "string" ? payload.error : "流式回答失败");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/u);
    buffer = events.pop() ?? "";
    events.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!fallback && !completed) throw new Error("流式回答意外结束");
  return { fallback, conversationId };
}

export function saveManualReport(input: {
  taskId: string;
  documentVersion: number;
  replacementMarkdown: string;
}): Promise<{ operation: ReportOperation; document: ReportDocument }> {
  return requestJson(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/manual-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "document",
      documentVersion: input.documentVersion,
      replacementMarkdown: input.replacementMarkdown,
    }),
  });
}

export function saveReportDraft(input: {
  taskId: string;
  documentVersion: number;
  replacementMarkdown: string;
}): Promise<{ document: ReportDocument }> {
  return requestJson(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/save-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentVersion: input.documentVersion, replacementMarkdown: input.replacementMarkdown }),
  });
}

export function saveReportVersion(input: { taskId: string; documentVersion: number }): Promise<{ document: ReportDocument }> {
  return requestJson(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/save-version`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentVersion: input.documentVersion }),
  });
}

export function discardReportDraft(input: { taskId: string; documentVersion: number }): Promise<{ document: ReportDocument }> {
  return requestJson(`/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/discard-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentVersion: input.documentVersion }),
  });
}

export function beaconReportDraft(input: { taskId: string; documentVersion: number; replacementMarkdown: string }): boolean {
  if (!navigator.sendBeacon) return false;
  return navigator.sendBeacon(
    `/api/tasks/${encodeURIComponent(input.taskId)}/report-editor/save-draft`,
    new Blob([JSON.stringify({ documentVersion: input.documentVersion, replacementMarkdown: input.replacementMarkdown })], { type: "application/json" }),
  );
}

export function applyReportOperation(taskId: string, operationId: string): Promise<{
  operation: ReportOperation;
  document: ReportDocument;
}> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/report-editor/operations/${encodeURIComponent(operationId)}/apply`, { method: "POST" });
}

function downloadFilename(contentDisposition: string | null, format: ReportExportFormat): string {
  const encodedName = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encodedName) return decodeURIComponent(encodedName);
  const plainName = contentDisposition?.match(/filename="?([^";]+)"?/iu)?.[1];
  return plainName || `think-tank-report.${format === "markdown" ? "md" : format}`;
}

export async function downloadReportExport(taskId: string, format: ReportExportFormat): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/export/${format}`);
  notifyAuthRequired(response);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `导出失败（${response.status}）`);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = downloadFilename(response.headers.get("content-disposition"), format);
  window.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function rejectReportOperation(taskId: string, operationId: string): Promise<{ operation: ReportOperation }> {
  return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/report-editor/operations/${encodeURIComponent(operationId)}/reject`, { method: "POST" });
}
