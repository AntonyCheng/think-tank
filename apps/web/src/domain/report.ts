export interface ReportBlock {
  id: string;
  kind: "heading" | "paragraph" | "list" | "quote" | "code" | "table" | "rule";
  sourceStart?: number;
  sourceEnd?: number;
  markdown: string;
  text: string;
  fingerprint: string;
}

export interface ReportDocument {
  taskId: string;
  baselineMarkdown: string;
  currentMarkdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  blocks: ReportBlock[];
  isDirty: boolean;
  draftRevision: number;
  audit?: {
    status?: string;
    coverage?: number;
    warnings?: Array<{ message?: string } | string>;
  };
}

export interface ReportDocumentVersion {
  taskId: string;
  version: number;
  markdown: string;
  createdAt: string;
}

export function findReportVersionSnapshot(
  versions: ReportDocumentVersion[],
  version: number,
): ReportDocumentVersion | undefined {
  return versions.find((entry) => entry.version === version);
}

export interface ReportMessage {
  id: string;
  conversationId: string;
  taskId: string;
  blockId: string;
  operationId?: string;
  role: "user" | "assistant" | "event";
  content: string;
  documentVersion: number;
  createdAt: string;
}

export interface ReportConversation {
  id: string;
  taskId: string;
  blockId: string;
  createdAt: string;
  updatedAt: string;
  messages: ReportMessage[];
}

export interface ReportOperation {
  id: string;
  conversationId: string;
  scope: "blocks" | "document" | "text";
  placement?: "replace" | "insert_before" | "insert_after";
  blockIds: string[];
  rangeStart?: number;
  rangeEnd?: number;
  state: "proposed" | "applied" | "rejected" | "stale" | "discarded";
  documentVersion: number;
  originalMarkdown: string;
  replacementMarkdown: string;
  createdAt: string;
  appliedBlockIds?: string[];
  appliedRangeStart?: number;
  appliedRangeEnd?: number;
  structuralChange?: "unchanged" | "merge" | "split" | "insert" | "delete" | "retype" | "document";
}

export interface ReportEditorReply {
  kind: "reply";
  intent: "chat" | "research" | "clarify";
  conversation: ReportConversation;
  document: ReportDocument;
  summary: string;
  sources?: Array<{ id: string; title: string; url: string }>;
}

export interface ReportEditorProposal {
  kind: "proposal";
  intent: "edit" | "edit_with_research";
  conversation: ReportConversation;
  operation: ReportOperation;
  document: ReportDocument;
  summary: string;
  targetBlockIds?: string[];
  sources?: Array<{ id: string; title: string; url: string }>;
}

export type ReportEditorResponse = ReportEditorReply | ReportEditorProposal;
