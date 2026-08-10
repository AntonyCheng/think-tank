const form = document.querySelector("#research-form");
const topicInput = document.querySelector("#topic");
const submitButton = document.querySelector("#submit-button");
const cancelButton = document.querySelector("#cancel-button");
const resumeButton = document.querySelector("#resume-button");
const formError = document.querySelector("#form-error");
const sourceMode = document.querySelector("#source-mode");
const sourceUrls = document.querySelector("#source-urls");
const sourceUrlsField = document.querySelector("#source-urls-field");
const sourceDocuments = document.querySelector("#source-documents");
const sourceDocumentsField = document.querySelector("#source-documents-field");
const includeDomains = document.querySelector("#include-domains");
const excludeDomains = document.querySelector("#exclude-domains");
const includeDomainsField = document.querySelector(
  "#include-domains-field",
);
const excludeDomainsField = document.querySelector(
  "#exclude-domains-field",
);
const taskRetrieversField = document.querySelector(
  "#task-retrievers-field",
);
const taskRetrievers = document.querySelector("#task-retrievers");
const taskRetrieversHelp = document.querySelector(
  "#task-retrievers-help",
);
const workspace = document.querySelector("#workspace");
const taskTopic = document.querySelector("#task-topic");
const taskStatus = document.querySelector("#task-status");
const timeline = document.querySelector("#timeline");
const eventCount = document.querySelector("#event-count");
const stepCount = document.querySelector("#step-count");
const sourceCount = document.querySelector("#source-count");
const researchElapsed = document.querySelector("#research-elapsed");
const researchCost = document.querySelector("#research-cost");
const contentAcceptanceState = document.querySelector(
  "#content-acceptance-state",
);
const evidenceQualityState = document.querySelector(
  "#evidence-quality-state",
);
const expertRoster = document.querySelector("#expert-roster");
const expertRosterSummary = document.querySelector("#expert-roster-summary");
const expertRosterList = document.querySelector("#expert-roster-list");
const reportEmpty = document.querySelector("#report-empty");
const report = document.querySelector("#report");
const reportEvidencePolicy = document.querySelector("#report-evidence-policy");
const qualityWarning = document.querySelector("#quality-warning");
const contentWarningSection = document.querySelector(
  "#content-warning-section",
);
const contentWarningList = document.querySelector("#content-warning-list");
const evidenceWarningSection = document.querySelector(
  "#evidence-warning-section",
);
const evidenceQualityMetrics = document.querySelector(
  "#evidence-quality-metrics",
);
const evidenceWarningList = document.querySelector("#evidence-warning-list");
const failure = document.querySelector("#failure");
const failureTitle = document.querySelector("#failure-title");
const failureMessage = document.querySelector("#failure-message");
const copyButton = document.querySelector("#copy-button");
const reportActions = document.querySelector("#report-actions");
const reportEditButton = document.querySelector("#report-edit-button");
const reportEditorStatus = document.querySelector("#report-editor-status");
const reportEditorPanel = document.querySelector("#report-editor-panel");
const reportEditorScope = document.querySelector("#report-editor-scope");
const reportEditorDocumentScope = document.querySelector("#report-editor-document-scope");
const reportEditorPanelSlot = document.querySelector("#report-editor-panel-slot");
const reportEditorDialog = document.querySelector("#report-editor-dialog");
const reportEditorWorkbench = document.querySelector(".report-editor-workbench");
const reportEditorLeft = document.querySelector("#report-editor-left");
const reportEditorReport = document.querySelector("#report-editor-report");
const reportEditorPreviewStatus = document.querySelector("#report-editor-preview-status");
const reportEditorAudit = document.querySelector("#report-editor-audit");
const reportEditorMobileChat = document.querySelector("#report-editor-mobile-chat");
const reportEditorMobileReport = document.querySelector("#report-editor-mobile-report");
const reportEditorDialogClose = document.querySelector("#report-editor-dialog-close");
const reportEditorVersions = document.querySelector("#report-editor-versions");
const reportEditorVersionReview = document.querySelector("#report-editor-version-review");
const reportEditorVersionList = document.querySelector("#report-editor-version-list");
const reportEditorVersionCurrent = document.querySelector("#report-editor-version-current");
const reportEditorManualEdit = document.querySelector("#report-editor-manual-edit");
const reportEditorManualSave = document.querySelector("#report-editor-manual-save");
const reportEditorManualCancel = document.querySelector("#report-editor-manual-cancel");
const reportEditorConversation = document.querySelector("#report-editor-conversation");
const reportEditorProposal = document.querySelector("#report-editor-proposal");
const reportEditorForm = document.querySelector("#report-editor-form");
const reportEditorInstruction = document.querySelector("#report-editor-instruction");
const reportEditorSubmit = document.querySelector("#report-editor-submit");
const reportEditorApply = document.querySelector("#report-editor-apply");
const reportEditorReject = document.querySelector("#report-editor-reject");
const reportEditorUndo = document.querySelector("#report-editor-undo");
const reportEditorError = document.querySelector("#report-editor-error");
const exportDocx = document.querySelector("#export-docx");
const exportPdf = document.querySelector("#export-pdf");
const exportMarkdown = document.querySelector("#export-markdown");
const inputForm = document.querySelector("#input-form");
const inputPrompt = document.querySelector("#input-prompt");
const inputAnswer = document.querySelector("#input-answer");
const inputError = document.querySelector("#input-error");
const inputSubmit = document.querySelector("#input-submit");
const approvalApprove = document.querySelector("#approval-approve");
const approvalDecline = document.querySelector("#approval-decline");
const serviceState = document.querySelector(".service-state");
const serviceLabel = document.querySelector("#service-label");
const historyButton = document.querySelector("#history-button");
const historyDialog = document.querySelector("#history-dialog");
const historyClose = document.querySelector("#history-close");
const historyQuery = document.querySelector("#history-query");
const historyFilters = document.querySelector("#history-filters");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const historyMore = document.querySelector("#history-more");
const historyError = document.querySelector("#history-error");
const settingsButton = document.querySelector("#settings-button");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const settingsClose = document.querySelector("#settings-close");
const settingsError = document.querySelector("#settings-error");
const settingsSaved = document.querySelector("#settings-saved");
const apiKeyState = document.querySelector("#api-key-state");
const settingsRetrievers = document.querySelector(
  "#settings-retrievers",
);
const settingsRetrieversHelp = document.querySelector(
  "#settings-retrievers-help",
);
const ACTIVE_TASK_STORAGE_KEY = "think-tank.active-task-id";
const REPORT_EDITOR_DRAFT_PREFIX = "think-tank.report-editor-draft";

const markdownRenderer = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
});
const defaultValidateLink =
  markdownRenderer.validateLink.bind(markdownRenderer);
markdownRenderer.validateLink = (url) => {
  const supported =
    /^https?:\/\//i.test(url) ||
    /^mailto:/i.test(url) ||
    url.startsWith("#");
  return supported && defaultValidateLink(url);
};
const defaultLinkOpen =
  markdownRenderer.renderer.rules.link_open ||
  ((tokens, index, options, _environment, renderer) =>
    renderer.renderToken(tokens, index, options));
markdownRenderer.renderer.rules.link_open = (
  tokens,
  index,
  options,
  environment,
  renderer,
) => {
  const href = tokens[index].attrGet("href") || "";
  if (/^https?:\/\//i.test(href)) {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
  }
  const label = tokens[index + 1]?.content || "";
  if (/^\[\d+\]$/u.test(label)) {
    tokens[index].attrJoin("class", "citation-ref");
    tokens[index].attrSet(
      "aria-label",
      `查看来源 ${label.slice(1, -1)}`,
    );
  }
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};
const timelineMarkdownRenderer = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
});
timelineMarkdownRenderer.disable("image");
timelineMarkdownRenderer.validateLink = markdownRenderer.validateLink;
timelineMarkdownRenderer.renderer.rules.link_open =
  markdownRenderer.renderer.rules.link_open;

let eventSource;
let activeTaskId;
let activeTaskCreatedAt;
let activeTaskFinishedAt;
let activeInputRequest;
let activeReportMarkdown = "";
let reportDocument;
let reportEditing = false;
let selectedReportBlockId;
let selectedReportBlockIds = [];
let selectedReportTextRange;
let reportEditorConversations = [];
let reportEditorOperations = [];
let selectedReportConversation;
let proposedReportOperation;
let reportEditorBusy = false;
let reportEditorTransientMessage;
let reportManualEditing = false;
let reportDocumentVersions = [];
let selectedReportVersion;
let reportCitationAudit;
let receivedEvents = 0;
let researchActivityCount = 0;
let sources = 0;
let lastEventId = 0;
let authoritativeSourceCount;
const steps = new Map();
const stepLabels = new Map();
const plannedExperts = new Map();
const progressStages = new Map();
const researchRuns = new Map();
let plannedExpertCount = 0;
let retrieverCapabilities = [{
  id: "duckduckgo",
  label: "DuckDuckGo",
  category: "web",
  selectable: true,
}];
let maxRetrievers = 1;
let defaultRetrievers = ["duckduckgo"];
let historyFilter = "all";
let historyCursor;
let historyLoading = false;
let historySearchTimer;

function createClientTaskId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ].map((part) => part.join("")).join("-");
}

checkHealth();
restoreInitialTask();
renderRetrieverControls();
refreshResearchSettings();
updateResearchSourceFields();
setInterval(() => {
  refreshResearchActivityFreshness();
  refreshTaskElapsed();
}, 1_000);

sourceMode.addEventListener("change", updateResearchSourceFields);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();
  if (!topic) return;

  let researchProfile;
  try {
    researchProfile = buildResearchProfile();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    return;
  }
  resetWorkspace(topic);
  setSubmitting(true);
  clearError();

  try {
    const taskId = createClientTaskId();
    const documentIds = await uploadDocuments(taskId);
    if (researchProfile.source.mode === "local" || researchProfile.source.mode === "hybrid") {
      researchProfile.source.documentIds = documentIds;
    }
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        taskId,
        ...(researchProfile ? { researchProfile } : {}),
      }),
    });
    const task = await response.json();
    if (!response.ok) {
      throw new Error(task.error || "任务提交失败");
    }

    activeTaskId = task.id;
    setTaskLifecycle(task);
    localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, activeTaskId);
    window.history.replaceState(
      null,
      "",
      `#/tasks/${encodeURIComponent(task.id)}`,
    );
    setStatus(task.status);
    connectEvents(task.id);
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setSubmitting(false);
    showError(error instanceof Error ? error.message : String(error));
  }
});

function updateResearchSourceFields() {
  const usesUrls = ["urls", "urls_web"].includes(sourceMode.value);
  const usesDocuments = ["local", "hybrid"].includes(sourceMode.value);
  const usesWeb = ["web", "urls_web", "hybrid"].includes(
    sourceMode.value,
  );
  sourceUrlsField.hidden = !usesUrls;
  includeDomainsField.hidden = !usesWeb;
  excludeDomainsField.hidden = !usesWeb;
  taskRetrieversField.hidden = !usesWeb;
  sourceUrls.required = usesUrls;
  sourceDocuments.required = usesDocuments;
  sourceDocumentsField.hidden = !usesDocuments;
}

