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

export interface ReportMessage {
  id: string;
  conversationId: string;
  taskId: string;
  blockId: string;
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
  blockIds: string[];
  state: "proposed" | "applied" | "rejected" | "stale";
  documentVersion: number;
  originalMarkdown: string;
  replacementMarkdown: string;
  createdAt: string;
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
  sources?: Array<{ id: string; title: string; url: string }>;
}

export type ReportEditorResponse = ReportEditorReply | ReportEditorProposal;
