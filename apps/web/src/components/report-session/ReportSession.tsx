import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { Button, Dropdown, Empty, message as antdMessage, Modal, Popconfirm, Tag, Tooltip } from "antd";
import { Bubble, Sender } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import "@ant-design/x-markdown/themes/light.css";
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CheckSquareOutlined,
  ClearOutlined,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  EnvironmentOutlined,
  EyeOutlined,
  HistoryOutlined,
  MessageOutlined,
  MoreOutlined,
  RollbackOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { findReportVersionSnapshot } from "../../domain/report";
import type { ReportBlock, ReportConversation, ReportDocument, ReportDocumentVersion, ReportMessage, ReportOperation } from "../../domain/report";
import {
  applyReportOperation,
  beaconReportDraft,
  downloadReportExport,
  getCachedReportSession,
  getReportVersions,
  invalidateReportSession,
  loadReportSession,
  rejectReportOperation,
  restoreReportVersion,
  discardReportDraft,
  saveReportDraft,
  saveReportVersion,
  sendReportMessage,
  streamReportMessage,
} from "../../services/report-api";
import type { ReportExportFormat } from "../../services/report-api";
import { ReportSessionLoading } from "./ReportSessionLoading";

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
interface MarkdownToken {
  type: string;
  content: string;
  children?: MarkdownToken[];
  attrs?: Array<[string, string]>;
}

const markdownParser = markdown as unknown as {
  parse: (content: string, environment: Record<string, never>) => MarkdownToken[];
};

interface ReportSessionProps {
  taskId: string;
  topic: string;
  onBackToResearch: () => void;
}

function reportMessages(conversation?: ReportConversation): ReportMessage[] {
  return conversation?.messages.filter((item) => item.role !== "event") ?? [];
}

function formatVersionTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "保存时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const starterQuestions = [
  "概括报告的核心结论",
  "检查数据口径和逻辑",
  "帮我优化执行摘要",
];

function ReportRenderer({
  blocks,
  selectedBlockIds,
  comparisonBlockIds,
  focusedBlockIds,
  selectionMode,
  onToggleBlock,
}: {
  blocks: Array<ReportBlock & { html: string; previewKind?: "replacement" | "insertion" | "deletion" | "document" }>;
  selectedBlockIds: string[];
  comparisonBlockIds: string[];
  focusedBlockIds: string[];
  selectionMode: boolean;
  onToggleBlock: (blockId: string) => void;
}) {
  return (
    <article className="report-document">
      {blocks.map((block) => {
        const selected = selectedBlockIds.includes(block.id);
        const comparing = comparisonBlockIds.includes(block.id);
        const focused = focusedBlockIds.includes(block.id);
        const previewKind = block.previewKind ?? (comparing ? "original" : undefined);
        const previewed = Boolean(previewKind);
        return (
          <div
            aria-label={selectionMode ? `选择报告内容块：${block.text.slice(0, 30)}` : undefined}
            aria-pressed={selected}
            className={`report-block ${selectionMode ? "is-selectable" : ""} ${selected ? "is-selected" : ""} ${focused ? "is-focus-target" : ""} ${previewed ? `is-preview-${previewKind}` : ""}`}
            data-report-block-id={block.id}
            key={block.id}
            onClick={() => { if (selectionMode) onToggleBlock(block.id); }}
            onKeyDown={(event) => { if (selectionMode && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggleBlock(block.id); } }}
            role={selectionMode ? "button" : undefined}
            tabIndex={selectionMode ? 0 : undefined}
          >
            {block.previewKind === "deletion"
              ? <div className="report-preview-deletion" role="status">此处内容将在应用后删除</div>
              : <div dangerouslySetInnerHTML={{ __html: block.html }} />}
          </div>
        );
      })}
    </article>
  );
}

type RenderedReportBlock = ReportBlock & {
  html: string;
  previewKind?: "replacement" | "insertion" | "deletion" | "document";
};

function proposalPreviewBlockId(operation: ReportOperation): string {
  return `preview-${operation.id}`;
}

function reportRenderBlocks(document: ReportDocument): RenderedReportBlock[] {
  return document.blocks.map((block) => ({ ...block, html: markdown.render(block.markdown) }));
}

function proposedReportRenderBlocks(document: ReportDocument, operation: ReportOperation): RenderedReportBlock[] {
  const previewId = proposalPreviewBlockId(operation);
  if (operation.scope === "document") {
    return [{
      id: previewId,
      kind: "paragraph",
      markdown: operation.replacementMarkdown,
      text: operation.replacementMarkdown,
      fingerprint: "",
      html: markdown.render(operation.replacementMarkdown),
      previewKind: "document",
    }];
  }

  const targetIds = new Set(operation.blockIds);
  const firstTargetIndex = document.blocks.findIndex((block) => targetIds.has(block.id));
  if (firstTargetIndex < 0) return reportRenderBlocks(document);
  const firstTarget = document.blocks[firstTargetIndex]!;
  const lastTargetIndex = document.blocks.reduce((lastIndex, block, index) => targetIds.has(block.id) ? index : lastIndex, firstTargetIndex);
  const replacementMarkdown = operation.scope === "text" && operation.rangeStart !== undefined && operation.rangeEnd !== undefined
    ? `${firstTarget.markdown.slice(0, operation.rangeStart)}${operation.replacementMarkdown}${firstTarget.markdown.slice(operation.rangeEnd)}`
    : operation.replacementMarkdown;
  if (operation.placement === "insert_before" || operation.placement === "insert_after") {
    const insertion: RenderedReportBlock = {
      ...firstTarget,
      id: previewId,
      kind: "paragraph",
      markdown: operation.replacementMarkdown.trim(),
      text: operation.replacementMarkdown.trim(),
      fingerprint: "",
      html: markdown.render(operation.replacementMarkdown.trim()),
      previewKind: "insertion",
    };
    const insertIndex = operation.placement === "insert_after" ? lastTargetIndex + 1 : firstTargetIndex;
    return [
      ...document.blocks.slice(0, insertIndex).map((block) => ({ ...block, html: markdown.render(block.markdown) })),
      insertion,
      ...document.blocks.slice(insertIndex).map((block) => ({ ...block, html: markdown.render(block.markdown) })),
    ];
  }
  const preview: RenderedReportBlock = {
    ...firstTarget,
    id: previewId,
    markdown: replacementMarkdown,
    text: replacementMarkdown,
    fingerprint: "",
    html: markdown.render(replacementMarkdown),
    previewKind: replacementMarkdown.trim() ? "replacement" : "deletion",
  };
  return [
    ...document.blocks.slice(0, firstTargetIndex).map((block) => ({ ...block, html: markdown.render(block.markdown) })),
    preview,
    ...document.blocks.slice(lastTargetIndex + 1).map((block) => ({ ...block, html: markdown.render(block.markdown) })),
  ];
}