function buildResearchProfile() {
  const include = parseDomainList(includeDomains.value);
  const exclude = parseDomainList(excludeDomains.value);
  const retrievers = selectedRetrievers(taskRetrievers);
  const usesWeb = ["web", "urls_web", "hybrid"].includes(
    sourceMode.value,
  );
  if (usesWeb && retrievers.length === 0) {
    throw new Error("请至少选择一个本次研究使用的检索器。");
  }
  if (retrievers.length > maxRetrievers) {
    throw new Error(`本次研究最多选择 ${maxRetrievers} 个检索器。`);
  }
  if (sourceMode.value === "web") {
    return {
      source: {
        mode: "web",
        retrievers,
        ...(include.length ? { includeDomains: include } : {}),
        ...(exclude.length ? { excludeDomains: exclude } : {}),
      },
    };
  }

  if (sourceMode.value === "local" || sourceMode.value === "hybrid") {
    if (sourceDocuments.files.length === 0) throw new Error("请至少选择一个本地文档。");
    return {
      source: {
        mode: sourceMode.value,
        documentIds: [],
        ...(sourceMode.value === "hybrid" ? { web: { retrievers, ...(include.length ? { includeDomains: include } : {}), ...(exclude.length ? { excludeDomains: exclude } : {}) } } : {}),
      },
    };
  }

  const urls = uniqueValues(
    sourceUrls.value
      .split(/\r?\n/gu)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (urls.length === 0) {
    throw new Error("请至少填写一个指定 URL。");
  }
  if (urls.length > 50) {
    throw new Error("指定 URL 最多填写 50 个。");
  }
  for (const value of urls) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`指定 URL 格式无效：${value}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`指定 URL 只支持 HTTP(S)：${value}`);
    }
  }
  return {
    source: {
      mode: "urls",
      urls,
      ...(sourceMode.value === "urls_web"
          ? {
              web: {
                retrievers,
                ...(include.length ? { includeDomains: include } : {}),
                ...(exclude.length ? { excludeDomains: exclude } : {}),
            },
          }
        : {}),
    },
  };
}

async function uploadDocuments(taskId) {
  const files = [...sourceDocuments.files];
  if (files.length > 20) throw new Error("本地文档最多 20 个。");
  const records = await Promise.all(files.map(async (file) => {
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MiB 限制。`);
    const contentBase64 = await fileToBase64(file);
    const response = await fetch(`/api/tasks/${taskId}/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, contentBase64 }) });
    const record = await response.json();
    if (!response.ok) throw new Error(record.error || `${file.name} 上传失败。`);
    return record;
  }));
  return records.map((record) => record.documentId);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error || new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function parseDomainList(value) {
  return uniqueValues(
    value
      .split(/[\s,，;；]+/gu)
      .map((candidate) => candidate.trim().toLowerCase())
      .filter(Boolean),
  );
}

function uniqueValues(values) {
  return [...new Set(values)];
}

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(activeReportMarkdown);
  copyButton.textContent = "已复制";
  setTimeout(() => {
    copyButton.textContent = "复制报告";
  }, 1400);
});

cancelButton.addEventListener("click", async () => {
  if (!activeTaskId) return;
  if (!window.confirm("确定取消当前研究任务吗？已完成的中间结果不会生成报告。")) {
    return;
  }
  cancelButton.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/cancel`, {
      method: "POST",
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "取消任务失败");
    }
    setStatus(body.status);
  } catch (error) {
    cancelButton.disabled = false;
    showError(error instanceof Error ? error.message : String(error));
  }
});

resumeButton.addEventListener("click", async () => {
  if (!activeTaskId) return;
  resumeButton.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/resume`, {
      method: "POST",
    });
    const task = await response.json();
    if (!response.ok) throw new Error(task.error || "恢复任务失败");
    failure.hidden = true;
    setStatus(task.status);
    setSubmitting(true);
  } catch (error) {
    showFailure(
      error instanceof Error ? error.message : String(error),
      "无法恢复任务",
    );
    resumeButton.disabled = false;
  }
});

inputForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = inputAnswer.value.trim();
  if (!answer) return;
  await submitInputAnswer(answer);
});

approvalApprove.addEventListener("click", () => submitInputAnswer("approved"));
approvalDecline.addEventListener("click", () => submitInputAnswer("declined"));

async function submitInputAnswer(answer) {
  if (!activeTaskId || !activeInputRequest?.requestId) return;
  inputSubmit.disabled = true;
  approvalApprove.disabled = true;
  approvalDecline.disabled = true;
  inputError.hidden = true;
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer, requestId: activeInputRequest.requestId }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "补充信息提交失败");
    }
  } catch (error) {
    inputError.textContent =
      error instanceof Error ? error.message : String(error);
    inputError.hidden = false;
    inputSubmit.disabled = false;
    approvalApprove.disabled = false;
    approvalDecline.disabled = false;
  }
}

settingsButton.addEventListener("click", async () => {
  settingsError.hidden = true;
  settingsSaved.hidden = true;
  try {
    const settings = await fetchResearchSettings();
    applyResearchSettings(settings);
    apiKeyState.textContent = settings.apiKeyConfigured
      ? "服务器 API Key：已配置"
      : "服务器 API Key：未配置，请先填写 .env";
    settingsDialog.showModal();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});

settingsClose.addEventListener("click", () => settingsDialog.close());

historyButton.addEventListener("click", async () => {
  historyDialog.showModal();
  await loadHistory(true);
  historyQuery.focus();
});

historyClose.addEventListener("click", () => historyDialog.close());

historyFilters.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-history-filter]");
  if (!button) return;
  historyFilter = button.dataset.historyFilter || "all";
  for (const filterButton of historyFilters.querySelectorAll("button")) {
    filterButton.setAttribute(
      "aria-pressed",
      String(filterButton === button),
    );
  }
  await loadHistory(true);
});

historyQuery.addEventListener("input", () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(true), 220);
});

historyMore.addEventListener("click", () => loadHistory(false));

reportEditButton.addEventListener("click", async () => {
  if (!reportDocument) return;
  reportEditing = !reportEditing;
  selectedReportBlockId = undefined;
  selectedReportBlockIds = [];
  selectedReportTextRange = undefined;
  reportEditorConversations = [];
  reportEditorOperations = [];
  selectedReportConversation = undefined;
  proposedReportOperation = undefined;
  reportEditorTransientMessage = undefined;
  reportManualEditing = false;
  reportDocumentVersions = [];
  selectedReportVersion = undefined;
  reportEditorVersionReview.hidden = true;
  if (reportEditing) {
    setReportEditorMobileView("chat");
    reportEditorLeft.append(reportEditorPanel);
    reportEditorDialog.showModal();
    await loadReportEditorConversations();
  } else {
    reportEditorDialog.close();
    reportEditorPanelSlot.append(reportEditorPanel);
  }
  renderReportDocument();
});

reportEditorDialogClose.addEventListener("click", () => {
  if (!confirmDiscardManualDraft()) return;
  reportEditing = false;
  reportManualEditing = false;
  selectedReportVersion = undefined;
  reportEditorVersionReview.hidden = true;
  reportEditorDialog.close();
  reportEditorPanelSlot.append(reportEditorPanel);
  renderReportDocument();
});

reportEditorDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  reportEditorDialogClose.click();
});

function setReportEditorMobileView(view) {
  const showReport = view === "report";
  reportEditorWorkbench.classList.toggle("mobile-report-visible", showReport);
  reportEditorMobileChat.setAttribute("aria-pressed", String(!showReport));
  reportEditorMobileReport.setAttribute("aria-pressed", String(showReport));
}

reportEditorMobileChat.addEventListener("click", () => setReportEditorMobileView("chat"));
reportEditorMobileReport.addEventListener("click", () => setReportEditorMobileView("report"));

async function selectReportBlockFromEvent(event) {
  if (!reportEditing || reportManualEditing || event.target.closest("a")) return;
  const block = event.target.closest("[data-report-block-id]");
  if (!block) return;
  const blockId = block.dataset.reportBlockId;
  const currentIndex = reportDocument.blocks.findIndex((item) => item.id === blockId);
  if (event.shiftKey && selectedReportBlockIds.length) {
    const anchorIndex = reportDocument.blocks.findIndex((item) => item.id === selectedReportBlockIds[0]);
    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    selectedReportBlockIds = reportDocument.blocks.slice(start, end + 1).map((item) => item.id);
  } else {
    selectedReportBlockIds = [blockId];
  }
  if (!selectedReportTextRange || selectedReportTextRange.blockId !== blockId) {
    selectedReportTextRange = undefined;
  }
  selectedReportBlockId = selectedReportBlockIds[0];
  proposedReportOperation = undefined;
  reportEditorTransientMessage = undefined;
  await loadReportEditorConversations();
  renderReportDocument();
}

function captureReportTextSelection() {
  if (!reportEditing || reportManualEditing || !reportDocument) return;
  const selection = window.getSelection();
  const selectedText = selection?.toString() || "";
  if (!selection || !selectedText.trim() || selection.rangeCount === 0) return;
  const anchorElement = selection.anchorNode instanceof Element
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  const focusElement = selection.focusNode instanceof Element
    ? selection.focusNode
    : selection.focusNode?.parentElement;
  const anchorBlock = anchorElement?.closest("[data-report-block-id]");
  const focusBlock = focusElement?.closest("[data-report-block-id]");
  if (!anchorBlock || anchorBlock !== focusBlock) return;
  const blockId = anchorBlock.dataset.reportBlockId;
  const block = reportDocument.blocks.find((item) => item.id === blockId);
  const content = anchorBlock.querySelector(".report-editor-block-content");
  if (!block || !content) return;
  const selectedStart = domTextOffset(content, selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
  const selectedEnd = domTextOffset(content, selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  const start = Math.min(selectedStart, selectedEnd);
  const markdownStart = block.markdown.indexOf(selectedText, Math.max(0, start - 2));
  if (markdownStart < 0 || block.markdown.slice(markdownStart, markdownStart + selectedText.length) !== selectedText) {
    showReportEditorError("这段文字无法安全映射到原始 Markdown，请改选完整段落。");
    return;
  }
  selectedReportBlockIds = [block.id];
  selectedReportBlockId = block.id;
  selectedReportTextRange = {
    blockId: block.id,
    rangeStart: markdownStart,
    rangeEnd: markdownStart + selectedText.length,
    originalText: selectedText,
  };
  proposedReportOperation = undefined;
  reportEditorTransientMessage = undefined;
  void loadReportEditorConversations().then(() => renderReportDocument());
}

function domTextOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

report.addEventListener("click", selectReportBlockFromEvent);
reportEditorReport.addEventListener("click", selectReportBlockFromEvent);
reportEditorReport.addEventListener("mouseup", captureReportTextSelection);

async function selectReportBlockFromKeyboard(event) {
  if (
    !reportEditing ||
    reportManualEditing ||
    !["Enter", " "].includes(event.key) ||
    !(event.target instanceof HTMLElement)
  ) return;
  const block = event.target.closest("[data-report-block-id]");
  if (!block) return;
  event.preventDefault();
  selectedReportBlockIds = [block.dataset.reportBlockId];
  selectedReportBlockId = selectedReportBlockIds[0];
  selectedReportTextRange = undefined;
  proposedReportOperation = undefined;
  await loadReportEditorConversations();
  renderReportDocument();
}

report.addEventListener("keydown", selectReportBlockFromKeyboard);
reportEditorReport.addEventListener("keydown", selectReportBlockFromKeyboard);

reportEditorManualEdit.addEventListener("click", () => {
  if (!reportDocument || reportEditorBusy) return;
  if (selectedReportVersion) {
    showReportEditorError("请先返回当前版本，再进行编辑。");
    return;
  }
  if (proposedReportOperation?.state === "proposed") {
    showReportEditorError("请先应用或放弃右侧的 AI 修改预览，再进行手动编辑。");
    return;
  }
  reportManualEditing = true;
  reportEditorTransientMessage = undefined;
  renderReportDocument();
});

reportEditorManualCancel.addEventListener("click", () => {
  if (reportEditorBusy) return;
  if (!confirmDiscardManualDraft()) return;
  reportManualEditing = false;
  renderReportDocument();
});

reportEditorManualSave.addEventListener("click", async () => {
  if (!activeTaskId || !reportDocument || reportEditorBusy || !reportManualEditing) return;
  const replacementMarkdown = document.querySelector("#report-editor-manual-markdown")?.value;
  if (typeof replacementMarkdown !== "string") return;
  const scope = selectedReportBlockIds.length ? "blocks" : "document";
  const selectedBlock = selectedReportBlockIds.length === 1
    ? reportDocument.blocks.find((item) => item.id === selectedReportBlockIds[0])
    : undefined;
  const currentMarkdown = manualEditorMarkdown();
  if (replacementMarkdown === currentMarkdown) {
    clearReportEditorDraft();
    reportManualEditing = false;
    renderReportDocument();
    return;
  }
  setReportEditorBusy(true);
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/report-editor/manual-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: selectedReportTextRange ? "text" : scope,
        blockIds: selectedReportBlockIds,
        ...(selectedBlock ? { originalFingerprint: selectedBlock.fingerprint } : {}),
        ...(selectedReportTextRange ? selectedReportTextRange : {}),
        documentVersion: reportDocument.version,
        replacementMarkdown,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 && result.document) {
        reportDocument = result.document;
        activeReportMarkdown = result.document.currentMarkdown;
      }
      throw new Error(result.error || "无法保存手动修改");
    }
    reportDocument = result.document;
    activeReportMarkdown = result.document.currentMarkdown;
    reportCitationAudit = result.audit;
    selectedReportConversation = result.conversation;
    clearReportEditorDraft();
    reportManualEditing = false;
    await loadReportEditorConversations();
    renderReportDocument();
  } catch (error) {
    showReportEditorError(error instanceof Error ? error.message : String(error));
  } finally {
    setReportEditorBusy(false);
  }
});

reportEditorVersions.addEventListener("click", async () => {
  if (!activeTaskId || !reportDocument || reportEditorBusy) return;
  reportEditorVersionReview.hidden = !reportEditorVersionReview.hidden;
  if (reportEditorVersionReview.hidden) {
    selectedReportVersion = undefined;
    renderReportDocument();
    return;
  }
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/report-document/versions`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取报告版本");
    reportDocumentVersions = result.versions || [];
    renderReportDocument();
  } catch (error) {
    reportEditorVersionReview.hidden = true;
    showReportEditorError(error instanceof Error ? error.message : String(error));
  }
});

