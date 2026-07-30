const form = document.querySelector("#research-form");
const topicInput = document.querySelector("#topic");
const submitButton = document.querySelector("#submit-button");
const cancelButton = document.querySelector("#cancel-button");
const formError = document.querySelector("#form-error");
const sourceMode = document.querySelector("#source-mode");
const sourceUrls = document.querySelector("#source-urls");
const sourceUrlsField = document.querySelector("#source-urls-field");
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
const reportEmpty = document.querySelector("#report-empty");
const report = document.querySelector("#report");
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
const exportDocx = document.querySelector("#export-docx");
const exportPdf = document.querySelector("#export-pdf");
const exportMarkdown = document.querySelector("#export-markdown");
const inputForm = document.querySelector("#input-form");
const inputPrompt = document.querySelector("#input-prompt");
const inputAnswer = document.querySelector("#input-answer");
const inputError = document.querySelector("#input-error");
const serviceState = document.querySelector(".service-state");
const serviceLabel = document.querySelector("#service-label");
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
let activeReportMarkdown = "";
let receivedEvents = 0;
let researchActivityCount = 0;
let sources = 0;
let lastEventId = 0;
let authoritativeSourceCount;
const steps = new Map();
const progressStages = new Map();
const researchRuns = new Map();
let retrieverCapabilities = [{
  id: "duckduckgo",
  label: "DuckDuckGo",
  category: "web",
  selectable: true,
}];
let maxRetrievers = 1;
let defaultRetrievers = ["duckduckgo"];

checkHealth();
restoreActiveTask();
renderRetrieverControls();
refreshResearchSettings();
updateResearchSourceFields();
setInterval(refreshResearchActivityFreshness, 1_000);

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
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        ...(researchProfile ? { researchProfile } : {}),
      }),
    });
    const task = await response.json();
    if (!response.ok) {
      throw new Error(task.error || "任务提交失败");
    }

    activeTaskId = task.id;
    localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, activeTaskId);
    setStatus(task.status);
    connectEvents(task.id);
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setSubmitting(false);
    showError(error instanceof Error ? error.message : String(error));
  }
});

function updateResearchSourceFields() {
  const usesUrls = sourceMode.value !== "web";
  const usesWeb = sourceMode.value !== "urls";
  sourceUrlsField.hidden = !usesUrls;
  includeDomainsField.hidden = !usesWeb;
  excludeDomainsField.hidden = !usesWeb;
  taskRetrieversField.hidden = !usesWeb;
  sourceUrls.required = usesUrls;
}

function buildResearchProfile() {
  const include = parseDomainList(includeDomains.value);
  const exclude = parseDomainList(excludeDomains.value);
  const retrievers = selectedRetrievers(taskRetrievers);
  const usesWeb = sourceMode.value !== "urls";
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

inputForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = inputAnswer.value.trim();
  if (!answer || !activeTaskId) return;

  const button = inputForm.querySelector("button");
  button.disabled = true;
  inputError.hidden = true;
  try {
    const response = await fetch(`/api/tasks/${activeTaskId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "补充信息提交失败");
    }
  } catch (error) {
    inputError.textContent =
      error instanceof Error ? error.message : String(error);
    inputError.hidden = false;
    button.disabled = false;
  }
});

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

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsError.hidden = true;
  settingsSaved.hidden = true;
  const values = Object.fromEntries(new FormData(settingsForm));
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
    setStatus(task.status);
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
    "task.canceling",
    "task.canceled",
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
      addTimeline(
        "专家工作流已生成",
        "completed",
        event.timestamp,
        shortPath(event.data.workflowPath),
      );
      break;
    case "step.started":
      upsertStep(event.data.stepId, "running", event.timestamp);
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
      const verification = event.data.verification;
      upsertStep(
        event.data.stepId,
        event.data.status === "failed" ? "failed" : "completed",
        event.timestamp,
        verification
          ? `验收${verification.pass ? "通过" : "未通过"}${verification.reworked ? " · 已返工" : ""}`
          : undefined,
      );
      if (verification) {
        contentAcceptanceState.textContent = verification.pass
          ? verification.reworked ? "返工后通过" : "已通过"
          : "未通过";
      }
      break;
    }
    case "task.completed":
      setStatus("completed");
      addTimeline("研究任务完成", "completed", event.timestamp);
      eventSource?.close();
      loadTask(activeTaskId);
      break;
    case "task.completed_with_warnings":
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
      setStatus("failed");
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
      report.innerHTML = markdownRenderer.render(activeReportMarkdown);
      report.hidden = false;
      reportEmpty.hidden = true;
      failure.hidden = true;
      setExportLinks(task.id);
      reportActions.hidden = false;
      updateQualityStates(task.contentAcceptance, task.evidenceQuality);
      showQualityWarnings(
        task.contentAcceptance,
        task.evidenceQuality,
        task.warnings || [],
      );
    } else if (task.status === "failed") {
      showFailure(task.error);
    } else if (task.status === "canceled") {
      showFailure(task.error || "当前研究任务已取消。", "任务已取消");
    }
  } catch (error) {
    showFailure(error instanceof Error ? error.message : String(error));
  } finally {
    setSubmitting(false);
  }
}

function resetWorkspace(topic) {
  workspace.hidden = false;
  taskTopic.textContent = topic;
  timeline.replaceChildren();
  steps.clear();
  progressStages.clear();
  researchRuns.clear();
  receivedEvents = 0;
  researchActivityCount = 0;
  sources = 0;
  lastEventId = 0;
  authoritativeSourceCount = undefined;
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
  report.replaceChildren();
  report.hidden = true;
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

function upsertStep(id, status, timestamp, detail) {
  let item = steps.get(id);
  if (!item) {
    item = addTimeline(humanizeStep(id), status, timestamp, detail);
    item.dataset.stepId = id;
    steps.set(id, item);
    stepCount.textContent = String(steps.size);
    return;
  }
  item.className = `timeline-item ${status}`;
  item.querySelector(".timeline-time").textContent = formatTime(timestamp);
  setTimelineDetail(item, detail);
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
    const title = `${humanizeStep(progress.aoStepId)} · ${
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
  researchElapsed.textContent = formatDuration(summary.totalElapsedMs);
  researchElapsed.title = "各轮研究执行耗时之和，不包含排队等待";
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
  ].includes(status);
  cancelButton.disabled = status === "canceling";
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
  inputPrompt.textContent = request.prompt || "请补充研究所需信息";
  inputAnswer.value = "";
  inputAnswer.placeholder =
    request.kind === "approval" ? "请输入 yes 或 no" : "请输入补充信息";
  inputForm.querySelector("button").disabled = false;
  inputError.hidden = true;
  inputForm.hidden = false;
  reportEmpty.hidden = true;
  inputAnswer.focus();
}

function hideInputRequest() {
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
