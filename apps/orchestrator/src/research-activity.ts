export type ResearchPhase =
  | "preparing"
  | "planning"
  | "searching"
  | "collecting"
  | "analyzing"
  | "writing"
  | "finalizing"
  | "completed"
  | "failed"
  | "canceled";

export type ResearchActivityKind =
  | "status"
  | "planning"
  | "query"
  | "source"
  | "fetch"
  | "analysis"
  | "writing";

export interface ResearchActivity {
  schemaVersion: 1;
  aoStepId: string;
  researchRunId: string;
  sequence: number;
  timestamp: string;
  phase: ResearchPhase;
  kind: ResearchActivityKind;
  message: string;
  sourceUrl?: string;
  runSourceCount: number;
  taskUniqueSourceCount: number;
  taskActivityCount: number;
}

export interface ResearchActivityContext {
  aoStepId: string;
  researchRunId: string;
  phase: ResearchPhase;
}

export interface RawResearchActivityEvent {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

const PUBLIC_ACTIVITY_STAGES = new Set([
  "research.mode.selected",
  "research.budget.adjusted",
  "research.budget.waited",
  "source.validation_started",
  "source.materialized",
  "source.unavailable",
  "source.web_supplement_started",
  "source.domain_filtered",
  "retriever.configured",
  "retriever.query_started",
  "retriever.summary",
  "retriever.degraded",
  "starting_research",
  "agent_generated",
  "planning_research",
  "subqueries",
  "research_plan",
  "searching",
  "running_subquery_research",
  "scraping_urls",
  "scraping_content",
  "scraping_images",
  "scraping_complete",
  "added_source_url",
  "fetching_query_content",
  "researching",
  "research_progress",
  "context_combined",
  "subquery_context_not_found",
  "context_not_found",
  "deep_research.initialize",
  "deep_research.progress",
  "deep_research.complete",
  "synthesis.started",
  "synthesis.completed",
  "images",
  "writing_report",
  "report_written",
  "research_step_finalized",
  "gptr.report.normalized",
  "gptr.citations.normalized",
]);

export class ResearchActivityProjector {
  readonly #maxActivitiesPerRun: number;
  readonly #fingerprints = new Map<string, Set<string>>();
  readonly #runActivityCounts = new Map<string, number>();
  readonly #runSources = new Map<string, Set<string>>();
  readonly #taskSources = new Set<string>();
  #taskActivityCount = 0;

  constructor(maxActivitiesPerRun = 250) {
    this.#maxActivitiesPerRun = Number.isFinite(maxActivitiesPerRun)
      ? Math.max(1, Math.trunc(maxActivitiesPerRun))
      : 250;
  }