reportEditorVersionCurrent.addEventListener("click", () => {
  selectedReportVersion = undefined;
  renderReportDocument();
});

reportEditorVersionList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-report-version]");
  if (!button || !reportDocument) return;
  const version = Number(button.dataset.reportVersion);
  const target = reportDocumentVersions.find((item) => item.version === version);
  if (!target) return;
  if (button.dataset.reportVersionAction === "view") {
    selectedReportVersion = target.version === reportDocument.version ? undefined : target;
    renderReportDocument();
    return;
  }
  if (button.dataset.reportVersionAction !== "restore" || reportEditorBusy || target.version === reportDocument.version) return;
  setReportEditorBusy(true);
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/report-document/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: target.version, documentVersion: reportDocument.version }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法恢复报告版本");
    reportDocument = result.document;
    activeReportMarkdown = result.document.currentMarkdown;
    reportCitationAudit = result.audit;
    selectedReportVersion = undefined;
    const versionsResponse = await fetch(`/api/tasks/${activeTaskId}/report-document/versions`);
    const versionsResult = await versionsResponse.json();
    if (versionsResponse.ok) reportDocumentVersions = versionsResult.versions || [];
    await loadReportEditorConversations();
    renderReportDocument();
  } catch (error) {
    showReportEditorError(error instanceof Error ? error.message : String(error));
  } finally {
    setReportEditorBusy(false);
  }
});

reportEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const instruction = reportEditorInstruction.value.trim();
  if (!reportDocument || !activeTaskId || !instruction || reportManualEditing || selectedReportVersion) return;
  const scope = selectedReportTextRange ? "text" : selectedReportBlockIds.length ? "blocks" : "document";
  const selectedBlock = selectedReportBlockIds.length === 1
    ? reportDocument.blocks.find((item) => item.id === selectedReportBlockIds[0])
    : undefined;
  setReportEditorBusy(true);
  reportEditorTransientMessage = "正在理解你的要求…";
  renderReportEditorPanel();
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/report-editor/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        blockIds: selectedReportBlockIds,
        ...(selectedReportTextRange ? selectedReportTextRange : {}),
        ...(selectedBlock ? { blockId: selectedBlock.id, originalFingerprint: selectedBlock.fingerprint } : {}),
        documentVersion: reportDocument.version,
        instruction,
        ...(selectedReportConversation ? { conversationId: selectedReportConversation.id } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 && result.document) {
        reportDocument = result.document;
        activeReportMarkdown = result.document.currentMarkdown;
      }
      throw new Error(result.error || "无法生成局部修改");
    }
    selectedReportConversation = result.conversation;
    proposedReportOperation = result.kind === "proposal" ? result.operation : undefined;
    reportCitationAudit = result.audit;
    reportEditorInstruction.value = "";
    reportEditorTransientMessage = undefined;
    await loadReportEditorConversations();
    renderReportDocument();
  } catch (error) {
    reportEditorTransientMessage = undefined;
    showReportEditorError(error instanceof Error ? error.message : String(error));
    await loadReportEditorConversations();
    renderReportDocument();
  } finally {
    setReportEditorBusy(false);
  }
});

reportEditorApply.addEventListener("click", () => applyReportOperation("apply"));
reportEditorReject.addEventListener("click", () => applyReportOperation("reject"));
reportEditorDocumentScope.addEventListener("click", async () => {
  selectedReportBlockIds = [];
  selectedReportBlockId = undefined;
  proposedReportOperation = undefined;
  await loadReportEditorConversations();
  renderReportDocument();
});
reportEditorUndo.addEventListener("click", async () => {
  const operation = reportEditorOperations.find((item) =>
    item.state === "applied" && !item.undoneOperationId
  );
  if (!operation) return;
  const previousProposal = proposedReportOperation;
  proposedReportOperation = operation;
  await applyReportOperation("undo");
  if (proposedReportOperation === operation) proposedReportOperation = previousProposal;
});

historyList.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("button[data-delete-task-id]");
  if (deleteButton) {
    await deleteHistoricalTask(deleteButton.dataset.deleteTaskId, deleteButton);
    return;
  }
  const button = event.target.closest("button[data-task-id]");
  if (!button) return;
  await openHistoricalTask(button.dataset.taskId);
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsError.hidden = true;
  settingsSaved.hidden = true;
  const values = Object.fromEntries(new FormData(settingsForm));
  if (!values.apiKey) delete values.apiKey;
  values.concurrency = Number(values.concurrency);
  values.retrievers = selectedRetrievers(settingsRetrievers);
  if (values.retrievers.length === 0) {
    settingsError.textContent = "请至少选择一个默认检索器。";
    settingsError.hidden = false;
    return;
  }
  if (values.retrievers.length > maxRetrievers) {
    settingsError.textContent =
      `默认检索器最多选择 ${maxRetrievers} 个。`;
    settingsError.hidden = false;
    return;
  }
  const button = settingsForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const settings = await response.json();
    if (!response.ok) {
      throw new Error(settings.error || "设置保存失败");
    }
    applyResearchSettings(settings);
    const apiKeyField = settingsForm.elements.namedItem("apiKey");
    if (apiKeyField && "value" in apiKeyField) apiKeyField.value = "";
    apiKeyState.textContent = settings.apiKeyConfigured
      ? "服务器 API Key：已配置"
      : "服务器 API Key：未配置，请填写后保存";
    settingsSaved.hidden = false;
  } catch (error) {
    settingsError.textContent =
      error instanceof Error ? error.message : String(error);
    settingsError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

async function refreshResearchSettings() {
  try {
    applyResearchSettings(await fetchResearchSettings());
  } catch {
    taskRetrieversHelp.textContent =
      "暂时无法读取能力目录，将使用服务器默认检索器。";
  }
}

async function fetchResearchSettings() {
  const response = await fetch("/api/settings");
  const settings = await response.json();
  if (!response.ok) {
    throw new Error(settings.error || "无法读取设置");
  }
  return settings;
}

function applyResearchSettings(settings) {
  const capabilities = Array.isArray(settings.retrieverCapabilities)
    ? settings.retrieverCapabilities.filter(
      (item) => item?.selectable && typeof item.id === "string",
    )
    : [];
  if (capabilities.length > 0) {
    retrieverCapabilities = capabilities;
  }
  maxRetrievers = Math.max(
    1,
    Math.min(
      Number(settings.maxRetrievers || 1),
      retrieverCapabilities.length,
    ),
  );
  const configured = Array.isArray(settings.retrievers)
    ? settings.retrievers
    : [settings.retriever].filter(Boolean);
  defaultRetrievers = configured.filter((id) =>
    retrieverCapabilities.some((item) => item.id === id)
  ).slice(0, maxRetrievers);
  if (defaultRetrievers.length === 0) {
    defaultRetrievers = [retrieverCapabilities[0].id];
  }
  renderRetrieverControls();
  updateResearchSourceFields();

  for (const [name, value] of Object.entries(settings)) {
    if (
      name === "retriever" ||
      name === "retrievers" ||
      name === "retrieverCapabilities" ||
      name === "maxRetrievers"
    ) {
      continue;
    }
    const field = settingsForm.elements.namedItem(name);
    if (field && "value" in field) {
      field.value = String(value ?? "");
    }
  }
}

function renderRetrieverControls() {
  renderRetrieverOptions(
    taskRetrievers,
    defaultRetrievers,
    "task-retriever",
  );
  renderRetrieverOptions(
    settingsRetrievers,
    defaultRetrievers,
    "settings-retriever",
  );
  const help = (
    `最多选择 ${maxRetrievers} 个；` +
    "学术检索器适合论文、科研与医学主题。"
  );
  taskRetrieversHelp.textContent = help;
  settingsRetrieversHelp.textContent =
    `只显示后端已验证可用的检索器，最多选择 ${maxRetrievers} 个。`;
}

function renderRetrieverOptions(container, selected, idPrefix) {
  container.replaceChildren();
  for (const capability of retrieverCapabilities) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = capability.id;
    input.id = `${idPrefix}-${capability.id}`;
    input.checked = selected.includes(capability.id);
    const text = document.createElement("span");
    text.textContent = capability.label;
    const category = document.createElement("small");
    category.textContent =
      capability.category === "academic" ? "学术" : "网页";
    label.append(input, text, category);
    container.append(label);
  }
}

function selectedRetrievers(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function enforceRetrieverLimit(event) {
  if (
    event.target instanceof HTMLInputElement &&
    event.target.checked &&
    selectedRetrievers(event.currentTarget).length > maxRetrievers
  ) {
    event.target.checked = false;
    const message = `最多选择 ${maxRetrievers} 个检索器。`;
    if (event.currentTarget === settingsRetrievers) {
      settingsError.textContent = message;
      settingsError.hidden = false;
    } else {
      showError(message);
    }
  }
}

taskRetrievers.addEventListener("change", enforceRetrieverLimit);
settingsRetrievers.addEventListener("change", enforceRetrieverLimit);

async function restoreInitialTask() {
  const taskId = taskIdFromHash();
  if (taskId) {
    await openHistoricalTask(taskId, false);
    return;
  }
  await restoreActiveTask();
}

function taskIdFromHash() {
  const match = /^#\/tasks\/([^/]+)$/u.exec(window.location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function loadHistory(reset) {
  if (historyLoading) return;
  if (reset) {
    historyCursor = undefined;
    historyList.replaceChildren();
  }
  historyLoading = true;
  historyMore.disabled = true;
  historyError.hidden = true;
  try {
    const params = new URLSearchParams({
      limit: "30",
      filter: historyFilter,
    });
    const query = historyQuery.value.trim();
    if (query) params.set("q", query);
    if (!reset && historyCursor) params.set("cursor", historyCursor);
    const response = await fetch(`/api/tasks?${params}`);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || "无法读取历史研究");
    for (const item of page.items || []) {
      historyList.append(renderHistoryItem(item));
    }
    historyCursor = page.nextCursor;
    historyEmpty.hidden = historyList.children.length > 0;
    historyMore.hidden = !historyCursor;
  } catch (error) {
    historyError.textContent = error instanceof Error ? error.message : String(error);
    historyError.hidden = false;
  } finally {
    historyLoading = false;
    historyMore.disabled = false;
  }
}