function ReportDiffPreview({ operation }: { operation?: ReportOperation }) {
  if (!operation || operation.state !== "proposed") return null;
  return (
    <section className="report-diff-preview" aria-label="修改预览">
      <div className="report-diff-heading"><strong>{operation.placement === "insert_before" || operation.placement === "insert_after" ? "新增段落预览" : "修改预览"}</strong><Tag color="blue">尚未应用</Tag><span>{operation.scope === "document" ? "整篇报告" : `范围内 ${operation.blockIds.length} 段`}</span></div>
      <div className="report-diff-columns">
        <div><small>{operation.placement === "insert_before" || operation.placement === "insert_after" ? "锚点内容（保持不变）" : "当前内容"}</small><pre>{operation.originalMarkdown}</pre></div>
        <div><small>{operation.placement === "insert_before" || operation.placement === "insert_after" ? "新增内容" : "修改后"}</small><pre>{operation.replacementMarkdown}</pre></div>
      </div>
    </section>
  );
}

type VersionComparisonTarget = "draft" | "saved";
type VersionView = "diff" | "content";
type VersionDiffKind = "same" | "changed" | "added" | "removed";
interface VersionDiffPart {
  kind: "same" | "added" | "removed";
  text: string;
}
interface VersionDiffRow {
  kind: VersionDiffKind;
  before?: string;
  after?: string;
  beforeParts?: VersionDiffPart[];
  afterParts?: VersionDiffPart[];
}

function versionDiffTokens(value: string): string[] {
  return value.match(/\s+|[^\s]+/gu) ?? [];
}

function versionDiffParts(before: string, after: string): { before: VersionDiffPart[]; after: VersionDiffPart[] } {
  const left = versionDiffTokens(before);
  const right = versionDiffTokens(after);
  if (left.length > 700 || right.length > 700) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
    return {
      before: [
        ...(prefix ? [{ kind: "same", text: left.slice(0, prefix).join("") } satisfies VersionDiffPart] : []),
        ...(left.length > prefix + suffix ? [{ kind: "removed", text: left.slice(prefix, left.length - suffix).join("") } satisfies VersionDiffPart] : []),
        ...(suffix ? [{ kind: "same", text: left.slice(left.length - suffix).join("") } satisfies VersionDiffPart] : []),
      ],
      after: [
        ...(prefix ? [{ kind: "same", text: right.slice(0, prefix).join("") } satisfies VersionDiffPart] : []),
        ...(right.length > prefix + suffix ? [{ kind: "added", text: right.slice(prefix, right.length - suffix).join("") } satisfies VersionDiffPart] : []),
        ...(suffix ? [{ kind: "same", text: right.slice(right.length - suffix).join("") } satisfies VersionDiffPart] : []),
      ],
    };
  }
  const width = right.length + 1;
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(width));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(table[leftIndex + 1]![rightIndex]!, table[leftIndex]![rightIndex + 1]!);
    }
  }
  const beforeParts: VersionDiffPart[] = [];
  const afterParts: VersionDiffPart[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  const append = (parts: VersionDiffPart[], kind: VersionDiffPart["kind"], text: string) => {
    if (!text) return;
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else parts.push({ kind, text });
  };
  while (leftIndex < left.length || rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      append(beforeParts, "same", left[leftIndex] ?? "");
      append(afterParts, "same", right[rightIndex] ?? "");
      leftIndex += 1; rightIndex += 1;
    } else if (rightIndex < right.length && (leftIndex >= left.length || table[leftIndex]![rightIndex + 1]! >= table[leftIndex + 1]![rightIndex]!)) {
      append(afterParts, "added", right[rightIndex]!);
      rightIndex += 1;
    } else {
      append(beforeParts, "removed", left[leftIndex]!);
      leftIndex += 1;
    }
  }
  return { before: beforeParts, after: afterParts };
}

function versionDiffRows(beforeMarkdown: string, afterMarkdown: string): VersionDiffRow[] {
  const before = beforeMarkdown.split(/\r?\n/u);
  const after = afterMarkdown.split(/\r?\n/u);
  if (before.length > 1400 || after.length > 1400) {
    const parts = versionDiffParts(beforeMarkdown, afterMarkdown);
    return [{ kind: "changed", before: beforeMarkdown, after: afterMarkdown, beforeParts: parts.before, afterParts: parts.after }];
  }
  const width = after.length + 1;
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(width));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex]![afterIndex] = before[beforeIndex] === after[afterIndex]
        ? table[beforeIndex + 1]![afterIndex + 1]! + 1
        : Math.max(table[beforeIndex + 1]![afterIndex]!, table[beforeIndex]![afterIndex + 1]!);
    }
  }
  const raw: VersionDiffRow[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      raw.push({ kind: "same", before: before[beforeIndex], after: after[afterIndex] });
      beforeIndex += 1; afterIndex += 1;
    } else if (afterIndex < after.length && (beforeIndex >= before.length || table[beforeIndex]![afterIndex + 1]! >= table[beforeIndex + 1]![afterIndex]!)) {
      raw.push({ kind: "added", after: after[afterIndex] });
      afterIndex += 1;
    } else {
      raw.push({ kind: "removed", before: before[beforeIndex] });
      beforeIndex += 1;
    }
  }
  const rows: VersionDiffRow[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]!;
    const next = raw[index + 1];
    if (current.kind === "removed" && next?.kind === "added") {
      const parts = versionDiffParts(current.before ?? "", next.after ?? "");
      rows.push({ kind: "changed", before: current.before, after: next.after, beforeParts: parts.before, afterParts: parts.after });
      index += 1;
    } else rows.push(current);
  }
  return rows;
}