  observe(
    event: RawResearchActivityEvent,
    context: ResearchActivityContext,
  ): ResearchActivity | undefined {
    const stage = semanticResearchStage(event);
    const sourceUrl = [
        "added_source_url",
        "source.materialized",
      ].includes(stage)
      ? sourceUrlFromEvent(event)
      : undefined;
    if (sourceUrl) {
      this.#sourcesForRun(context.researchRunId).add(sourceUrl);
      this.#taskSources.add(sourceUrl);
    }
    if (!PUBLIC_ACTIVITY_STAGES.has(stage)) return undefined;

    const message = sourceUrl
      ? stage === "source.materialized"
        ? `已读取指定来源：${sourceLabel(sourceUrl)}`
        : `已收集来源：${sourceLabel(sourceUrl)}`
      : summarizeResearchEvent(event);
    if (!message) return undefined;

    const fingerprints = this.#fingerprints.get(context.researchRunId) ??
      new Set<string>();
    const fingerprint = JSON.stringify({ stage, message, sourceUrl });
    if (fingerprints.has(fingerprint)) return undefined;
    fingerprints.add(fingerprint);
    this.#fingerprints.set(context.researchRunId, fingerprints);

    const currentCount = this.runActivityCount(context.researchRunId);
    if (currentCount >= this.#maxActivitiesPerRun) return undefined;
    const sequence = currentCount + 1;
    this.#runActivityCounts.set(context.researchRunId, sequence);
    this.#taskActivityCount += 1;

    return {
      schemaVersion: 1,
      aoStepId: context.aoStepId,
      researchRunId: context.researchRunId,
      sequence,
      timestamp: event.timestamp,
      phase: context.phase,
      kind: activityKind(stage),
      message: boundedActivityMessage(message),
      ...(sourceUrl ? { sourceUrl } : {}),
      runSourceCount: this.runSourceCount(context.researchRunId),
      taskUniqueSourceCount: this.taskUniqueSourceCount,
      taskActivityCount: this.#taskActivityCount,
    };
  }

  reconcileSourceUrls(
    researchRunId: string,
    values: readonly string[],
  ): void {
    const runSources = this.#sourcesForRun(researchRunId);
    for (const value of values) {
      const sourceUrl = normalizedSourceUrl(value);
      if (!sourceUrl) continue;
      runSources.add(sourceUrl);
      this.#taskSources.add(sourceUrl);
    }
  }

  runActivityCount(researchRunId: string): number {
    return this.#runActivityCounts.get(researchRunId) ?? 0;
  }

  runSourceCount(researchRunId: string): number {
    return this.#runSources.get(researchRunId)?.size ?? 0;
  }

  get taskActivityCount(): number {
    return this.#taskActivityCount;
  }

  get taskUniqueSourceCount(): number {
    return this.#taskSources.size;
  }

  #sourcesForRun(researchRunId: string): Set<string> {
    const existing = this.#runSources.get(researchRunId);
    if (existing) return existing;
    const sources = new Set<string>();
    this.#runSources.set(researchRunId, sources);
    return sources;
  }
}

export function semanticResearchStage(
  event: { type: string; data: Record<string, unknown> },
): string {
  const content = event.data.content;
  return event.type === "logs" &&
      typeof content === "string" &&
      content.trim()
    ? content.trim()
    : event.type;
}

export function summarizeResearchEvent(
  event: { type: string; data: Record<string, unknown> },
): string {
  const stage = semanticResearchStage(event);
  const { data } = event;
  const candidate = data.output ?? data.message ?? data.content ?? data;
  const text = typeof candidate === "string"
    ? candidate
    : JSON.stringify(candidate) ?? "";
  const normalized = text
    .replace(/<runtime_context>[\s\S]*?<\/runtime_context>/giu, "")
    .replace(
      /<expert_system_prompt>[\s\S]*?<\/expert_system_prompt>/giu,
      "",
    )
    .replace(/<task>[\s\S]*?<\/task>/giu, "")
    .replace(/<citation_contract>[\s\S]*?<\/citation_contract>/giu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return localizeResearchProgress(stage, normalized, data);
}

export function localizeResearchProgress(
  stage: string,
  message: string,
  data: Record<string, unknown> = {},
): string {
  const fixedMessages: Readonly<Record<string, string>> = {
    starting_research: "正在启动本轮研究。",
    agent_generated: "已加载本轮研究所需的专家身份。",
    planning_research: "正在规划检索路径与研究步骤。",
    subqueries: "已生成本轮子问题与检索查询。",
    research_plan: "本轮研究计划已生成。",
    searching: "正在检索与当前问题相关的资料。",
    researching: "正在综合多个来源中的相关信息。",
    research_progress: "正在推进当前研究与证据分析。",
    scraping_complete: "网页内容抓取完成。",
    fetching_query_content: "正在提取当前查询对应的相关内容。",
    images: "已整理本轮研究发现的候选图片。",
    writing_report: "正在根据研究证据撰写报告。",
    report_written: "报告已完成，正在整理引用与交付内容。",
    "source.web_supplement_started": "指定来源已读取，正在补充检索网页证据。",
  };
  if (fixedMessages[stage]) {
    return fixedMessages[stage];
  }
  if (/^(?:subquery_)?context_not_found$/iu.test(stage)) {
    return "当前子问题未找到可用上下文，将继续使用其他检索结果。";
  }
  if (stage === "source.validation_started") {
    const sourceCount = numberFromObject(data, "sourceCount");
    return sourceCount !== undefined
      ? `正在校验并读取 ${sourceCount} 个指定来源。`
      : "正在校验并读取指定来源。";
  }
  if (stage === "source.unavailable") {
    return "一个指定来源暂时不可用，研究将按来源策略继续。";
  }
  if (stage === "source.domain_filtered") {
    const rejected = numberFromObject(data, "rejectedCount");
    return rejected !== undefined
      ? `已按域名规则排除 ${rejected} 条检索结果。`
      : "已按域名规则过滤检索结果。";
  }
  if (stage === "retriever.configured") {
    const retrievers = stringArrayFromObject(data, "retrievers");
    const labels = retrievers.map(retrieverLabel);
    return labels.length > 0
      ? `已启用 ${labels.length} 个检索器：${labels.join("、")}。`
      : "检索器已就绪，正在开始资料检索。";
  }
  if (stage === "retriever.degraded") {
    const retriever = typeof data.retriever === "string"
      ? retrieverLabel(data.retriever)
      : "一个检索器";
    const status = data.status;
    return status === "timed_out"
      ? `${retriever} 检索超时，本轮已使用其他来源继续研究。`
      : `${retriever} 暂时不可用，本轮已使用其他来源继续研究。`;
  }
  if (stage === "retriever.query_started") {
    const retriever = typeof data.retriever === "string"
      ? retrieverLabel(data.retriever)
      : "检索器";
    return `${retriever} 正在查询相关资料。`;
  }
  if (stage === "retriever.summary") {
    const accepted = numberFromObject(data, "accepted");
    const duplicates = numberFromObject(data, "duplicates");
    const rejected = numberFromObject(data, "domainRejected");
    if (
      accepted !== undefined &&
      duplicates !== undefined &&
      rejected !== undefined
    ) {
      return (
        `检索完成：保留 ${accepted} 条结果，` +
        `去除 ${duplicates} 条重复结果，` +
        `按域名规则排除 ${rejected} 条。`
      );
    }
    return "本轮多来源检索已完成。";
  }
  if (stage === "research.mode.selected") {
    const mode = data.effectiveMode;
    if (mode === "deep") {
      const deep = objectFromProgressData(data.deep);
      const breadth = numberFromObject(deep, "breadth");
      const depth = numberFromObject(deep, "depth");
      const concurrency = numberFromObject(deep, "concurrency");
      return breadth !== undefined &&
          depth !== undefined &&
          concurrency !== undefined
        ? `已选择深度研究模式（广度 ${breadth}、深度 ${depth}、并发 ${concurrency}）。`
        : "已选择深度研究模式。";
    }
    return mode === "synthesis"
      ? "已选择综合模式，将复用上游研究材料。"
      : "已选择标准研究模式。";
  }
  if (stage === "research.budget.adjusted") {
    const capacity = numberFromObject(data, "capacity");
    const requested = numberFromObject(data, "requestedWeight");
    const effective = numberFromObject(data, "effectiveWeight");
    return capacity !== undefined &&
        requested !== undefined &&
        effective !== undefined
      ? `研究并发已按任务预算从 ${requested} 调整为 ${effective}（总预算 ${capacity}）。`
      : "研究并发已按任务预算自动调整。";
  }
  if (stage === "research.budget.waited") {
    const waitedMs = numberFromObject(data, "waitedMs");
    return waitedMs !== undefined
      ? `研究已等待任务并发预算 ${waitedMs} 毫秒后开始。`
      : "研究已等待任务并发预算后开始。";
  }
  if (stage === "deep_research.initialize") {
    const breadth = numberFromObject(data, "breadth");
    const depth = numberFromObject(data, "depth");
    return breadth !== undefined && depth !== undefined
      ? `正在初始化深度研究（广度 ${breadth}、深度 ${depth}）。`
      : "正在初始化深度研究。";
  }
  if (stage === "deep_research.progress") {
    const currentDepth = numberFromObject(data, "currentDepth");
    const totalDepth = numberFromObject(data, "totalDepth");
    const currentBreadth = numberFromObject(data, "currentBreadth");
    const totalBreadth = numberFromObject(data, "totalBreadth");
    return currentDepth !== undefined &&
        totalDepth !== undefined &&
        currentBreadth !== undefined &&
        totalBreadth !== undefined
      ? `深度研究进度：深度 ${currentDepth}/${totalDepth}，当前分支 ${currentBreadth}/${totalBreadth}。`
      : "深度研究正在扩展和汇总分支。";
  }
  if (stage === "deep_research.complete") {
    return "深度研究分支已完成，正在撰写报告。";
  }
  if (stage === "synthesis.started") {
    return "正在基于上游研究材料综合报告，不再重复检索。";
  }
  if (stage === "synthesis.completed") {
    return "上游研究材料已综合完成。";
  }

  const countMatch = (pattern: RegExp): string | undefined =>
    message.match(pattern)?.[1];
  if (stage === "scraping_urls") {
    const count = countMatch(/Scraping content from\s+(\d+)\s+URLs?/iu);
    return count !== undefined
      ? `正在抓取 ${count} 个网页链接。`
      : "正在抓取网页内容。";
  }
  if (stage === "scraping_content") {
    const count = countMatch(/Scraped\s+(\d+)\s+pages?\s+of content/iu);
    return count !== undefined
      ? `已整理 ${count} 个网页的内容。`
      : "网页内容已整理。";
  }
  if (stage === "scraping_images") {
    const match = message.match(
      /Selected\s+(\d+)\s+new images\s+from\s+(\d+)\s+total images/iu,
    );
    return match
      ? `已从 ${match[2]} 张候选图片中选出 ${match[1]} 张。`
      : "候选图片筛选完成。";
  }
  if (stage === "running_subquery_research") {
    const query = message.match(/Running research for\s+['"](.+?)['"]/iu)?.[1];
    return query && !/Follow the expert identity/iu.test(query)
      ? `正在研究子问题：${query}。`
      : "正在研究当前子问题。";
  }
  if (stage === "added_source_url") {
    const url = message.match(/https?:\/\/[^\s"'<>]+/iu)?.[0];
    return url ? `已收集来源：${url}` : "已收集一个研究来源。";
  }
  if (stage === "context_combined") {
    return "研究上下文已合并。";
  }
  if (stage === "research_step_finalized") {
    const rawCost = message.match(
      /Total Research Costs?:\s*\$([0-9.]+)/iu,
    )?.[1];
    const parsedCost = rawCost ? Number(rawCost) : Number.NaN;
    const cost = Number.isFinite(parsedCost)
      ? parsedCost.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")
      : undefined;
    return cost
      ? `研究步骤已完成。\n累计研究成本：$${cost}。`
      : "研究步骤已完成。";
  }
  if (stage === "gptr.report.normalized") {
    const original = numberFromProgressData(data, message, "originalCharacters");
    const report = numberFromProgressData(data, message, "reportCharacters");
    return original !== undefined && report !== undefined
      ? `报告内容已清理：从 ${original} 个字符整理为 ${report} 个字符。`
      : "报告内容已完成清理。";
  }
  if (stage === "gptr.citations.normalized") {
    const replacements = numberFromProgressData(data, message, "replacements");
    return replacements !== undefined
      ? `已校正 ${replacements} 处引用链接。`
      : "引用链接已完成校正。";
  }

  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function normalizedSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim().replace(/[),.;!?，。；！？]+$/u, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sourceUrlFromEvent(
  event: RawResearchActivityEvent,
): string | undefined {
  const candidates = [
    event.data.metadata,
    event.data.url,
    event.data.output,
    event.data.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/https?:\/\/[^\s"'<>]+/iu)?.[0];
    const normalized = normalizedSourceUrl(match ?? candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function sourceLabel(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./iu, "");
  } catch {
    return "网页来源";
  }
}

function activityKind(stage: string): ResearchActivityKind {
  if (
    [
      "planning_research",
      "subqueries",
      "research_plan",
    ].includes(stage)
  ) {
    return "planning";
  }
  if (
    [
      "searching",
      "running_subquery_research",
      "retriever.configured",
      "retriever.query_started",
      "retriever.degraded",
    ].includes(stage)
  ) {
    return "query";
  }
  if (
    stage === "added_source_url" ||
    stage === "source.materialized"
  ) {
    return "source";
  }
  if (
    stage.startsWith("scraping_") ||
    stage === "fetching_query_content" ||
    stage === "images"
  ) {
    return "fetch";
  }
  if (
    stage === "writing_report" ||
    stage === "report_written" ||
    stage === "research_step_finalized" ||
    stage.startsWith("gptr.")
  ) {
    return "writing";
  }
  if (
    stage === "researching" ||
    stage === "research_progress" ||
    stage === "context_combined" ||
    stage.includes("context_not_found") ||
    stage.startsWith("deep_research.") ||
    stage.startsWith("synthesis.")
  ) {
    return "analysis";
  }
  return "status";
}

function boundedActivityMessage(value: string): string {
  const normalized = value.replace(/\n{3,}/gu, "\n\n").trim();
  return normalized.length > 500
    ? `${normalized.slice(0, 497)}...`
    : normalized;
}

function objectFromProgressData(
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberFromObject(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const result = value[key];
  return typeof result === "number" && Number.isFinite(result)
    ? result
    : undefined;
}

function stringArrayFromObject(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const candidate = value[key];
  return Array.isArray(candidate)
    ? candidate.filter(
      (item): item is string => typeof item === "string",
    )
    : [];
}

function safeCapabilityName(value: unknown, fallback: string): string {
  return typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : fallback;
}

function retrieverLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    duckduckgo: "DuckDuckGo",
    tavily: "Tavily",
    arxiv: "arXiv",
    openalex: "OpenAlex",
    semantic_scholar: "Semantic Scholar",
    pubmed_central: "PubMed Central",
  };
  return labels[value] ?? value;
}

function numberFromProgressData(
  data: Record<string, unknown>,
  message: string,
  key: string,
): number | undefined {
  const direct = data[key];
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