function renderHistoryItem(item) {
  const row = document.createElement("li");
  row.className = "history-item";
  const content = document.createElement("button");
  content.type = "button";
  content.className = "history-open";
  content.dataset.taskId = item.id;

  const topic = document.createElement("span");
  topic.className = "history-item-topic";
  topic.textContent = item.topic;

  const status = document.createElement("span");
  status.className = "history-item-status";
  status.textContent = historyStatusLabel(item.status);

  const meta = document.createElement("span");
  meta.className = "history-item-meta";
  const details = [
    formatHistoryDate(item.updatedAt),
    status.textContent,
    `${item.expertCount || 0} 位专家`,
    `${item.sourceCount || 0} 个来源`,
  ];
  if (Number.isFinite(item.elapsedMs)) details.push(formatDuration(item.elapsedMs));
  if (Number.isFinite(item.costUsd)) details.push(formatUsd(item.costUsd));
  if (item.warningCount > 0) details.push(`${item.warningCount} 条警告`);
  meta.textContent = details.join(" · ");

  content.append(topic, meta);
  row.append(content);
  if (isTerminalHistoryStatus(item.status)) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-delete";
    remove.dataset.deleteTaskId = item.id;
    remove.textContent = "删除";
    remove.title = "永久删除这项研究及其本地资料";
    remove.setAttribute("aria-label", `删除研究：${item.topic}`);
    row.append(remove);
  }
  return row;
}

function isTerminalHistoryStatus(status) {
  return ["completed", "completed_with_warnings", "failed", "canceled"].includes(status);
}

async function deleteHistoricalTask(taskId, button) {
  if (!taskId) return;
  if (!window.confirm("删除后将无法恢复该研究报告、执行记录和本地资料。确定删除吗？")) {
    return;
  }
  button.disabled = true;
  historyError.hidden = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "无法删除研究记录");
    }
    if (activeTaskId === taskId) clearDeletedTaskView();
    await loadHistory(true);
  } catch (error) {
    historyError.textContent = error instanceof Error ? error.message : String(error);
    historyError.hidden = false;
    button.disabled = false;
  }
}

function clearDeletedTaskView() {
  eventSource?.close();
  eventSource = undefined;
  activeTaskId = undefined;
  localStorage.removeItem(ACTIVE_TASK_STORAGE_KEY);
  window.history.replaceState(null, "", "#/");
  resetWorkspace("");
  workspace.hidden = true;
}

function historyStatusLabel(status) {
  return {
    queued: "排队中",
    recoverable: "可恢复",
    running: "研究中",
    needs_input: "等待补充",
    canceling: "取消中",
    canceled: "已取消",
    completed: "已完成",
    completed_with_warnings: "有警告",
    failed: "未完成",
  }[status] || status;
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function openHistoricalTask(taskId, updateRoute = true) {
  try {
    const response = await fetch(`/api/tasks/${taskId}`);
    const task = await response.json();
    if (!response.ok) throw new Error(task.error || "无法读取历史研究");

    eventSource?.close();
    activeTaskId = task.id;
    localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, task.id);
    if (updateRoute) {
      window.history.replaceState(
        null,
        "",
        `#/tasks/${encodeURIComponent(task.id)}`,
      );
    }
    topicInput.value = task.topic;
    resetWorkspace(task.topic);
    setTaskLifecycle(task);
    setStatus(task.status);
    renderWorkflowPlan(task.workflowPlan);
    updateResearchTelemetry(task.researchTelemetry, isTerminalStatus(task.status));
    await loadTask(task.id);
    connectEvents(task.id);
    historyDialog.close();
  } catch (error) {
    historyError.textContent = error instanceof Error ? error.message : String(error);
    historyError.hidden = false;
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/ready");
    if (!response.ok) throw new Error();
    serviceState.classList.add("online");
    serviceLabel.textContent = "后端服务已就绪";
  } catch {
    serviceState.classList.remove("online");
    serviceLabel.textContent = "依赖服务未就绪";
  }
}

async function restoreActiveTask() {
  const taskId = localStorage.getItem(ACTIVE_TASK_STORAGE_KEY);
  if (!taskId) return;

  try {
    const response = await fetch(`/api/tasks/${taskId}`);
    if (response.status === 404) {
      localStorage.removeItem(ACTIVE_TASK_STORAGE_KEY);
      return;
    }
    const task = await response.json();
    if (!response.ok) {
      throw new Error(task.error || "无法恢复上次任务");
    }

    activeTaskId = task.id;
    topicInput.value = task.topic;
    resetWorkspace(task.topic);
    setTaskLifecycle(task);
    setStatus(task.status);
    renderWorkflowPlan(task.workflowPlan);
    updateResearchTelemetry(
      task.researchTelemetry,
      isTerminalStatus(task.status),
    );
    setSubmitting(
      ["queued", "running", "needs_input", "canceling"].includes(task.status),
    );
    connectEvents(task.id);
  } catch {
    serviceLabel.textContent = "任务恢复暂时不可用";
    serviceState.classList.remove("online");
  }
}

function connectEvents(taskId) {
  eventSource?.close();
  eventSource = new EventSource(`/api/tasks/${taskId}/events`);

  const types = [
    "task.queued",
    "task.running",
    "task.needs_input",
    "task.input_received",
    "task.recoverable",
    "task.resumed",
    "task.rerun_requested",
    "task.canceling",
    "task.canceled",
    "workflow.repairing",
    "workflow.composed",
    "step.started",
    "research.activity",
    "research.progress",
    "research.completed",
    "research.failed",
    "gptr.progress",
    "gptr.completed",
    "gptr.rework_rejected",
    "step.completed",
    "task.completed",
    "task.completed_with_warnings",
    "task.failed",
  ];
  for (const type of types) {
    eventSource.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      handleEvent(payload);
    });
  }
  eventSource.onopen = () => {
    serviceLabel.textContent = "研究事件连接正常";
    serviceState.classList.add("online");
  };
  eventSource.onerror = () => {
    if (taskStatus.dataset.terminal !== "true") {
      serviceLabel.textContent = "事件连接中断";
      serviceState.classList.remove("online");
    }
  };
}

function handleEvent(event) {
  if (Number.isSafeInteger(event.id)) {
    if (event.id <= lastEventId) return;
    lastEventId = event.id;
  }
  receivedEvents += 1;
  updateTimelineCounter();

  switch (event.type) {
    case "task.queued":
      addTimeline("任务已进入队列", "queued", event.timestamp);
      break;
    case "task.running":
      setStatus("running");
      addTimeline("正在组建研究团队", "running", event.timestamp);
      break;
    case "task.recoverable":
      setStatus("recoverable");
      hideInputRequest();
      addTimeline("任务可从检查点恢复", "queued", event.timestamp);
      showFailure(
        "服务重启前已完成的步骤已保存。恢复后只会执行尚未完成的步骤。",
        "任务可恢复",
      );
      setSubmitting(false);
      break;
    case "task.resumed":
      setStatus("queued");
      failure.hidden = true;
      addTimeline("已请求从检查点恢复", "queued", event.timestamp);
      setSubmitting(true);
      break;
    case "task.rerun_requested":
      setStatus("queued");
      reportActions.hidden = true;
      addTimeline("已请求局部重跑", "queued", event.timestamp);
      setSubmitting(true);
      break;
    case "task.needs_input":
      setStatus("needs_input");
      showInputRequest(event.data);
      addTimeline(
        "需要补充信息",
        "running",
        event.timestamp,
        event.data.prompt,
      );
      break;
    case "task.input_received":
      setStatus("running");
      hideInputRequest();
      addTimeline("已收到补充信息，继续执行", "completed", event.timestamp);
      break;
    case "task.canceling":
      setStatus("canceling");
      hideInputRequest();
      addTimeline("正在取消研究任务", "queued", event.timestamp);
      break;
    case "task.canceled":
      markTaskFinished(event.timestamp);
      setStatus("canceled");
      hideInputRequest();
      addTimeline("研究任务已取消", "queued", event.timestamp);
      eventSource?.close();
      showFailure(
        event.data.message || "当前研究任务已由用户取消。",
        "任务已取消",
      );
      setSubmitting(false);
      break;
    case "workflow.composed":
      renderWorkflowPlan(event.data.workflowPlan);
      addTimeline(
        "专家工作流已生成",
        "completed",
        event.timestamp,
        shortPath(event.data.workflowPath),
      );
      break;
    case "workflow.repairing":
      addTimeline(
        `专家工作流预检未通过，正在自动修复（${event.data.attempt}/${event.data.maxAttempts}）`,
        "running",
        event.timestamp,
        `发现 ${event.data.errorCount || 0} 项结构校验问题。`,
      );
      break;
    case "step.started":
      updateRosterStep(event.data.stepId, "running", event.data);
      upsertStep(
        event.data.stepId,
        "running",
        event.timestamp,
        undefined,
        stepLabel(event.data),
      );
      break;
    case "research.activity":
      upsertResearchActivity(event.data, event.timestamp);
      break;
    case "research.progress":
    case "research.completed":
    case "research.failed":
      upsertResearchRun(event.data, event.timestamp);
      updateResearchMetricsFromRuns();
      break;
    case "gptr.progress":
      upsertProgress(
        event.data.researchId,
        event.data.stage,
        event.timestamp,
        event.data.message,
      );
      break;
    case "gptr.completed":
      if (authoritativeSourceCount === undefined) {
        sources += Number(event.data.sourceCount || 0);
        sourceCount.textContent = String(sources);
      }
      completeProgress(event.data.researchId);
      addTimeline(
        "完成一轮证据研究",
        "completed",
        event.timestamp,
        `${event.data.sourceCount || 0} 个来源`,
      );
      break;
    case "gptr.rework_rejected":
      addTimeline(
        "返工结果退化，已保留首版报告",
        "queued",
        event.timestamp,
        event.data.message,
      );
      break;
    case "step.completed": {
      updateRosterStep(
        event.data.stepId,
        rosterStepStatus(event.data.status),
        event.data,
      );
      const verification = event.data.verification;
      upsertStep(
        event.data.stepId,
        event.data.status === "failed" ? "failed" : "completed",
        event.timestamp,
        verification
          ? `验收${verification.pass ? "通过" : "未通过"}${verification.reworked ? " · 已返工" : ""}`
          : undefined,
        stepLabel(event.data),
      );
      if (verification) {
        contentAcceptanceState.textContent = verification.pass
          ? verification.reworked ? "返工后通过" : "已通过"
          : "未通过";
      }
      break;
    }
    case "task.completed":
      markTaskFinished(event.timestamp);
      setStatus("completed");
      addTimeline("研究任务完成", "completed", event.timestamp);
      eventSource?.close();
      loadTask(activeTaskId);
      break;
    case "task.completed_with_warnings":
      markTaskFinished(event.timestamp);
      setStatus("completed_with_warnings");
      updateQualityStates(
        event.data.contentAcceptance,
        event.data.evidenceQuality,
      );
      addTimeline(
        "报告已交付，但存在质量警告",
        "completed",
        event.timestamp,
        `${event.data.warnings?.length || 0} 条质量警告`,
      );
      eventSource?.close();
      loadTask(activeTaskId);
      break;
    case "task.failed":
      markTaskFinished(event.timestamp);
      setStatus("failed");
      hideInputRequest();
      addTimeline("研究任务失败", "failed", event.timestamp);
      eventSource?.close();
      showFailure(event.data.error || "任务执行失败");
      setSubmitting(false);
      break;
  }
}

async function loadTask(taskId) {
  try {
    const response = await fetch(`/api/tasks/${taskId}`);
    const task = await response.json();
    if (!response.ok) throw new Error(task.error || "无法读取任务结果");
    setTaskLifecycle(task);
    setStatus(task.status);
    updateResearchTelemetry(
      task.researchTelemetry,
      isTerminalStatus(task.status),
    );
    if (
      task.status === "completed" ||
      task.status === "completed_with_warnings"
    ) {
      activeReportMarkdown =
        task.output || "任务完成，但没有返回报告内容。";
      await loadReportDocument(task.id);
      renderReportDocument();
      report.hidden = false;
      reportEmpty.hidden = true;
      failure.hidden = true;
      setExportLinks(task.id);
      reportActions.hidden = false;
      reportEditButton.hidden = !reportDocument;
      updateReportEvidencePolicy(task.reportEvidencePolicy);
      updateQualityStates(task.contentAcceptance, task.evidenceQuality);
      showQualityWarnings(
        task.contentAcceptance,
        task.evidenceQuality,
        task.warnings || [],
      );
    } else if (task.status === "failed") {
      showFailure(task.error);
    } else if (task.status === "recoverable") {
      showFailure(
        "服务重启前已完成的步骤已保存。恢复后只会执行尚未完成的步骤。",
        "任务可恢复",
      );
    } else if (task.status === "canceled") {
      showFailure(task.error || "当前研究任务已取消。", "任务已取消");
    }
  } catch (error) {
    showFailure(error instanceof Error ? error.message : String(error));
  } finally {
    setSubmitting(false);
  }
}

