import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { Button, Dropdown, Empty, message as antdMessage, Popconfirm, Popover, Tag, Tooltip } from "antd";
import { Bubble, Conversations, Sender } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import "@ant-design/x-markdown/themes/light.css";
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CheckSquareOutlined,
  ClearOutlined,
  CloseOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  MessageOutlined,
  RollbackOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { ReportBlock, ReportConversation, ReportDocument, ReportDocumentVersion, ReportMessage, ReportOperation } from "../../domain/report";
import {
  applyReportOperation,
  downloadReportExport,
  getCachedReportSession,
  getReportVersions,
  invalidateReportSession,
  loadReportSession,
  rejectReportOperation,
  restoreReportVersion,
  saveManualReport,
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
  selectionMode,
  onToggleBlock,
}: {
  blocks: Array<ReportBlock & { html: string }>;
  selectedBlockIds: string[];
  selectionMode: boolean;
  onToggleBlock: (blockId: string) => void;
}) {
  return (
    <article className="report-document">
      {blocks.map((block) => {
        const selected = selectedBlockIds.includes(block.id);
        return (
          <div
            aria-label={selectionMode ? `选择报告内容块：${block.text.slice(0, 30)}` : undefined}
            aria-pressed={selected}
            className={`report-block ${selectionMode ? "is-selectable" : ""} ${selected ? "is-selected" : ""}`}
            key={block.id}
            onClick={() => { if (selectionMode) onToggleBlock(block.id); }}
            onKeyDown={(event) => { if (selectionMode && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggleBlock(block.id); } }}
            role={selectionMode ? "button" : undefined}
            tabIndex={selectionMode ? 0 : undefined}
          >
            <div dangerouslySetInnerHTML={{ __html: block.html }} />
          </div>
        );
      })}
    </article>
  );
}

function ReportDiffPreview({ operation }: { operation?: ReportOperation }) {
  if (!operation || operation.state !== "proposed") return null;
  return (
    <section className="report-diff-preview" aria-label="修改预览">
      <div className="report-diff-heading"><strong>修改预览</strong><Tag color="blue">尚未应用</Tag><span>{operation.scope === "document" ? "整篇报告" : `范围内 ${operation.blockIds.length} 段`}</span></div>
      <div className="report-diff-columns">
        <div><small>当前内容</small><pre>{operation.originalMarkdown}</pre></div>
        <div><small>修改后</small><pre>{operation.replacementMarkdown}</pre></div>
      </div>
    </section>
  );
}