function VersionDiffText({ parts }: { parts?: VersionDiffPart[] }) {
  return <>{parts?.map((part, index) => <span className={`version-diff-part is-${part.kind}`} key={`${part.kind}-${index}`}>{part.text}</span>)}</>;
}

function ReportVersionComparison({ version, comparisonMarkdown, comparisonLabel, view }: {
  version: ReportDocumentVersion;
  comparisonMarkdown?: string;
  comparisonLabel: string;
  view: VersionView;
}) {
  if (view === "content") {
    return <section aria-label={`版本 ${version.version} 完整内容`} className="report-version-document"><XMarkdown content={version.markdown} openLinksInNewTab rootClassName="report-version-markdown x-markdown-light" /></section>;
  }
  if (comparisonMarkdown === undefined) {
    return <section aria-label={`${comparisonLabel}内容不可用`} className="report-version-diff"><Empty description={`${comparisonLabel}内容暂不可用，请重新加载版本历史`} /></section>;
  }
  const rows = versionDiffRows(comparisonMarkdown, version.markdown);
  const changedCount = rows.filter((row) => row.kind !== "same").length;
  return <section aria-label={`版本 ${version.version} 与${comparisonLabel}的差异`} className="report-version-diff">
    <div className="report-version-diff-summary"><strong>{changedCount ? `发现 ${changedCount} 处差异` : "两个版本内容一致"}</strong><span>左侧：{comparisonLabel}　右侧：版本 {version.version}</span></div>
    <div className="report-version-diff-head"><span>{comparisonLabel}</span><span>版本 {version.version}</span></div>
    <div className="report-version-diff-rows">
      {rows.map((row, index) => <div className={`report-version-diff-row is-${row.kind}`} key={`${row.kind}-${index}`}>
        <pre>{row.beforeParts ? <VersionDiffText parts={row.beforeParts} /> : row.before ?? ""}</pre>
        <pre>{row.afterParts ? <VersionDiffText parts={row.afterParts} /> : row.after ?? ""}</pre>
      </div>)}
    </div>
  </section>;
}

function renderAnswerInline(tokens: MarkdownToken[], endType?: string): { nodes: ReactNode[]; next: number } {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (endType && token.type === endType) return { nodes, next: index + 1 };
    if (token.type === "text") nodes.push(token.content);
    else if (token.type === "softbreak" || token.type === "hardbreak") nodes.push(<br key={`break-${index}`} />);
    else if (token.type === "code_inline") nodes.push(<code key={`code-${index}`}>{token.content}</code>);
    else if (token.type === "strong_open" || token.type === "em_open" || token.type === "s_open") {
      const closing = token.type.replace("_open", "_close");
      const nested = renderAnswerInline(tokens.slice(index + 1), closing);
      const key = `${token.type}-${index}`;
      nodes.push(token.type === "strong_open"
        ? <strong key={key}>{nested.nodes}</strong>
        : token.type === "em_open"
          ? <em key={key}>{nested.nodes}</em>
          : <s key={key}>{nested.nodes}</s>);
      index += nested.next;
      continue;
    } else if (token.type === "link_open") {
      const href = token.attrs?.find(([name]) => name === "href")?.[1];
      const nested = renderAnswerInline(tokens.slice(index + 1), "link_close");
      nodes.push(href
        ? <a href={href} key={`link-${index}`} rel="noreferrer" target="_blank">{nested.nodes}</a>
        : <span key={`link-${index}`}>{nested.nodes}</span>);
      index += nested.next;
      continue;
    }
    index += 1;
  }
  return { nodes, next: index };
}

function simpleOrderedList(tokens: MarkdownToken[], start: number): { items: MarkdownToken[][]; next: number } | undefined {
  const items: MarkdownToken[][] = [];
  let index = start + 1;
  while (tokens[index]?.type !== "ordered_list_close") {
    if (
      tokens[index]?.type !== "list_item_open" ||
      tokens[index + 1]?.type !== "paragraph_open" ||
      tokens[index + 2]?.type !== "inline" ||
      tokens[index + 3]?.type !== "paragraph_close" ||
      tokens[index + 4]?.type !== "list_item_close"
    ) return undefined;
    items.push(tokens[index + 2]!.children ?? []);
    index += 5;
  }
  return { items, next: index + 1 };
}

function compactAnswerBlocks(content: string): ReactNode[] | undefined {
  const tokens = markdownParser.parse(content, {});
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === "paragraph_open" && tokens[index + 1]?.type === "inline" && tokens[index + 2]?.type === "paragraph_close") {
      blocks.push(<p key={`paragraph-${index}`}>{renderAnswerInline(tokens[index + 1]!.children ?? []).nodes}</p>);
      index += 3;
      continue;
    }
    if (token.type === "ordered_list_open") {
      const list = simpleOrderedList(tokens, index);
      if (!list) return undefined;
      blocks.push(<ol className="report-answer-list" key={`list-${index}`}>
        {list.items.map((item, itemIndex) => <li key={itemIndex}>
          <span aria-hidden="true" className="report-answer-number">{itemIndex + 1}</span>
          <div>{renderAnswerInline(item).nodes}</div>
        </li>)}
      </ol>);
      index = list.next;
      continue;
    }
    return undefined;
  }
  return blocks.length ? blocks : undefined;
}

function ReportAnswer({ content }: { content: string }) {
  const blocks = compactAnswerBlocks(content);
  if (!blocks) return <XMarkdown content={content} openLinksInNewTab rootClassName="report-message-markdown x-markdown-light" />;
  return <section className="report-answer">{blocks}</section>;
}

function operationLocationLabel(operation: ReportOperation): string | undefined {
  if (operation.state === "discarded") return "修改已取消";
  if (operation.state === "proposed") {
    return operation.scope === "document" ? "查看修改范围" : "查看修改位置";
  }
  if (operation.state !== "applied") return undefined;
  if (operation.scope === "document") return "查看报告开头";
  if (operation.placement === "insert_before" || operation.placement === "insert_after") return "查看新增段落";
  if (operation.structuralChange === "delete") return "查看删除位置";
  const count = operation.appliedBlockIds?.length ?? operation.blockIds.length;
  return count > 1 ? `定位修改处（${count} 段）` : "定位修改处";
}