async function loadReportDocument(taskId) {
  try {
    const response = await fetch(`/api/tasks/${taskId}/report-document`);
    const document = await response.json();
    if (!response.ok) throw new Error(document.error || "无法读取报告文档");
    reportDocument = document;
    activeReportMarkdown = document.currentMarkdown;
    reportCitationAudit = document.audit;
  } catch {
    reportDocument = undefined;
    reportEditing = false;
    selectedReportBlockId = undefined;
    selectedReportBlockIds = [];
  }
}

function renderLegacyReportDocument() {
  if (!reportEditing || !reportDocument) {
    report.innerHTML = markdownRenderer.render(activeReportMarkdown);
    reportEditButton.textContent = "编辑报告";
    reportEditorStatus.hidden = true;
    reportEditorPanel.hidden = true;
    workspace.classList.remove("report-editing");
    return;
  }

  report.replaceChildren();
  workspace.classList.add("report-editing");
  for (const block of reportDocument.blocks || []) {
    const element = document.createElement("section");
    element.className = "report-editor-block";
    element.dataset.reportBlockId = block.id;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-pressed", String(selectedReportBlockIds.includes(block.id)));
    if (selectedReportBlockIds.includes(block.id)) {
      element.classList.add("selected");
    }
    const content = document.createElement("div");
    content.className = "report-editor-block-content";
    content.innerHTML = markdownRenderer.render(block.markdown);
    element.append(content);
    report.append(element);
  }
  reportEditButton.textContent = "退出编辑";
  reportEditorStatus.hidden = false;
  reportEditorStatus.textContent = selectedReportTextRange
    ? `鏂囨。鐗堟湰 ${reportDocument.version} 路 宸查€変腑鏂囧瓧鑼冨洿`
    : selectedReportBlockIds.length
    ? `文档版本 ${reportDocument.version} · 已选中 ${selectedReportBlockIds.length} 个连续范围`
    : `文档版本 ${reportDocument.version} · 当前范围为整篇报告`;
  reportEditorPreviewStatus.textContent = proposedReportOperation?.state === "proposed"
    ? "正在预览本次修改，尚未保存"
    : `当前版本 ${reportDocument.version}`;
  renderReportEditorPanel();
}

function selectedReportBlock() {
  return (reportDocument?.blocks || []).find((block) => block.id === selectedReportBlockId);
}

// The editor uses a separate workbench so the report card never shares its grid with chat.
function renderReportDocument() {
  if (!reportEditing || !reportDocument) {
    if (reportEditorDialog.open) reportEditorDialog.close();
    reportEditorPanelSlot.append(reportEditorPanel);
    report.hidden = false;
    report.innerHTML = markdownRenderer.render(activeReportMarkdown);
    reportEditButton.textContent = "编辑报告";
    reportEditorStatus.hidden = true;
    reportEditorPanel.hidden = true;
    return;
  }

  report.hidden = true;
  if (!reportEditorDialog.open) reportEditorDialog.showModal();
  if (!reportEditorPanel.parentElement?.isSameNode(reportEditorLeft)) {
    reportEditorLeft.append(reportEditorPanel);
  }
  reportEditorPanel.hidden = false;
  reportEditorEditHeader();
  renderReportBlocks(reportEditorReport, proposedReportOperation);
}

function reportEditorEditHeader() {
  reportEditorPreviewStatus.textContent = proposedReportOperation?.state === "proposed"
    ? "正在预览本次修改，尚未保存"
    : selectedReportVersion
      ? `正在审阅版本 ${selectedReportVersion.version}`
    : reportManualEditing
      ? "正在手动编辑，保存后生成新版本"
    : `当前版本 ${reportDocument.version}`;
  const auditWarnings = reportCitationAudit?.warnings || [];
  const auditText = auditWarnings.length
    ? `引用校验：${auditWarnings.join(" ")}`
    : reportCitationAudit?.summary || "";
  reportEditorAudit.hidden = !auditText;
  reportEditorAudit.classList.toggle("warning", auditWarnings.length > 0);
  reportEditorAudit.textContent = auditText;
  reportEditorManualEdit.hidden = reportManualEditing;
  reportEditorManualSave.hidden = !reportManualEditing;
  reportEditorManualCancel.hidden = !reportManualEditing;
  reportEditorVersions.setAttribute("aria-pressed", String(!reportEditorVersionReview.hidden));
  reportEditorManualEdit.disabled = Boolean(selectedReportVersion) || reportEditorBusy;
  reportEditButton.textContent = "退出编辑";
  reportEditorStatus.hidden = false;
  reportEditorStatus.textContent = selectedReportTextRange
    ? `鏂囨。鐗堟湰 ${reportDocument.version} 路 宸查€変腑鏂囧瓧鑼冨洿`
    : selectedReportBlockIds.length
    ? `文档版本 ${reportDocument.version} · 已选中 ${selectedReportBlockIds.length} 个连续范围`
    : `文档版本 ${reportDocument.version} · 当前范围为整篇报告`;
  renderReportEditorPanel();
  renderReportVersionReview();
}

function renderReportBlocks(target, previewOperation) {
  target.replaceChildren();
  const previewMarkdown = previewOperation ? reportPreviewMarkdown(previewOperation) : undefined;
  const hasPreview = previewMarkdown !== undefined;
  target.classList.toggle("previewing", hasPreview);
  target.classList.toggle("manual-editing", reportManualEditing);
  if (selectedReportVersion) {
    target.innerHTML = markdownRenderer.render(selectedReportVersion.markdown);
    return;
  }
  if (reportManualEditing) {
    const scope = selectedReportBlockIds.length ? "已选内容范围" : "整篇报告";
    const hint = document.createElement("p");
    hint.className = "report-editor-manual-hint";
    hint.textContent = `${scope}将以 Markdown 保存；引用链接和格式会一并保留。`;
    const editor = document.createElement("textarea");
    editor.id = "report-editor-manual-markdown";
    editor.className = "report-editor-manual-markdown";
    editor.value = reportEditorDraftMarkdown() ?? manualEditorMarkdown();
    editor.addEventListener("input", () => saveReportEditorDraft(editor.value));
    editor.setAttribute("aria-label", "手动编辑报告内容");
    target.append(hint, editor);
    return;
  }
  if (hasPreview) {
    renderReportPreview(target, previewOperation, previewMarkdown);
    return;
  }
  for (const block of reportDocument.blocks || []) {
    const element = document.createElement("section");
    element.className = "report-editor-block";
    element.dataset.reportBlockId = block.id;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-pressed", String(selectedReportBlockIds.includes(block.id)));
    if (selectedReportBlockIds.includes(block.id)) element.classList.add("selected");
    const content = document.createElement("div");
    content.className = "report-editor-block-content";
    content.innerHTML = markdownRenderer.render(block.markdown);
    element.append(content);
    target.append(element);
  }
}

function renderReportPreview(target, operation, previewMarkdown) {
  const comparison = document.createElement("section");
  comparison.className = "report-editor-diff";
  const heading = document.createElement("p");
  heading.className = "report-editor-diff-heading";
  heading.textContent = "修改范围对比";
  const columns = document.createElement("div");
  columns.className = "report-editor-diff-columns";
  for (const [label, markdown, variant] of [
    ["原内容", operation.originalMarkdown, "before"],
    ["建议内容", operation.replacementMarkdown, "after"],
  ]) {
    const column = document.createElement("section");
    column.className = `report-editor-diff-column ${variant}`;
    const title = document.createElement("strong");
    title.textContent = label;
    const content = document.createElement("div");
    content.innerHTML = markdownRenderer.render(markdown || "*(已删除)*");
    column.append(title, content);
    columns.append(column);
  }
  comparison.append(heading, columns);
  const preview = document.createElement("section");
  preview.className = "report-editor-rendered-preview";
  preview.innerHTML = markdownRenderer.render(previewMarkdown);
  target.append(comparison, preview);
}

function renderReportVersionReview() {
  if (reportEditorVersionReview.hidden) return;
  reportEditorVersionList.replaceChildren();
  if (!reportDocumentVersions.length) {
    const empty = document.createElement("p");
    empty.className = "report-editor-empty";
    empty.textContent = "尚未读取到可审阅版本。";
    reportEditorVersionList.append(empty);
    return;
  }
  for (const version of reportDocumentVersions) {
    const item = document.createElement("article");
    item.className = "report-editor-version-item";
    const summary = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `版本 ${version.version}${version.version === reportDocument.version ? " · 当前" : ""}`;
    const time = document.createElement("span");
    time.textContent = new Date(version.createdAt).toLocaleString();
    summary.append(title, time);
    const actions = document.createElement("div");
    const view = document.createElement("button");
    view.type = "button";
    view.className = "ghost-button";
    view.dataset.reportVersion = String(version.version);
    view.dataset.reportVersionAction = "view";
    view.textContent = version.version === reportDocument.version ? "查看当前" : "查看";
    actions.append(view);
    if (version.version !== reportDocument.version) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.dataset.reportVersion = String(version.version);
      restore.dataset.reportVersionAction = "restore";
      restore.textContent = "恢复此版本";
      actions.append(restore);
    }
    item.append(summary, actions);
    reportEditorVersionList.append(item);
  }
}

function manualEditorMarkdown() {
  if (!reportDocument) return "";
  if (selectedReportTextRange) return selectedReportTextRange.originalText;
  if (!selectedReportBlockIds.length) return reportDocument.currentMarkdown;
  const firstBlock = reportDocument.blocks.find((block) => block.id === selectedReportBlockIds[0]);
  const lastBlock = reportDocument.blocks.find((block) => block.id === selectedReportBlockIds.at(-1));
  if (!firstBlock || !lastBlock) return "";
  return reportDocument.currentMarkdown.slice(firstBlock.sourceStart, lastBlock.sourceEnd);
}

function reportEditorDraftScope() {
  if (!reportDocument) return undefined;
  return JSON.stringify({
    version: reportDocument.version,
    scope: selectedReportTextRange ? "text" : selectedReportBlockIds.length ? "blocks" : "document",
    blockIds: selectedReportBlockIds,
    rangeStart: selectedReportTextRange?.rangeStart,
    rangeEnd: selectedReportTextRange?.rangeEnd,
  });
}

function reportEditorDraftKey() {
  const scope = reportEditorDraftScope();
  return activeTaskId && scope ? `${REPORT_EDITOR_DRAFT_PREFIX}:${activeTaskId}:${scope}` : undefined;
}

function reportEditorDraftMarkdown() {
  const key = reportEditorDraftKey();
  if (!key) return undefined;
  try {
    const draft = JSON.parse(localStorage.getItem(key) || "null");
    return typeof draft?.markdown === "string" ? draft.markdown : undefined;
  } catch {
    localStorage.removeItem(key);
    return undefined;
  }
}

function saveReportEditorDraft(markdown) {
  const key = reportEditorDraftKey();
  if (!key || typeof markdown !== "string") return;
  if (markdown === manualEditorMarkdown()) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify({ markdown, updatedAt: new Date().toISOString() }));
}

function clearReportEditorDraft() {
  const key = reportEditorDraftKey();
  if (key) localStorage.removeItem(key);
}

function confirmDiscardManualDraft() {
  if (!reportManualEditing) return true;
  const draft = reportEditorDraftMarkdown();
  if (draft === undefined || draft === manualEditorMarkdown()) return true;
  return window.confirm("手动编辑尚未保存，确定放弃这些修改吗？");
}

window.addEventListener("beforeunload", (event) => {
  if (!reportManualEditing || reportEditorDraftMarkdown() === undefined) return;
  event.preventDefault();
  event.returnValue = "";
});