function reportPreviewExcerpt(markdown: string): string {
  return markdown.replace(/[#*_`>|\-]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
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

function ConversationMessages({
  messages,
  pendingInstruction,
  sending,
  streamingAnswer,
  streamStatus,
  proposal,
  onApply,
  onReject,
  onSuggestion,
  changingProposal,
}: {
  messages: ReportMessage[];
  pendingInstruction: string;
  sending: boolean;
  streamingAnswer: string;
  streamStatus: string;
  proposal?: ReportOperation;
  onApply: () => void;
  onReject: () => void;
  onSuggestion: (suggestion: string) => void;
  changingProposal: boolean;
}) {
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const followLatestMessage = useRef(true);
  const latestMessageId = messages.at(-1)?.id;
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
      {messages.map((message) => (
        <Bubble
          _key={message.id}
          content={message.content}
          key={message.id}
          {...(message.role === "assistant"
            ? {
                messageRender: (content: string) => <ReportAnswer content={content} />,
              }
            : {})}
          placement={message.role === "user" ? "end" : "start"}
          variant={message.role === "user" ? "filled" : "borderless"}
        />
      ))}
      {pendingInstruction && <Bubble content={pendingInstruction} placement="end" variant="filled" />}
      {sending && streamingAnswer && <Bubble content={streamingAnswer} messageRender={(content: string) => <ReportAnswer content={content} />} placement="start" variant="borderless" />}
      {sending && !streamingAnswer && <Bubble loading content={streamStatus || "正在理解你的问题并核对报告内容"} placement="start" />}
      {proposal?.state === "proposed" && (
        <section className="proposal-card">
          <div><strong>已准备修改预览</strong><span>报告内容尚未改变</span></div>
          <div className="proposal-actions">
            <Button icon={<CloseOutlined />} disabled={changingProposal} onClick={onReject}>放弃</Button>
            <Button type="primary" icon={<CheckOutlined />} loading={changingProposal} onClick={onApply}>应用修改</Button>
          </div>
        </section>
      )}
    </div>
  );
}

export function ReportSession({ taskId, topic, onBackToResearch }: ReportSessionProps) {
  const initialSession = getCachedReportSession(taskId);
  const [document, setDocument] = useState<ReportDocument | undefined>(() => initialSession?.document);
  const [conversation, setConversation] = useState<ReportConversation | undefined>(() => initialSession ? [...initialSession.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] : undefined);
  const [proposal, setProposal] = useState<ReportOperation | undefined>(() => initialSession?.operations.find((item) => item.state === "proposed"));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(() => !initialSession);
  const [sending, setSending] = useState(false);
  const [pendingInstruction, setPendingInstruction] = useState("");
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [changingProposal, setChangingProposal] = useState(false);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualDraft, setManualDraft] = useState("");
  const [error, setError] = useState("");
  const [versionHistory, setVersionHistory] = useState<ReportDocumentVersion[]>([]);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number>();
  const [previewVersion, setPreviewVersion] = useState<ReportDocumentVersion>();
  const [exportingFormat, setExportingFormat] = useState<ReportExportFormat>();
  const [messageApi, messageContext] = antdMessage.useMessage();

  const scopeKey = selectedBlockIds.length ? selectedBlockIds.join(",") : "document";
  const renderedBlocks = useMemo(
    () => document?.blocks.map((block) => ({ ...block, html: markdown.render(block.markdown) })) ?? [],
    [document],
  );
  const selectedBlocks = selectedBlockIds.flatMap((id) => {
    const block = document?.blocks.find((item) => item.id === id);
    return block ? [block] : [];
  });
  const selectedIndexes = selectedBlocks.map((block) => document?.blocks.findIndex((item) => item.id === block.id) ?? -1).sort((left, right) => left - right);
  const selectionIsContiguous = selectedIndexes.every((index, position) => position === 0 || index === selectedIndexes[position - 1]! + 1);
  const scopeLabel = selectedBlockIds.length === 0 ? "整篇报告" : selectionIsContiguous ? `已选 ${selectedBlockIds.length} 段` : "请选择连续段落";

  const load = async (preserveConversationId?: string) => {
    const cached = getCachedReportSession(taskId, scopeKey);
    if (cached) {
      const ordered = [...cached.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextConversation = ordered.find((item) => item.id === preserveConversationId) ?? ordered[0];
      setDocument(cached.document);
      setConversation(nextConversation);
      setProposal(cached.operations.find((item) => item.conversationId === nextConversation?.id && item.state === "proposed"));
      setLoading(false);
    } else {
      setLoading(true);
      setConversation(undefined);
      setProposal(undefined);
    }
    try {
      const nextSession = await loadReportSession(taskId, scopeKey);
      const ordered = [...nextSession.conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextConversation = ordered.find((item) => item.id === preserveConversationId) ?? ordered[0];
      setDocument(nextSession.document);
      setConversation(nextConversation);
      setProposal(nextSession.operations.find((item) => item.conversationId === nextConversation?.id && item.state === "proposed"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "报告加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [taskId, scopeKey]);

  const toggleBlock = (blockId: string) => {
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
        invalidateReportSession(taskId);
        await load(fallback.conversation.id);
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
      const result = await saveManualReport({ taskId, documentVersion: document.version, replacementMarkdown: manualDraft });
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

  const apply = async () => {
    if (!proposal) return;
    setChangingProposal(true); setError("");
    try {
      const result = await applyReportOperation(taskId, proposal.id);
      setDocument(result.document);
      setProposal(undefined);
      invalidateReportSession(taskId);
      await load(conversation?.id);
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
      invalidateReportSession(taskId);
      await load(conversation?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "放弃修改失败");
    } finally {
      setChangingProposal(false);
    }
  };

  const loadVersionHistory = async () => {
    setVersionsLoading(true);
    try {
      const response = await getReportVersions(taskId);
      setVersionHistory(response.versions);
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
      invalidateReportSession(taskId);
      await Promise.all([load(conversation?.id), loadVersionHistory()]);
      messageApi.success(`已恢复版本 ${version}，并创建新的当前版本。`);
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
        <button className="report-back-button" onClick={onBackToResearch} type="button"><ArrowLeftOutlined />研究过程</button>
        <div className="report-session-label">报告编辑</div>
      </header>
      <div className="report-session-layout">
        <section className="report-chat-pane">
          <div className="report-chat-heading">
            <div><span>AI 对话</span><h1>和报告继续交流</h1></div>
            <Tooltip title="AI 会根据问题自动判断是否需要补充检索"><MessageOutlined /></Tooltip>
          </div>
          <Conversations className="report-conversation-tabs" items={[{ key: "document", label: "报告对话", icon: <MessageOutlined /> }]} activeKey="document" />
          <ConversationMessages messages={messages} pendingInstruction={pendingInstruction} sending={sending} streamingAnswer={streamingAnswer} streamStatus={streamStatus} proposal={proposal} onApply={() => void apply()} onReject={() => void reject()} onSuggestion={setInput} changingProposal={changingProposal} />
          {error && <p className="report-chat-error">{error}</p>}
          <section className="report-composer"><Sender value={input} onChange={setInput} onSubmit={send} loading={sending} disabled={changingProposal || loading || !selectionIsContiguous} placeholder="询问报告，补充资料，或说明你想调整的内容" prefix={<span className="composer-scope">{scopeLabel}</span>} /></section>
        </section>
        <section className="report-reader-pane">
          <header>
            <div><span>研究报告</span><strong>{topic}</strong></div>
            <div aria-label="报告操作" className="report-reader-tools" role="toolbar">
              <Popover
                arrow={false}
                content={<div className="report-version-history">
                  {previewVersion && <section className="report-version-preview">
                    <div><strong>版本 {previewVersion.version}</strong><Button onClick={() => setPreviewVersion(undefined)} size="small" type="text">收起</Button></div>
                    <p>{reportPreviewExcerpt(previewVersion.markdown) || "该版本没有可预览的正文。"}</p>
                    <small>共 {previewVersion.markdown.length.toLocaleString()} 个字符，相较当前版本 {previewVersion.markdown.length - document.currentMarkdown.length >= 0 ? "+" : ""}{(previewVersion.markdown.length - document.currentMarkdown.length).toLocaleString()} 个字符</small>
                  </section>}
                  {versionsLoading
                    ? <span className="report-version-history-loading">正在加载版本历史</span>
                    : versionHistory.map((entry) => <div className="report-version-entry" key={entry.version}>
                      <div><strong>版本 {entry.version}</strong><small>{formatVersionTime(entry.createdAt)}</small></div>
                      {entry.version === document.version
                        ? <Tag bordered={false} color="green">当前</Tag>
                        : <div className="report-version-actions"><Button onClick={() => setPreviewVersion(entry)} size="small" type="text">预览</Button><Popconfirm
                            cancelText="取消"
                            description={`将以版本 ${entry.version} 的内容创建一个新版本，当前内容不会丢失。`}
                            okText="恢复"
                            onConfirm={() => void restore(entry.version)}
                            title={`恢复版本 ${entry.version}？`}
                          >
                            <Button icon={<RollbackOutlined />} loading={restoringVersion === entry.version} size="small">恢复</Button>
                          </Popconfirm></div>}
                    </div>)}
                </div>}
                onOpenChange={(open) => { setVersionHistoryOpen(open); if (open) void loadVersionHistory(); else setPreviewVersion(undefined); }}
                open={versionHistoryOpen}
                overlayClassName="report-version-popover"
                placement="bottomRight"
                trigger="click"
              >
                <button className="report-version-badge" type="button"><HistoryOutlined />版本 {document.version}<DownOutlined /></button>
              </Popover>
              <Dropdown
                disabled={manualIsDirty || Boolean(exportingFormat)}
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
                <Tooltip title={manualIsDirty ? "请先保存或放弃手动编辑后再导出" : exportingFormat ? "正在生成导出文件" : "导出当前版本"}>
                  <Button aria-label="导出当前版本" className="report-export-button" icon={<DownloadOutlined />} loading={Boolean(exportingFormat)} size="small" />
                </Tooltip>
              </Dropdown>
              <span aria-hidden="true" className="report-tools-divider" />
              <div className="report-selection-tools">
                <Button
                  aria-pressed={selectionMode}
                  className={`report-selection-toggle ${selectionMode ? "is-active" : ""}`}
                  icon={<CheckSquareOutlined />}
                  onClick={() => setSelectionMode((current) => !current)}
                  size="small"
                >
                  {selectionMode ? "结束选段" : "选择段落"}
                </Button>
                {selectedBlockIds.length > 0 && <Button icon={<ClearOutlined />} onClick={() => setSelectedBlockIds([])} size="small">清除 {selectedBlockIds.length} 段</Button>}
              </div>
              <Button className="manual-edit-button" icon={<EditOutlined />} onClick={startManualEdit} size="small">手动编辑</Button>
            </div>
          </header>
          {selectedBlockIds.length > 0 && <div className={`report-selection-strip ${selectionIsContiguous ? "" : "is-invalid"}`}><span>{scopeLabel}</span><small>{selectionIsContiguous ? "左侧输入将只作用于选中的连续内容块" : "选中的内容必须连续，请取消其中一段"}</small></div>}
          <div className="report-reader-scroll">
            <ReportDiffPreview operation={proposal} />
            {manualMode ? <section className="manual-editor-panel"><div className="manual-editor-toolbar"><strong>手动编辑整篇报告</strong>{manualIsDirty ? <span className="manual-draft-status">有未保存修改</span> : <span>内容已保存</span>}<div>{manualIsDirty ? <Popconfirm cancelText="继续编辑" description="未保存的修改将被丢弃。" okText="放弃修改" onConfirm={exitManualEdit} title="放弃未保存的修改？"><Button danger disabled={changingProposal}>取消</Button></Popconfirm> : <Button disabled={changingProposal} onClick={exitManualEdit}>取消</Button>}<Button disabled={!manualIsDirty} type="primary" icon={<SaveOutlined />} loading={changingProposal} onClick={() => void saveManualEdit()}>保存修改</Button></div></div><textarea className="manual-report-textarea" value={manualDraft} onChange={(event) => setManualDraft(event.target.value)} /></section> : <ReportRenderer blocks={renderedBlocks} selectedBlockIds={selectedBlockIds} selectionMode={selectionMode} onToggleBlock={toggleBlock} />}
          </div>
        </section>
      </div>
    </main>
  );
}