function ConversationMessages({
  messages,
  operations,
  activeOperationId,
  pendingInstruction,
  sending,
  streamingAnswer,
  streamStatus,
  proposal,
  onLocateOperation,
  onApply,
  onReject,
  onSuggestion,
  changingProposal,
}: {
  messages: ReportMessage[];
  operations: ReportOperation[];
  activeOperationId?: string;
  pendingInstruction: string;
  sending: boolean;
  streamingAnswer: string;
  streamStatus: string;
  proposal?: ReportOperation;
  onLocateOperation: (operation: ReportOperation) => void;
  onApply: () => void;
  onReject: () => void;
  onSuggestion: (suggestion: string) => void;
  changingProposal: boolean;
}) {
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const followLatestMessage = useRef(true);
  const latestMessageId = messages.at(-1)?.id;
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  useEffect(() => {
    const container = messageScrollRef.current;
    if (container && followLatestMessage.current) container.scrollTop = container.scrollHeight;
  }, [latestMessageId, pendingInstruction, proposal?.id, sending, streamingAnswer, streamStatus]);
  const handleMessageScroll = () => {
    const container = messageScrollRef.current;
    if (!container) return;
    followLatestMessage.current = container.scrollHeight - container.scrollTop - container.clientHeight < 32;
  };
  return (
    <div className="report-messages" onScroll={handleMessageScroll} ref={messageScrollRef}>
      {messages.length === 0 && !sending && <section className="report-empty-conversation">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从报告开始交流" />
        <div className="report-starter-questions">
          {starterQuestions.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)} type="button">{suggestion}</button>)}
        </div>
      </section>}
      {messages.map((message) => {
        const operation = message.operationId ? operationsById.get(message.operationId) : undefined;
        const locationLabel = operation ? operationLocationLabel(operation) : undefined;
        const hasOperationLocator = Boolean(operation && locationLabel);
        const locatorActive = Boolean(operation && operation.state === "applied" && activeOperationId === operation.id);
        const locatorDisabled = operation?.state === "discarded";
        return (
          <div className={`report-message-entry is-${message.role}${hasOperationLocator ? " has-operation-locator" : ""}`} key={message.id}>
            <Bubble
              _key={message.id}
              content={message.content}
              {...(message.role === "assistant"
                ? {
                    messageRender: (content: string) => <ReportAnswer content={content} />,
                  }
                : {})}
              placement={message.role === "user" ? "end" : "start"}
              variant={message.role === "user" ? "filled" : "borderless"}
            />
            {operation && locationLabel && (
              <Button
                aria-label={`定位本次修改：${locationLabel}`}
                aria-pressed={locatorActive}
                className={`report-operation-locator ${locatorActive ? "is-active" : ""} ${locatorDisabled ? "is-disabled" : ""}`}
                disabled={locatorDisabled}
                icon={<EnvironmentOutlined />}
                onClick={() => onLocateOperation(operation)}
                size="small"
                type="text"
              >
                {locationLabel}
              </Button>
            )}
          </div>
        );
      })}
      {pendingInstruction && <Bubble content={pendingInstruction} placement="end" variant="filled" />}
      {sending && streamingAnswer && <Bubble content={streamingAnswer} messageRender={(content: string) => <ReportAnswer content={content} />} placement="start" variant="borderless" />}
      {sending && !streamingAnswer && <Bubble loading content={streamStatus || "正在理解你的问题并核对报告内容"} placement="start" />}
      {proposal?.state === "proposed" && (
        <>
          <ReportDiffPreview operation={proposal} />
          <section className="proposal-card">
            <div><strong>已准备修改预览</strong><span>报告内容尚未改变</span></div>
            <div className="proposal-actions">
              <Button aria-label="放弃本次修改" className="proposal-reject-button" icon={<CloseOutlined />} disabled={changingProposal} onClick={onReject}>放弃</Button>
              <Button aria-label="应用本次修改" className="proposal-apply-button" type="primary" icon={<CheckOutlined />} loading={changingProposal} onClick={onApply}>应用修改</Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function ReportSession({ taskId, topic, onBackToResearch }: ReportSessionProps) {
  const initialSession = getCachedReportSession(taskId);
  const [document, setDocument] = useState<ReportDocument | undefined>(() => initialSession?.document);
  const [conversation, setConversation] = useState<ReportConversation | undefined>(() => initialSession ? [...initialSession.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] : undefined);
  const [proposal, setProposal] = useState<ReportOperation | undefined>(() => initialSession?.operations.find((item) => item.state === "proposed"));
  const [operations, setOperations] = useState<ReportOperation[]>(() => initialSession?.operations ?? []);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(() => !initialSession);
  const [sending, setSending] = useState(false);
  const [pendingInstruction, setPendingInstruction] = useState("");
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [changingProposal, setChangingProposal] = useState(false);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [autoTargetedBlockIds, setAutoTargetedBlockIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualDraft, setManualDraft] = useState("");
  const [error, setError] = useState("");
  const [versionHistory, setVersionHistory] = useState<ReportDocumentVersion[]>([]);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number>();
  const [draftSaving, setDraftSaving] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<ReportDocumentVersion>();
  const [versionView, setVersionView] = useState<VersionView>("diff");
  const [versionComparisonTarget, setVersionComparisonTarget] = useState<VersionComparisonTarget>("draft");
  const [proposalPreviewMode, setProposalPreviewMode] = useState<"preview" | "original">("preview");
  const [focusedBlockIds, setFocusedBlockIds] = useState<string[]>([]);
  const [activeOperationId, setActiveOperationId] = useState<string>();
  const [focusRequest, setFocusRequest] = useState(0);
  const reportScrollRef = useRef<HTMLDivElement>(null);
  const manualDraftRef = useRef(manualDraft);
  const documentRef = useRef(document);
  const [exportingFormat, setExportingFormat] = useState<ReportExportFormat>();
  const [messageApi, messageContext] = antdMessage.useMessage();

  const renderedBlocks = useMemo(() => document ? reportRenderBlocks(document) : [], [document]);
  const previewingProposal = Boolean(proposal && proposal.state === "proposed" && proposalPreviewMode === "preview" && !manualMode);
  const readerBlocks = useMemo(
    () => document && proposal && previewingProposal ? proposedReportRenderBlocks(document, proposal) : renderedBlocks,
    [document, proposal, previewingProposal, renderedBlocks],
  );
  const readerFocusedBlockIds = previewingProposal && proposal ? [proposalPreviewBlockId(proposal)] : focusedBlockIds;
  const comparisonBlockIds = proposal && proposalPreviewMode === "original" && !manualMode
    ? proposal.scope === "document" ? document?.blocks.map((block) => block.id) ?? [] : proposal.blockIds
    : [];
  const selectedBlocks = selectedBlockIds.flatMap((id) => {
    const block = document?.blocks.find((item) => item.id === id);
    return block ? [block] : [];
  });
  const selectedIndexes = selectedBlocks.map((block) => document?.blocks.findIndex((item) => item.id === block.id) ?? -1).sort((left, right) => left - right);
  const selectionIsContiguous = selectedIndexes.every((index, position) => position === 0 || index === selectedIndexes[position - 1]! + 1);
  const autoTargeted = selectedBlockIds.length > 0 && selectedBlockIds.join(",") === autoTargetedBlockIds.join(",");
  const scopeLabel = selectedBlockIds.length === 0 ? "整篇报告" : selectionIsContiguous ? `已选 ${selectedBlockIds.length} 段` : "请选择连续段落";

  const load = async (preserveConversationId?: string, focusIds?: string[]) => {
    const cached = getCachedReportSession(taskId);
    if (cached) {
      const ordered = [...cached.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextConversation = ordered.find((item) => item.id === preserveConversationId) ?? ordered[0];
      setDocument(cached.document);
      setConversation(nextConversation);
      setOperations(cached.operations);
      const nextProposal = cached.operations.find((item) => item.conversationId === nextConversation?.id && item.state === "proposed");
      setProposal(nextProposal);
      setFocusedBlockIds(focusIds ?? nextProposal?.blockIds ?? []);
      setActiveOperationId(undefined);
      setLoading(false);
    } else {
      setLoading(true);
      setConversation(undefined);
      setProposal(undefined);
      setOperations([]);
    }
    try {
      const nextSession = await loadReportSession(taskId);
      const ordered = [...nextSession.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextConversation = ordered.find((item) => item.id === preserveConversationId) ?? ordered[0];
      setDocument(nextSession.document);
      setConversation(nextConversation);
      setOperations(nextSession.operations);
      const nextProposal = nextSession.operations.find((item) => item.conversationId === nextConversation?.id && item.state === "proposed");
      setProposal(nextProposal);
      setFocusedBlockIds(focusIds ?? nextProposal?.blockIds ?? []);
      setActiveOperationId(undefined);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "报告加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [taskId]);

  useEffect(() => { setProposalPreviewMode("preview"); }, [proposal?.id]);

  const focusReportBlocks = (blockIds: string[]) => {
    setFocusedBlockIds(blockIds);
    setFocusRequest((current) => current + 1);
  };

  const resetReportLocation = () => {
    setActiveOperationId(undefined);
    setFocusedBlockIds([]);
    setFocusRequest((current) => current + 1);
  };

  useEffect(() => {
    const container = reportScrollRef.current;
    if (!container || !readerFocusedBlockIds.length) return;
    const target = container.querySelector<HTMLElement>(`[data-report-block-id="${CSS.escape(readerFocusedBlockIds[0]!)}"]`);
    if (!target) return;
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [readerFocusedBlockIds.join(","), document?.version, focusRequest]);

  const locateOperation = (operation: ReportOperation) => {
    if (!document) return;
    if (operation.state === "proposed") {
      setProposalPreviewMode("preview");
      setFocusRequest((current) => current + 1);
      return;
    }
    if (activeOperationId === operation.id) {
      setActiveOperationId(undefined);
      setFocusedBlockIds([]);
      setFocusRequest((current) => current + 1);
      return;
    }
    if (operation.scope === "document") {
      setActiveOperationId(operation.id);
      setFocusedBlockIds([]);
      requestAnimationFrame(() => reportScrollRef.current?.scrollTo({ behavior: "smooth", top: 0 }));
      return;
    }
    const requestedIds = operation.state === "applied"
      ? operation.appliedBlockIds ?? operation.blockIds
      : operation.blockIds;
    const currentBlockIds = requestedIds.filter((id) => document.blocks.some((block) => block.id === id));
    if (currentBlockIds.length) {
      setActiveOperationId(operation.id);
      focusReportBlocks(currentBlockIds);
      return;
    }
    const anchor = operation.appliedRangeStart ?? 0;
    const nearbyBlock = document.blocks.find((block) => block.sourceStart !== undefined && block.sourceStart >= anchor)
      ?? document.blocks.at(-1);
    if (nearbyBlock) {
      setActiveOperationId(operation.id);
      focusReportBlocks([nearbyBlock.id]);
      messageApi.info("原内容已发生后续变化，已定位到附近位置。");
      return;
    }
    messageApi.warning("当前报告中已找不到可定位的内容。");
  };

  const toggleBlock = (blockId: string) => {
    setActiveOperationId(undefined);
    setFocusedBlockIds([]);
    setAutoTargetedBlockIds([]);
    setSelectedBlockIds((current) => current.includes(blockId)
      ? current.filter((id) => id !== blockId)
      : [...current, blockId].sort((left, right) => (document?.blocks.findIndex((item) => item.id === left) ?? 0) - (document?.blocks.findIndex((item) => item.id === right) ?? 0)));
  };

  const send = async (message: string) => {
    const instruction = message.trim();
    if (!instruction || !document || sending || (selectedBlockIds.length > 0 && !selectionIsContiguous)) return;
    setInput(""); setPendingInstruction(instruction); setSending(true); setStreamingAnswer(""); setStreamStatus("正在理解你的问题"); setError("");
    const request = {
      taskId,
      documentVersion: document.version,
      instruction,
      conversationId: conversation?.id,
      scope: selectedBlockIds.length ? "blocks" as const : "document" as const,
      ...(selectedBlockIds.length ? { blockIds: selectedBlockIds } : {}),
      ...(selectedBlockIds.length === 1 ? { originalFingerprint: selectedBlocks[0]?.fingerprint } : {}),
    };
    try {
      const response = await streamReportMessage(request, (event) => {
        if (event.type === "status") setStreamStatus(event.message);
        else setStreamingAnswer((current) => current + event.content);
      });
      if (response.fallback) {
        setStreamingAnswer("");
        setStreamStatus("正在准备修改预览");
        const fallback = await sendReportMessage(request);
        const targetBlockIds = fallback.kind === "proposal" ? fallback.targetBlockIds : undefined;
        if (targetBlockIds?.length) {
          setSelectedBlockIds(targetBlockIds);
          setAutoTargetedBlockIds(targetBlockIds);
        }
        invalidateReportSession(taskId);
        await load(fallback.conversation.id, targetBlockIds);
      } else {
        invalidateReportSession(taskId);
        await load(response.conversationId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "消息发送失败");
      setInput(instruction);
    } finally {
      setSending(false); setPendingInstruction(""); setStreamingAnswer(""); setStreamStatus("");
    }
  };

  const startManualEdit = () => {
    if (!document) return;
    setManualDraft(document.currentMarkdown);
    setManualMode(true);
  };

  const exitManualEdit = () => {
    setManualMode(false);
    setManualDraft("");
  };

  const manualIsDirty = manualMode && manualDraft !== document?.currentMarkdown;
  const hasDraft = Boolean(document?.isDirty);
  const currentVersionSnapshot = document ? findReportVersionSnapshot(versionHistory, document.version) : undefined;
  const comparingDraft = hasDraft && versionComparisonTarget === "draft";
  const currentVersionLabel = document ? `当前版本（版本 ${document.version}）` : "当前版本";
  manualDraftRef.current = manualDraft;
  documentRef.current = document;

  const persistDraft = async (replacementMarkdown: string, expectedVersion: number) => {
    setDraftSaving(true);
    try {
      const result = await saveReportDraft({ taskId, documentVersion: expectedVersion, replacementMarkdown });
      setDocument((current) => current?.version === expectedVersion ? result.document : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂存修改失败");
    } finally {
      setDraftSaving(false);
    }
  };

  useEffect(() => {
    if (!manualMode || !document || manualDraft === document.currentMarkdown) return;
    const timer = window.setTimeout(() => void persistDraft(manualDraft, document.version), 700);
    return () => window.clearTimeout(timer);
  }, [manualDraft, manualMode]);

  useEffect(() => {
    const handlePageHide = () => {
      const currentDocument = documentRef.current;
      const currentDraft = manualDraftRef.current;
      if (!manualMode || !currentDocument || currentDraft === currentDocument.currentMarkdown) return;
      beaconReportDraft({ taskId, documentVersion: currentDocument.version, replacementMarkdown: currentDraft });
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [manualMode, taskId]);

  const exportReport = async (format: ReportExportFormat) => {
    if (manualIsDirty || exportingFormat) return;
    setExportingFormat(format);
    setError("");
    try {
      await downloadReportExport(taskId, format);
      messageApi.success(`已开始导出 ${format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Markdown"} 文件。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "报告导出失败");
    } finally {
      setExportingFormat(undefined);
    }
  };

  const saveManualEdit = async () => {
    if (!document) return;
    setChangingProposal(true); setError("");
    try {
      const staged = manualDraft !== document.currentMarkdown
        ? await saveReportDraft({ taskId, documentVersion: document.version, replacementMarkdown: manualDraft })
        : { document };
      const result = await saveReportVersion({ taskId, documentVersion: staged.document.version });
      setDocument(result.document);
      setManualMode(false);
      setManualDraft("");
      invalidateReportSession(taskId);
      await load(conversation?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存手动修改失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const saveVersion = async () => {
    if (!document || !hasDraft) return;
    setChangingProposal(true); setError("");
    try {
      const result = await saveReportVersion({ taskId, documentVersion: document.version });
      setDocument(result.document);
      invalidateReportSession(taskId);
      await load(conversation?.id);
      messageApi.success(`已保存为版本 ${result.document.version}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存版本失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const discardDraft = async () => {
    if (!document || !hasDraft) return;
    setChangingProposal(true); setError("");
    try {
      const result = await discardReportDraft({ taskId, documentVersion: document.version });
      setDocument(result.document);
      setManualMode(false);
      setManualDraft("");
      setSelectedBlockIds([]);
      invalidateReportSession(taskId);
      await load(conversation?.id);
      messageApi.success("已放弃未保存修改。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "放弃暂存修改失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const leaveReport = () => {
    if (manualMode && document && manualDraft !== document.currentMarkdown) {
      void persistDraft(manualDraft, document.version).finally(onBackToResearch);
      return;
    }
    onBackToResearch();
  };

  const apply = async () => {
    if (!proposal) return;
    setChangingProposal(true); setError("");
    try {
      const result = await applyReportOperation(taskId, proposal.id);
      const originalIndex = document?.blocks.findIndex((block) => block.id === proposal.blockIds[0]) ?? -1;
      const fallbackFocusId = result.document.blocks[Math.min(Math.max(originalIndex, 0), Math.max(result.document.blocks.length - 1, 0))]?.id;
      const appliedFocusIds = proposal.scope === "document"
        ? []
        : result.operation.appliedBlockIds?.length
          ? result.operation.appliedBlockIds
          : fallbackFocusId ? [fallbackFocusId] : [];
      setDocument(result.document);
      setProposal(undefined);
      setFocusedBlockIds(appliedFocusIds);
      setSelectedBlockIds(appliedFocusIds);
      setAutoTargetedBlockIds([]);
      invalidateReportSession(taskId);
      await load(conversation?.id, appliedFocusIds);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "应用修改失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const reject = async () => {
    if (!proposal) return;
    setChangingProposal(true); setError("");
    try {
      await rejectReportOperation(taskId, proposal.id);
      setProposal(undefined);
      resetReportLocation();
      setProposalPreviewMode("preview");
      invalidateReportSession(taskId);
      await load(conversation?.id);
      messageApi.success("已取消本次修改，报告内容未改变。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "放弃修改失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const loadVersionHistory = async () => {
    const currentDocument = document;
    if (!currentDocument) return;
    setVersionsLoading(true);
    try {
      const response = await getReportVersions(taskId);
      setVersionHistory(response.versions);
      setSelectedVersion((current) => current && response.versions.some((entry) => entry.version === current.version)
        ? response.versions.find((entry) => entry.version === current.version)
        : response.versions.filter((entry) => entry.version < currentDocument.version).at(-1)
          ?? response.versions.find((entry) => entry.version === currentDocument.version)
          ?? response.versions[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "版本历史加载失败");
    } finally {
      setVersionsLoading(false);
    }
  };

  const restore = async (version: number) => {
    if (!document || version === document.version) return;
    setRestoringVersion(version);
    setError("");
    try {
      const result = await restoreReportVersion({ taskId, version, documentVersion: document.version });
      setDocument(result.document);
      setSelectedBlockIds([]);
      setManualMode(false);
      setManualDraft("");
      setSelectedVersion(undefined);
      invalidateReportSession(taskId);
      await Promise.all([load(conversation?.id), loadVersionHistory()]);
      messageApi.success(`已将版本 ${version} 恢复为暂存修改。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复报告版本失败");
    } finally {
      setRestoringVersion(undefined);
    }
  };

  if (loading && !document) {
    return <ReportSessionLoading />;
  }
  if (!document) {
    return <main className="report-session-loading"><Empty description={error || "未找到报告内容"} /><Button onClick={onBackToResearch}>返回研究过程</Button></main>;
  }

  const messages = reportMessages(conversation);
  return (
    <main className="report-session-shell">
      {messageContext}
      <header className="report-session-header">
        <button className="report-back-button" onClick={leaveReport} type="button"><ArrowLeftOutlined />研究过程</button>
        <div className="report-session-label">报告编辑</div>
      </header>
      <div className="report-session-layout">
        <section className="report-chat-pane">
          <div className="report-chat-heading">
            <div><span>AI 对话</span><h1>和报告继续交流</h1></div>
            <Tooltip title="AI 会根据问题自动判断是否需要补充检索"><MessageOutlined /></Tooltip>
          </div>
          <ConversationMessages activeOperationId={activeOperationId} messages={messages} operations={operations} pendingInstruction={pendingInstruction} sending={sending} streamingAnswer={streamingAnswer} streamStatus={streamStatus} proposal={proposal} onApply={() => void apply()} onReject={() => void reject()} onSuggestion={setInput} onLocateOperation={locateOperation} changingProposal={changingProposal} />
          {error && <p className="report-chat-error">{error}</p>}
          <section className="report-composer"><Sender value={input} onChange={setInput} onSubmit={send} loading={sending} disabled={changingProposal || loading || !selectionIsContiguous} placeholder="输入问题或修改要求" prefix={<span className="composer-scope">{scopeLabel}</span>} /></section>
        </section>
        <section className="report-reader-pane">
          <header>
            <div><span>研究报告</span><strong>{topic}</strong></div>
            <div aria-label="报告操作" className="report-reader-tools" role="toolbar">
              <div className="report-tool-grid">
                <div className="report-tool-cell report-version-tools">
                  <>
                    <Button
                      aria-label="打开版本管理"
                      className="report-version-button report-export-button"
                      icon={<HistoryOutlined />}
                      onClick={() => { setVersionHistoryOpen(true); void loadVersionHistory(); }}
                      size="small"
                    >版本管理</Button>
                    <Modal
                      centered
                      className="report-version-modal"
                      footer={null}
                      onCancel={() => setVersionHistoryOpen(false)}
                      open={versionHistoryOpen}
                      title="版本管理"
                      width={1120}
                    >
                      <div className="report-version-workspace">
                        <aside aria-label="报告版本列表" className="report-version-sidebar">
                          <div className="report-version-sidebar-heading"><strong>历史版本</strong><small>{versionHistory.length} 个版本</small></div>
                          {versionsLoading
                            ? <span className="report-version-history-loading">正在加载版本历史</span>
                            : versionHistory.map((entry) => <div className={`report-version-entry ${selectedVersion?.version === entry.version ? "is-selected" : ""}`} key={entry.version}>
                              <button className="report-version-select" onClick={() => setSelectedVersion(entry)} type="button">
                                <strong>版本 {entry.version}</strong>
                                <small>{formatVersionTime(entry.createdAt)}</small>
                              </button>
                              <div className="report-version-actions">
                                {entry.version === document.version && <Tag bordered={false} color="green">当前</Tag>}
                                {entry.version !== document.version && <Popconfirm
                                  cancelText="取消"
                                  description={`将以版本 ${entry.version} 的内容覆盖当前暂存稿，正式版本不会立即增加。`}
                                  okText="恢复"
                                  onConfirm={() => void restore(entry.version)}
                                  title={`恢复版本 ${entry.version}？`}
                                >
                                  <Button aria-label={`恢复版本 ${entry.version}`} icon={<RollbackOutlined />} loading={restoringVersion === entry.version} size="small" type="text" />
                                </Popconfirm>}
                              </div>
                            </div>)}
                        </aside>
                        <section className="report-version-main">
                          {selectedVersion ? <>
                            <div className="report-version-main-heading">
                              <div><strong>版本 {selectedVersion.version}</strong><small>{formatVersionTime(selectedVersion.createdAt)} · {selectedVersion.markdown.length.toLocaleString()} 个字符</small></div>
                              <div className="report-version-view-tabs" role="tablist">
                                <Button aria-selected={versionView === "diff"} className={versionView === "diff" ? "is-active" : ""} onClick={() => setVersionView("diff")} role="tab" size="small">差异对比</Button>
                                <Button aria-selected={versionView === "content"} className={versionView === "content" ? "is-active" : ""} onClick={() => setVersionView("content")} role="tab" size="small">完整内容</Button>
                              </div>
                            </div>
                            <div className="report-version-comparison-target" role="group" aria-label="选择对比基准">
                              <span>对比基准</span>
                              {hasDraft && <Button aria-pressed={comparingDraft} className={comparingDraft ? "is-active" : ""} onClick={() => setVersionComparisonTarget("draft")} size="small">当前暂存稿</Button>}
                              <Button aria-pressed={!comparingDraft} className={!comparingDraft ? "is-active" : ""} onClick={() => setVersionComparisonTarget("saved")} size="small">{currentVersionLabel}</Button>
                            </div>
                            <ReportVersionComparison
                              comparisonLabel={comparingDraft ? "当前暂存稿" : currentVersionLabel}
                              comparisonMarkdown={comparingDraft ? document.currentMarkdown : currentVersionSnapshot?.markdown}
                              version={selectedVersion}
                              view={versionView}
                            />
                          </> : <Empty description="请选择一个版本" />}
                        </section>
                      </div>
                    </Modal>
                  </>
                </div>
                <div className="report-tool-cell report-selection-tools">
                  <Button
                    aria-pressed={selectionMode}
                    className={`report-selection-toggle ${selectionMode ? "is-active" : ""}`}
                    icon={<CheckSquareOutlined />}
                    onClick={() => {
                      setSelectionMode((current) => !current);
                      setActiveOperationId(undefined);
                      setFocusedBlockIds([]);
                    }}
                    size="small"
                  >
                    {selectionMode ? "结束选段" : "选择段落"}
                  </Button>
                </div>
                <div className="report-tool-cell report-export-tools">
                  <Dropdown
                disabled={manualIsDirty || Boolean(exportingFormat) || draftSaving}
                menu={{
                  items: [
                    { key: "docx", label: "导出 Word (.docx)", disabled: Boolean(exportingFormat), },
                    { key: "pdf", label: "导出 PDF (.pdf)", disabled: Boolean(exportingFormat), },
                    { key: "markdown", label: "导出 Markdown (.md)", disabled: Boolean(exportingFormat), },
                  ],
                  onClick: ({ key }) => void exportReport(key as ReportExportFormat),
                }}
                placement="bottomRight"
                trigger={["click"]}
                  >
                    <Button aria-label="导出当前版本" className="report-export-button" icon={<DownloadOutlined />} loading={Boolean(exportingFormat)} size="small">导出文件</Button>
                  </Dropdown>
                </div>
                <div className="report-tool-cell report-manual-tools">
                  <Button className="manual-edit-button" icon={<EditOutlined />} onClick={startManualEdit} size="small">手动编辑</Button>
                </div>
              </div>
            </div>
          </header>
          {hasDraft && <section className="report-draft-status-bar" aria-label="报告暂存状态">
            <div className="report-draft-status-copy">
              <Tag bordered={false} color="orange">暂存稿</Tag>
              <span>有未保存修改</span>
              <small>正式版本未增加</small>
            </div>
            <div className="report-draft-status-actions">
              <Button disabled={changingProposal || draftSaving} icon={<SaveOutlined />} loading={changingProposal} onClick={() => void saveVersion()} size="small" type="primary">保存版本</Button>
              <Dropdown
                menu={{
                  items: [{ key: "discard", label: "放弃暂存" }],
                  onClick: ({ key }) => {
                    if (key !== "discard") return;
                    void discardDraft();
                  },
                }}
                placement="bottomRight"
                trigger={["click"]}
              >
                <Button aria-label="更多暂存操作" disabled={changingProposal || draftSaving} icon={<MoreOutlined />} size="small" />
              </Dropdown>
            </div>
          </section>}
          {proposal?.state === "proposed" && !manualMode && <section className="report-pending-preview-bar" aria-label="报告修改预览状态">
            <div>
              <span>修改预览</span>
              <small>报告尚未改变</small>
            </div>
            <div aria-label="修改预览视图" className="report-preview-toggle" role="group">
              <Button aria-pressed={proposalPreviewMode === "preview"} className={proposalPreviewMode === "preview" ? "is-active" : ""} icon={<EyeOutlined />} onClick={() => setProposalPreviewMode("preview")} size="small">预览修改</Button>
              <Button aria-pressed={proposalPreviewMode === "original"} className={proposalPreviewMode === "original" ? "is-active" : ""} onClick={() => setProposalPreviewMode("original")} size="small">查看原文</Button>
            </div>
          </section>}
          {selectedBlockIds.length > 0 && <div className={`report-selection-strip ${selectionIsContiguous ? "" : "is-invalid"}`}>
            <div className="report-selection-copy">
              <span>{scopeLabel}</span>
              <small>{selectionIsContiguous ? autoTargeted ? "已根据你的描述定位到此处，左侧输入将只作用于该内容" : "左侧输入将只作用于选中的连续内容块" : "选中的内容必须连续，请取消其中一段"}</small>
            </div>
            <Button className="report-selection-clear" icon={<ClearOutlined />} onClick={() => { setSelectedBlockIds([]); setAutoTargetedBlockIds([]); }} size="small">清除 {selectedBlockIds.length} 段</Button>
          </div>}
          <div className="report-reader-scroll" ref={reportScrollRef}>
            {manualMode ? <section className="manual-editor-panel"><div className="manual-editor-toolbar"><strong>手动编辑整篇报告</strong>{manualIsDirty || hasDraft ? <span className="manual-draft-status">有未保存修改</span> : <span>内容已保存</span>}<div>{manualIsDirty ? <Popconfirm cancelText="继续编辑" description="当前文字会保留在暂存稿中。" okText="退出编辑" onConfirm={exitManualEdit} title="退出手动编辑？"><Button danger disabled={changingProposal}>取消</Button></Popconfirm> : <Button disabled={changingProposal} onClick={exitManualEdit}>取消</Button>}<Button disabled={!manualIsDirty && !hasDraft} type="primary" icon={<SaveOutlined />} loading={changingProposal} onClick={() => void saveManualEdit()}>保存版本</Button></div></div><textarea className="manual-report-textarea" value={manualDraft} onChange={(event) => setManualDraft(event.target.value)} /></section> : <ReportRenderer blocks={readerBlocks} comparisonBlockIds={comparisonBlockIds} focusedBlockIds={readerFocusedBlockIds} selectedBlockIds={selectedBlockIds} selectionMode={selectionMode && !previewingProposal} onToggleBlock={toggleBlock} />}
          </div>
        </section>
      </div>
    </main>
  );
}