function reportPreviewMarkdown(operation) {
  if (!reportDocument || operation?.state !== "proposed") return undefined;
  if (operation.scope === "document") return operation.replacementMarkdown;
  if (operation.scope === "text") {
    const block = reportDocument.blocks.find((item) => item.id === operation.blockIds[0]);
    if (!block || operation.rangeStart === undefined || operation.rangeEnd === undefined) return undefined;
    const start = block.sourceStart + operation.rangeStart;
    const end = block.sourceStart + operation.rangeEnd;
    return [
      reportDocument.currentMarkdown.slice(0, start),
      operation.replacementMarkdown,
      reportDocument.currentMarkdown.slice(end),
    ].join("");
  }
  const firstBlock = reportDocument.blocks.find((block) => block.id === operation.blockIds[0]);
  const lastBlock = reportDocument.blocks.find(
    (block) => block.id === operation.blockIds.at(-1),
  );
  if (!firstBlock || !lastBlock) return undefined;
  return [
    reportDocument.currentMarkdown.slice(0, firstBlock.sourceStart),
    operation.replacementMarkdown,
    reportDocument.currentMarkdown.slice(lastBlock.sourceEnd),
  ].join("");
}

async function loadReportEditorConversations() {
  if (!activeTaskId || !reportEditing) return;
  const scopeKey = selectedReportBlockIds.length ? selectedReportBlockIds.join(",") : "document";
  try {
    const response = await fetch(
      `/api/tasks/${activeTaskId}/report-editor/conversations?blockId=${encodeURIComponent(scopeKey)}`,
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取编辑对话");
    reportEditorConversations = result.conversations || [];
    reportEditorOperations = result.operations || [];
    const pendingOperation = reportEditorOperations.find((item) => item.state === "proposed");
    if (!proposedReportOperation || !reportEditorOperations.some((item) => item.id === proposedReportOperation.id)) {
      proposedReportOperation = pendingOperation;
    }
    if (selectedReportConversation) {
      selectedReportConversation = reportEditorConversations.find(
        (item) => item.id === selectedReportConversation.id,
      ) || reportEditorConversations[0];
    } else {
      selectedReportConversation = reportEditorConversations[0];
    }
  } catch (error) {
    reportEditorConversations = [];
    reportEditorOperations = [];
    selectedReportConversation = undefined;
    showReportEditorError(error instanceof Error ? error.message : String(error));
  }
}

function renderReportEditorPanel() {
  reportEditorPanel.hidden = false;
  reportEditorScope.textContent = selectedReportTextRange
    ? "宸查€変腑鏂囧瓧 路 浠呬慨鏀硅鑼冨洿"
    : selectedReportBlockIds.length
    ? `已选 ${selectedReportBlockIds.length} 段 · 仅修改此范围`
    : "整篇报告 · 可修改全文";
  reportEditorConversation.replaceChildren();
  const conversation = selectedReportConversation;
  if (!conversation?.messages?.length) {
    const empty = document.createElement("p");
    empty.className = "report-editor-empty";
    empty.textContent = "此处还没有编辑记录。";
    reportEditorConversation.append(empty);
  } else {
    for (const message of conversation.messages) {
      const item = document.createElement("article");
      item.className = `report-editor-message ${message.role}`;
      const label = document.createElement("span");
      label.textContent = message.role === "user"
        ? "你"
        : message.role === "assistant" ? "AI 助手" : "状态";
      const content = document.createElement("div");
      content.textContent = reportEditorMessageText(message);
      item.append(label, content);
      reportEditorConversation.append(item);
    }
  }
  if (reportEditorTransientMessage) {
    const item = document.createElement("article");
    item.className = "report-editor-message event pending";
    const label = document.createElement("span");
    label.textContent = "编辑助手";
    const content = document.createElement("div");
    content.textContent = reportEditorTransientMessage;
    item.append(label, content);
    reportEditorConversation.append(item);
    reportEditorConversation.scrollTop = reportEditorConversation.scrollHeight;
  }
  const showProposal = proposedReportOperation?.state === "proposed";
  reportEditorProposal.hidden = !showProposal;
  reportEditorApply.hidden = !showProposal;
  reportEditorReject.hidden = !showProposal;
  const undoableOperation = reportEditorOperations.find((item) =>
    item.state === "applied" && !item.undoneOperationId
  );
  reportEditorUndo.hidden = !undoableOperation || showProposal;
  reportEditorForm.hidden = reportManualEditing || Boolean(selectedReportVersion);
  setReportEditorBusy(reportEditorBusy);
}

function reportEditorMessageText(message) {
  return message.content;
}

async function applyReportOperation(action) {
  if (!activeTaskId || !proposedReportOperation || reportEditorBusy) return;
  setReportEditorBusy(true);
  try {
    const response = await fetch(
      `/api/tasks/${activeTaskId}/report-editor/operations/${proposedReportOperation.id}/${action}`,
      { method: "POST" },
    );
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 && result.document) {
        reportDocument = result.document;
        activeReportMarkdown = result.document.currentMarkdown;
        reportCitationAudit = result.audit;
      }
      throw new Error(result.error || "无法更新局部修改");
    }
    if (result.document) {
      reportDocument = result.document;
      activeReportMarkdown = result.document.currentMarkdown;
      reportCitationAudit = result.audit;
    }
    proposedReportOperation = undefined;
    await loadReportEditorConversations();
    renderReportDocument();
  } catch (error) {
    showReportEditorError(error instanceof Error ? error.message : String(error));
  } finally {
    setReportEditorBusy(false);
  }
}

function setReportEditorBusy(busy) {
  reportEditorBusy = busy;
  reportEditorSubmit.disabled = busy;
  reportEditorApply.disabled = busy;
  reportEditorReject.disabled = busy;
  reportEditorUndo.disabled = busy;
  reportEditorInstruction.disabled = busy;
  reportEditorManualEdit.disabled = busy;
  reportEditorManualSave.disabled = busy;
  reportEditorManualCancel.disabled = busy;
  if (busy) reportEditorError.hidden = true;
}

function showReportEditorError(message) {
  reportEditorError.textContent = message;
  reportEditorError.hidden = false;
}

function resetWorkspace(topic) {
  if (reportEditorDialog.open) reportEditorDialog.close();
  reportEditorPanelSlot.append(reportEditorPanel);
  reportEditing = false;
  reportManualEditing = false;
  selectedReportVersion = undefined;
  reportEditorVersionReview.hidden = true;
  workspace.hidden = false;
  taskTopic.textContent = topic;
  timeline.replaceChildren();
  steps.clear();
  stepLabels.clear();
  plannedExperts.clear();
  plannedExpertCount = 0;
  expertRoster.hidden = true;
  expertRosterSummary.textContent = "";
  expertRosterList.replaceChildren();
  progressStages.clear();
  researchRuns.clear();
  receivedEvents = 0;
  researchActivityCount = 0;
  sources = 0;
  lastEventId = 0;
  authoritativeSourceCount = undefined;
  activeTaskCreatedAt = undefined;
  activeTaskFinishedAt = undefined;
  eventCount.textContent = "0 个执行节点 · 0 条研究事件";
  eventCount.title = "尚未接收公开事件";
  stepCount.textContent = "0";
  sourceCount.textContent = "0";
  researchElapsed.textContent = "0秒";
  researchElapsed.title = "";
  researchCost.textContent = "未提供";
  researchCost.title = "研究服务未报告模型成本";
  contentAcceptanceState.textContent = "等待中";
  evidenceQualityState.textContent = "等待中";
  activeReportMarkdown = "";
  reportDocument = undefined;
  reportCitationAudit = undefined;
  reportEditing = false;
  selectedReportBlockId = undefined;
  selectedReportBlockIds = [];
  reportEditorConversations = [];
  reportEditorOperations = [];
  selectedReportConversation = undefined;
  proposedReportOperation = undefined;
  reportEditorPanel.hidden = true;
  reportEditButton.hidden = true;
  reportEditorStatus.hidden = true;
  report.replaceChildren();
  report.hidden = true;
  reportEvidencePolicy.hidden = true;
  reportEmpty.hidden = false;
  failure.hidden = true;
  failureTitle.textContent = "任务未完成";
  qualityWarning.hidden = true;
  contentWarningSection.hidden = true;
  contentWarningList.replaceChildren();
  evidenceWarningSection.hidden = true;
  evidenceQualityMetrics.replaceChildren();
  evidenceWarningList.replaceChildren();
  reportActions.hidden = true;
  hideInputRequest();
  setStatus("queued");
}

function renderWorkflowPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return;

  const workflowSteps = plan.steps.filter(
    (step) => step && typeof step.id === "string" && step.id.trim(),
  );
  if (workflowSteps.length === 0) return;

  plannedExperts.clear();
  expertRosterList.replaceChildren();
  const names = new Map(
    workflowSteps.map((step) => [step.id, rosterStepName(step)]),
  );
  const experts = workflowSteps.filter((step) => step.type === "expert");
  const parallelExperts = experts.filter(
    (step) => !Array.isArray(step.dependsOn) || step.dependsOn.length === 0,
  );
  plannedExpertCount = experts.length;
  updateStepCount();
  expertRosterSummary.textContent = experts.length > 0
    ? `${experts.length} 名专家 · ${parallelExperts.length} 项可并行`
    : `${workflowSteps.length} 个流程节点`;

  for (const step of workflowSteps) {
    const item = document.createElement("li");
    item.className = "expert-roster-item pending";
    item.dataset.stepId = step.id;

    const title = document.createElement("div");
    title.className = "expert-roster-title";
    const name = document.createElement("strong");
    name.textContent = rosterStepName(step);
    const status = document.createElement("span");
    status.className = "expert-roster-status";
    status.textContent = "待执行";
    title.append(name, status);

    const meta = document.createElement("div");
    meta.className = "expert-roster-meta";
    const role = document.createElement("span");
    role.textContent = step.role || rosterTypeLabel(step.type);
    meta.append(role);
    const mode = rosterModeLabel(step.mode);
    if (mode) {
      const modeLabel = document.createElement("span");
      modeLabel.textContent = mode;
      meta.append(modeLabel);
    }

    const dependency = document.createElement("p");
    dependency.className = "expert-roster-dependency";
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    dependency.textContent = dependsOn.length === 0
      ? "可直接开始"
      : `依赖：${dependsOn.map((id) => names.get(id) || id).join("、")}`;

    item.append(title, meta, dependency);
    expertRosterList.append(item);
    plannedExperts.set(step.id, { item, status });
  }
  expertRoster.hidden = false;
}

function updateRosterStep(id, status, data) {
  const planned = plannedExperts.get(id);
  if (!planned) return;

  if (typeof data?.stepName === "string" && data.stepName.trim()) {
    planned.item.querySelector(".expert-roster-title strong").textContent =
      data.stepName.trim();
  }
  planned.item.className = `expert-roster-item ${status}`;
  planned.status.textContent = rosterStatusLabel(status);
}

function rosterStepStatus(status) {
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "completed";
}

function rosterStatusLabel(status) {
  return {
    pending: "待执行",
    running: "研究中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
  }[status] || "待执行";
}

function rosterStepName(step) {
  return typeof step?.name === "string" && step.name.trim()
    ? step.name.trim()
    : step.id;
}

function rosterTypeLabel(type) {
  return type === "approval" ? "人工确认" : "人工输入";
}

function rosterModeLabel(mode) {
  return {
    standard: "标准研究",
    deep: "深度研究",
    synthesis: "汇总整合",
  }[mode] || "";
}

function setTaskLifecycle(task) {
  if (typeof task?.createdAt === "string") {
    activeTaskCreatedAt = task.createdAt;
  }
  if (
    isTerminalStatus(task?.status) &&
    typeof task?.updatedAt === "string"
  ) {
    activeTaskFinishedAt = task.updatedAt;
  } else if (!isTerminalStatus(task?.status)) {
    activeTaskFinishedAt = undefined;
  }
  refreshTaskElapsed();
}

function markTaskFinished(timestamp) {
  if (typeof timestamp === "string") {
    activeTaskFinishedAt = timestamp;
  }
  refreshTaskElapsed();
}

function refreshTaskElapsed() {
  const startedAt = Date.parse(activeTaskCreatedAt || "");
  if (!Number.isFinite(startedAt)) return;
  const finishedAt = activeTaskFinishedAt
    ? Date.parse(activeTaskFinishedAt)
    : Date.now();
  if (!Number.isFinite(finishedAt)) return;
  const elapsedMs = Math.max(0, finishedAt - startedAt);
  researchElapsed.textContent = formatDuration(elapsedMs);
  researchElapsed.title = activeTaskFinishedAt
    ? "从任务提交到任务结束的墙钟耗时，包含排队等待"
    : "从任务提交到当前的墙钟耗时，包含排队等待";
}

function upsertStep(id, status, timestamp, detail, label) {
  if (label) stepLabels.set(id, label);
  let item = steps.get(id);
  if (!item) {
    item = addTimeline(
      stepLabels.get(id) || humanizeStep(id),
      status,
      timestamp,
      detail,
    );
    item.dataset.stepId = id;
    steps.set(id, item);
    updateStepCount();
    return;
  }
  item.className = `timeline-item ${status}`;
  item.querySelector(".timeline-title span").textContent =
    stepLabels.get(id) || humanizeStep(id);
  item.querySelector(".timeline-time").textContent = formatTime(timestamp);
  setTimelineDetail(item, detail);
}

function updateStepCount() {
  stepCount.textContent = String(plannedExpertCount || steps.size);
}

function upsertProgress(researchId, stage, timestamp, detail) {
  const key = `${researchId || "research"}:${stage || "progress"}`;
  let item = progressStages.get(key);
  if (!item) {
    item = addTimeline(
      humanizeStage(stage),
      "running",
      timestamp,
      detail,
    );
    item.dataset.researchId = researchId || "";
    progressStages.set(key, item);
    return;
  }
  updateTimelineItem(
    item,
    humanizeStage(stage),
    "running",
    timestamp,
    detail,
  );
}

function completeProgress(researchId) {
  if (!researchId) return;
  for (const item of progressStages.values()) {
    if (item.dataset.researchId === researchId) {
      item.className = "timeline-item completed";
    }
  }
}

function upsertResearchRun(progress, timestamp) {
  if (!progress?.researchRunId) return;
  let run = researchRuns.get(progress.researchRunId);
  if (!run) {
    const title = `${stepLabels.get(progress.aoStepId) || humanizeStep(progress.aoStepId)} · ${
      humanizeResearchPhase(progress.phase)
    }`;
    const status = researchRunStatus(progress.state);
    const detail = researchRunDetail(progress);
    const item = addTimeline(title, status, timestamp, detail);
    item.dataset.researchRunId = progress.researchRunId;
    item.classList.add("research-run-item");
    run = createResearchRunView(item, progress);
    researchRuns.set(progress.researchRunId, run);
  }
  run.progress = {
    ...progress,
    activityCount: Math.max(
      Number(run.progress?.activityCount || 0),
      Number(progress.activityCount || 0),
    ),
  };
  updateResearchRunItem(run, timestamp);
  researchRuns.set(progress.researchRunId, run);
}

function upsertResearchActivity(activity, timestamp) {
  if (!activity?.researchRunId) return;
  let run = researchRuns.get(activity.researchRunId);
  if (!run) {
    upsertResearchRun({
      schemaVersion: 1,
      aoStepId: activity.aoStepId || "research",
      researchRunId: activity.researchRunId,
      mode: "standard",
      state: "running",
      phase: activity.phase || "preparing",
      startedAt: activity.timestamp || timestamp,
      updatedAt: activity.timestamp || timestamp,
      queueWaitMs: 0,
      elapsedMs: 0,
      sourceCount: Number(activity.runSourceCount || 0),
      activityCount: Number(activity.sequence || 0),
      cost: {
        status: "unavailable",
        currency: "USD",
        provenance: "gptr",
        estimated: true,
      },
    }, timestamp);
    run = researchRuns.get(activity.researchRunId);
  }
  if (!run) return;

  const sequence = Number(activity.sequence);
  if (
    Number.isSafeInteger(sequence) &&
    run.activitySequences.has(sequence)
  ) {
    return;
  }
  if (Number.isSafeInteger(sequence)) {
    run.activitySequences.add(sequence);
  }
  run.activities.push(activity);
  run.progress = {
    ...run.progress,
    phase: activity.phase || run.progress.phase,
    updatedAt: activity.timestamp || timestamp,
    sourceCount: Math.max(
      Number(run.progress.sourceCount || 0),
      Number(activity.runSourceCount || 0),
    ),
    activityCount: Math.max(
      Number(run.progress.activityCount || 0),
      Number(activity.sequence || run.activities.length),
    ),
  };
  run.latestActivityAt = activity.timestamp || timestamp;

  appendResearchActivity(run, activity);
  updateResearchRunItem(run, timestamp);
  updateResearchActivityControls(run);

  const nextActivityCount = Number(activity.taskActivityCount);
  if (Number.isFinite(nextActivityCount)) {
    researchActivityCount = Math.max(
      researchActivityCount,
      nextActivityCount,
    );
  } else {
    researchActivityCount += 1;
  }
  const nextSourceCount = Number(activity.taskUniqueSourceCount);
  if (Number.isFinite(nextSourceCount)) {
    authoritativeSourceCount = Math.max(
      authoritativeSourceCount ?? 0,
      nextSourceCount,
    );
    sourceCount.textContent = String(authoritativeSourceCount);
    sourceCount.title = "研究过程中已收集并按 URL 规范化去重的网页来源";
  }
  updateTimelineCounter();
}

function createResearchRunView(item, progress) {
  const preview = document.createElement("div");
  preview.className = "research-activity-preview";
  preview.textContent = "正在等待本轮研究的第一条活动。";

  const controls = document.createElement("div");
  controls.className = "research-activity-controls";
  const toggle = document.createElement("button");
  toggle.className = "research-activity-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const freshness = document.createElement("span");
  freshness.className = "research-activity-freshness";
  freshness.textContent = "等待实时事件";
  controls.append(toggle, freshness);

  const panel = document.createElement("div");
  panel.className = "research-activity-panel";
  panel.hidden = true;
  const panelHeading = document.createElement("div");
  panelHeading.className = "research-activity-panel-heading";
  panelHeading.textContent = "实时研究过程";
  const list = document.createElement("ol");
  list.className = "research-activity-list";
  list.setAttribute("aria-live", "polite");
  panel.append(panelHeading, list);
  item.append(preview, controls, panel);

  const run = {
    item,
    progress,
    activities: [],
    activitySequences: new Set(),
    preview,
    toggle,
    freshness,
    panel,
    list,
    expanded: false,
    latestActivityAt: undefined,
  };
  toggle.addEventListener("click", () => {
    setResearchRunExpanded(run, !run.expanded);
  });
  item.querySelector(".timeline-title")?.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    setResearchRunExpanded(run, !run.expanded);
  });
  updateResearchActivityControls(run);
  return run;
}

function updateResearchRunItem(run, timestamp) {
  const progress = run.progress;
  const title = `${humanizeStep(progress.aoStepId)} · ${
    humanizeResearchPhase(progress.phase)
  }`;
  updateTimelineItem(
    run.item,
    title,
    researchRunStatus(progress.state),
    timestamp,
    researchRunDetail(progress),
  );
  run.item.classList.add("research-run-item");
  updateResearchActivityControls(run);
}

function appendResearchActivity(run, activity) {
  const shouldFollow = isActivityListNearBottom(run.list);
  const item = document.createElement("li");
  item.className = `research-activity research-activity-${activity.kind || "status"}`;

  const meta = document.createElement("div");
  meta.className = "research-activity-meta";
  const kind = document.createElement("span");
  kind.className = "research-activity-kind";
  kind.textContent = researchActivityKindLabel(activity.kind);
  const time = document.createElement("time");
  time.textContent = formatTime(activity.timestamp);
  meta.append(kind, time);

  const message = document.createElement("div");
  message.className = "research-activity-message";
  message.textContent = String(activity.message || "研究过程已更新。");
  item.append(meta, message);

  if (/^https?:\/\//iu.test(activity.sourceUrl || "")) {
    const link = document.createElement("a");
    link.className = "research-activity-source";
    link.href = activity.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开来源 ↗";
    item.append(link);
  }
  run.list.append(item);
  run.preview.textContent = String(activity.message || "研究过程已更新。");
  run.preview.title = run.preview.textContent;

  if (run.expanded && shouldFollow) {
    requestAnimationFrame(() => {
      run.list.scrollTop = run.list.scrollHeight;
    });
  }
}

function updateResearchActivityControls(run) {
  const count = run.activities.length;
  run.toggle.textContent = run.expanded
    ? `收起研究过程（${count} 条）`
    : `展开研究过程（${count} 条）`;
  run.toggle.setAttribute("aria-expanded", String(run.expanded));
  run.panel.hidden = !run.expanded;
  updateResearchActivityFreshness(run);
}

function setResearchRunExpanded(run, expanded) {
  run.expanded = expanded;
  updateResearchActivityControls(run);
  if (expanded) {
    requestAnimationFrame(() => {
      run.list.scrollTop = run.list.scrollHeight;
    });
  }
}

function updateResearchActivityFreshness(run) {
  const count = run.activities.length;
  if (run.progress?.state === "completed") {
    run.freshness.textContent = `已完成 · ${count} 条事件`;
    return;
  }
  if (run.progress?.state === "failed") {
    run.freshness.textContent = `已停止 · ${count} 条事件`;
    return;
  }
  if (run.progress?.state === "running") {
    const elapsed = Math.max(
      0,
      Date.now() - Date.parse(run.progress.startedAt || run.latestActivityAt),
    );
    run.freshness.textContent = `${
      humanizeResearchPhase(run.progress.phase)
    }中 · 已运行 ${formatDuration(elapsed)}`;
    return;
  }
  if (!run.latestActivityAt) {
    run.freshness.textContent = "等待实时事件";
    return;
  }
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(run.latestActivityAt)) / 1_000),
  );
  if (elapsedSeconds < 5) {
    run.freshness.textContent = "实时 · 刚刚更新";
  } else if (elapsedSeconds < 60) {
    run.freshness.textContent = `实时 · ${elapsedSeconds} 秒前更新`;
  } else {
    run.freshness.textContent =
      `仍在运行 · ${Math.floor(elapsedSeconds / 60)} 分钟前更新`;
  }
}

function refreshResearchActivityFreshness() {
  for (const run of researchRuns.values()) {
    updateResearchActivityFreshness(run);
  }
}

function isActivityListNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 48;
}

function researchActivityKindLabel(kind) {
  return {
    status: "状态",
    planning: "规划",
    query: "检索",
    source: "来源",
    fetch: "采集",
    analysis: "分析",
    writing: "写作",
  }[kind] || "进展";
}

function researchRunStatus(state) {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "canceled") return "queued";
  return "running";
}

function researchRunDetail(progress) {
  const details = [
    `${researchModeLabel(progress.mode)}研究`,
    `已运行 ${formatDuration(progress.elapsedMs)}`,
  ];
  if (Number(progress.queueWaitMs) > 0) {
    details.push(`排队 ${formatDuration(progress.queueWaitMs)}`);
  }
  const deep = progress.deep;
  if (deep?.currentLevel && deep?.totalLevels) {
    details.push(`深度 ${deep.currentLevel}/${deep.totalLevels}`);
  }
  if (
    Number.isFinite(deep?.completedQueries) &&
    Number.isFinite(deep?.totalQueries)
  ) {
    details.push(`查询 ${deep.completedQueries}/${deep.totalQueries}`);
  }
  if (progress.sourceCount > 0 || progress.state === "completed") {
    details.push(`${progress.sourceCount || 0} 个来源`);
  }
  if (progress.cost?.status === "reported") {
    details.push(
      `模型报告成本估算 ${formatUsd(progress.cost.amount || 0)}`,
    );
  } else if (progress.state === "completed") {
    details.push("模型成本未提供");
  }
  if (progress.state === "failed") details.push("本轮研究失败");
  if (progress.state === "canceled") details.push("本轮研究已取消");
  return details.join(" · ");
}

function updateResearchMetricsFromRuns() {
  const runs = [...researchRuns.values()].map((run) => run.progress);
  const reported = runs.filter((run) => run.cost?.status === "reported");
  const summary = {
    runCount: runs.length,
    uniqueSourceCount: runs.reduce(
      (total, run) => total + Number(run.sourceCount || 0),
      0,
    ),
    reportedCostUsd: reported.reduce(
      (total, run) => total + Number(run.cost.amount || 0),
      0,
    ),
    reportedCostRuns: reported.length,
    totalElapsedMs: runs.reduce(
      (total, run) => total + Number(run.elapsedMs || 0),
      0,
    ),
  };
  if (authoritativeSourceCount !== undefined) {
    summary.uniqueSourceCount = authoritativeSourceCount;
  }
  updateResearchSummary(
    summary,
    authoritativeSourceCount !== undefined,
  );
}

function updateResearchTelemetry(telemetry, lockExactSources = false) {
  if (!telemetry?.summary) return;
  const telemetrySourceCount = Number(
    telemetry.summary.uniqueSourceCount,
  );
  if (Number.isFinite(telemetrySourceCount)) {
    authoritativeSourceCount = Math.max(
      authoritativeSourceCount ?? 0,
      telemetrySourceCount,
    );
  }
  const telemetryActivityCount = Number(
    telemetry.summary.activityCount,
  );
  if (Number.isFinite(telemetryActivityCount)) {
    researchActivityCount = Math.max(
      researchActivityCount,
      telemetryActivityCount,
    );
  }
  void lockExactSources;
  updateResearchSummary(telemetry.summary, true);
  updateTimelineCounter();
}

function updateResearchSummary(summary, exactSources) {
  const displayedSourceCount = authoritativeSourceCount ??
    Number(summary.uniqueSourceCount || 0);
  sourceCount.textContent = String(displayedSourceCount);
  sourceCount.title = exactSources
    ? "研究过程中已收集并按 URL 规范化去重的网页来源"
    : "研究进行中，各轮来源数暂按合计显示";
  refreshTaskElapsed();
  if (summary.reportedCostRuns > 0) {
    researchCost.textContent = formatUsd(summary.reportedCostUsd || 0);
    researchCost.title =
      `研究服务报告的模型成本估算；${summary.reportedCostRuns}/${summary.runCount} 轮提供了成本`;
  } else {
    researchCost.textContent = "未提供";
    researchCost.title = "研究服务未报告模型成本";
  }
}

function researchModeLabel(mode) {
  return {
    quick: "快速",
    standard: "标准",
    deep: "深度",
    synthesis: "综合",
  }[mode] || "标准";
}

function humanizeResearchPhase(phase) {
  return {
    preparing: "准备研究",
    planning: "规划研究",
    searching: "检索资料",
    collecting: "收集证据",
    analyzing: "分析证据",
    writing: "撰写报告",
    finalizing: "整理报告",
    completed: "研究完成",
    failed: "研究失败",
    canceled: "研究已取消",
  }[phase] || "研究进行中";
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(
    0,
    Math.floor(Number(milliseconds || 0) / 1_000),
  );
  if (totalSeconds === 0) return "0秒";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${hours}小时` : "",
    minutes ? `${minutes}分` : "",
    seconds || (!hours && !minutes) ? `${seconds}秒` : "",
  ].filter(Boolean).join(" ");
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function addTimeline(title, status, timestamp, detail) {
  const shouldFollow = isTimelineNearBottom();
  const item = document.createElement("li");
  item.className = `timeline-item ${status}`;

  const titleRow = document.createElement("div");
  titleRow.className = "timeline-title";
  const titleText = document.createElement("span");
  titleText.textContent = title;
  const time = document.createElement("time");
  time.className = "timeline-time";
  time.textContent = formatTime(timestamp);
  titleRow.append(titleText, time);
  item.append(titleRow);

  setTimelineDetail(item, detail);

  timeline.append(item);
  updateTimelineCounter();
  if (shouldFollow) {
    requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }
  return item;
}

function updateTimelineCounter() {
  const nodeCount = timeline.childElementCount;
  eventCount.textContent =
    `${nodeCount} 个执行节点 · ${researchActivityCount} 条研究事件`;
  eventCount.title =
    `已接收 ${receivedEvents} 条公开事件；研究事件可在对应节点内展开查看`;
}

function updateTimelineItem(item, title, status, timestamp, detail) {
  item.className = `timeline-item ${status}`;
  item.querySelector(".timeline-title span").textContent = title;
  item.querySelector(".timeline-time").textContent = formatTime(timestamp);
  setTimelineDetail(item, detail);
}

function setTimelineDetail(item, detail) {
  let detailNode = item.querySelector(".timeline-detail");
  if (!detail) {
    detailNode?.remove();
    return;
  }
  if (!detailNode) {
    detailNode = document.createElement("div");
    detailNode.className = "timeline-detail";
    item.append(detailNode);
  }
  detailNode.innerHTML = timelineMarkdownRenderer.render(String(detail));
}

function setExportLinks(taskId) {
  exportDocx.href = `/api/tasks/${taskId}/export/docx`;
  exportPdf.href = `/api/tasks/${taskId}/export/pdf`;
  exportMarkdown.href = `/api/tasks/${taskId}/export/markdown`;
}

function isTimelineNearBottom() {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
}

function setStatus(status) {
  const labels = {
    queued: "排队中",
    running: "研究中",
    needs_input: "等待补充信息",
    recoverable: "可恢复",
    completed: "已完成",
    completed_with_warnings: "已完成 · 有警告",
    failed: "未完成",
    canceling: "取消中",
    canceled: "已取消",
  };
  taskStatus.className = `status status-${status}`;
  taskStatus.textContent = labels[status] || status;
  taskStatus.dataset.terminal = isTerminalStatus(status) ? "true" : "false";
  cancelButton.hidden = ![
    "queued",
    "running",
    "needs_input",
    "canceling",
    "recoverable",
  ].includes(status);
  cancelButton.disabled = status === "canceling";
  resumeButton.hidden = status !== "recoverable";
  resumeButton.disabled = false;
}

function isTerminalStatus(status) {
  return [
    "completed",
    "completed_with_warnings",
    "failed",
    "canceled",
  ].includes(status);
}

function showInputRequest(request) {
  activeInputRequest = request;
  inputPrompt.textContent = request.prompt || "请补充研究所需信息";
  inputAnswer.value = "";
  const approval = request.kind === "approval";
  inputAnswer.placeholder = "请输入补充信息";
  inputAnswer.hidden = approval;
  inputAnswer.required = !approval;
  inputSubmit.hidden = approval;
  approvalApprove.hidden = !approval;
  approvalDecline.hidden = !approval;
  inputSubmit.disabled = false;
  approvalApprove.disabled = false;
  approvalDecline.disabled = false;
  inputError.hidden = true;
  inputForm.hidden = false;
  reportEmpty.hidden = true;
  if (approval) {
    approvalApprove.focus();
  } else {
    inputAnswer.focus();
  }
}

function hideInputRequest() {
  activeInputRequest = undefined;
  inputForm.hidden = true;
  inputError.hidden = true;
  if (report.hidden && failure.hidden) {
    reportEmpty.hidden = false;
  }
}

function showFailure(message, title = "任务未完成") {
  reportEmpty.hidden = true;
  report.hidden = true;
  copyButton.hidden = true;
  failure.hidden = false;
  failureTitle.textContent = title;
  failureMessage.textContent = message || "未知错误";
}

function showQualityWarnings(
  contentAcceptance,
  evidenceQuality,
  legacyWarnings = [],
) {
  contentWarningList.replaceChildren();
  evidenceQualityMetrics.replaceChildren();
  evidenceWarningList.replaceChildren();

  const contentWarnings = Array.isArray(contentAcceptance?.warnings)
    ? contentAcceptance.warnings
    : !evidenceQuality ? legacyWarnings : [];
  const evidenceWarnings = Array.isArray(evidenceQuality?.warnings)
    ? evidenceQuality.warnings.map((warning) => warning.message)
    : [];

  renderWarningList(contentWarningList, contentWarnings);
  renderWarningList(evidenceWarningList, evidenceWarnings);
  contentWarningSection.hidden = contentWarnings.length === 0;
  evidenceWarningSection.hidden = evidenceWarnings.length === 0;

  if (evidenceWarnings.length > 0 && evidenceQuality?.metrics) {
    for (const [label, value] of evidenceMetricSummaries(
      evidenceQuality.metrics,
    )) {
      const metric = document.createElement("div");
      metric.className = "evidence-quality-metric";
      metric.textContent = `${label}：${value}`;
      evidenceQualityMetrics.append(metric);
    }
  }

  if (contentWarnings.length === 0 && evidenceWarnings.length === 0) {
    qualityWarning.hidden = true;
    return;
  }
  qualityWarning.hidden = false;
}

function updateReportEvidencePolicy(policy) {
  const labels = {
    public_verified: "本报告基于本次收集的公开可核验来源。",
    private_bounded: "本报告基于受限资料；不包含可公开核验的外部引用。",
    mixed_evidence: "本报告同时使用公开来源与受限资料，二者已分开标注。",
  };
  const message = labels[policy?.strategy];
  reportEvidencePolicy.hidden = !message;
  reportEvidencePolicy.textContent = message || "";
}

function renderWarningList(list, warnings) {
  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    list.append(item);
  }
}

function updateQualityStates(contentAcceptance, evidenceQuality) {
  if (contentAcceptance) {
    contentAcceptanceState.textContent =
      contentAcceptance.status === "warning" ? "有未满足项" : "已通过";
  }
  if (evidenceQuality) {
    evidenceQualityState.textContent =
      evidenceQuality.status === "warning" ? "有警告" : "已通过";
  }
}

function evidenceMetricSummaries(metrics) {
  const sourceTypes = metrics.sourceTypes || {};
  const typeLabels = {
    government: "政府",
    academic: "学术",
    organization: "组织",
    commercial: "商业",
    other: "其他",
  };
  const types = Object.entries(sourceTypes)
    .filter(([, count]) => Number(count) > 0)
    .map(([type, count]) => `${typeLabels[type] || type} ${count}`)
    .join("、") || "无";
  return [
    [
      "引用覆盖率",
      formatQualityRatio(metrics.citationCoverage?.ratio),
    ],
    [
      "有效链接率",
      formatQualityRatio(metrics.validLinkRate?.ratio),
    ],
    [
      "来源去重",
      `${metrics.sourceDeduplication?.uniquePublicSources || 0}/${metrics.sourceDeduplication?.observedPublicSources || 0} 个独立来源`,
    ],
    [
      "域名多样性",
      `${metrics.domainDiversity?.uniqueDomains || 0} 个域名`,
    ],
    ["来源类型", types],
  ];
}

function formatQualityRatio(value) {
  return typeof value === "number"
    ? `${Number((value * 100).toFixed(1))}%`
    : "不适用";
}

function setSubmitting(value) {
  submitButton.disabled = value;
  submitButton.querySelector("span").textContent = value
    ? "研究进行中"
    : "开始研究";
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.hidden = true;
  formError.textContent = "";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function humanizeStep(id) {
  return id
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function stepLabel(data) {
  const label = data?.stepName || data?.agentName;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

function humanizeStage(stage) {
  const labels = {
    logs: "研究进展",
    starting_research: "启动研究",
    agent_generated: "加载专家身份",
    planning_research: "规划研究",
    subqueries: "生成检索子问题",
    running_subquery_research: "研究子问题",
    research_plan: "制定研究计划",
    searching: "搜索资料",
    scraping_urls: "抓取网页",
    scraping_content: "整理网页内容",
    scraping_images: "筛选图片",
    scraping_complete: "网页抓取完成",
    fetching_query_content: "提取查询内容",
    context_combined: "合并研究上下文",
    research_step_finalized: "完成研究步骤",
    images: "整理候选图片",
    researching: "分析证据",
    research_progress: "研究进度",
    writing_report: "撰写报告",
    report_written: "报告撰写完成",
    added_source_url: "收集来源",
    subquery_context_not_found: "子问题暂无上下文",
    context_not_found: "暂无可用上下文",
    "gptr.report.normalized": "报告清理",
    "gptr.citations.normalized": "引用校正",
  };
  return labels[stage] ||
    String(stage || "研究进展").replaceAll("_", " ");
}

function shortPath(path) {
  return String(path || "").split(/[\\/]/).at(-1) || "workflow.yaml";
}
