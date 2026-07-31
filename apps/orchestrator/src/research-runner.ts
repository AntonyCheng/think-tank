import { resolve } from "node:path";

import {
  parseWorkflow,
  type WorkflowResult,
} from "agency-orchestrator";

import {
  agentsDirForLanguage,
  collectWorkflowInputRequests,
  runWorkflowFile,
  type WorkflowRuntimeEvent,
} from "./ao-runtime.js";
import {
  normalizeFinalCitations,
  type VerifiedCitation,
} from "./citations.js";
import {
  type EvidenceBundle,
  EvidenceLedger,
} from "./evidence-bundle.js";
import {
  assessEvidenceQuality,
  type EvidenceQualityAssessment,
} from "./evidence-quality.js";
import { researchCompositionDescription } from "./research-compose.js";
import { createRuntimeConnector } from "./runtime-connector.js";
import {
  settingsFromEnv,
  type RuntimeSettings,
} from "./settings.js";
import {
  createTaskTemporalContext,
  resolveRelativeYearScope,
} from "./task-temporal-context.js";
import { composeValidatedWorkflow } from "./workflow-composer.js";
import {
  resolveWorkflowResearchProfiles,
} from "./research-profile-mapping.js";
import type {
  ResearchCapabilities,
  ResearchProfile,
} from "./research-profile.js";
import { defaultResearchProfile } from "./research-profile-runtime.js";
import {
  ResearchTelemetryTracker,
  type ResearchActivity,
  type ResearchDiagnosticRecord,
  type ResearchRunIdentity,
  type ResearchRunProgress,
  type ResearchTelemetrySnapshot,
  type ResearchTelemetryUpdate,
} from "./research-telemetry.js";

export type ResearchRunnerEvent =
  | {
      type: "workflow.composed";
      timestamp: string;
      workflowPath: string;
      warnings: string[];
      researchProfiles?: Record<string, ResearchProfile>;
    }
  | {
      type: "gptr.completed";
      timestamp: string;
      researchId: string;
      sourceCount: number;
      cost: unknown;
      researchProfile?: ResearchProfile;
    }
  | {
      type: "evidence.bundle.recorded";
      timestamp: string;
      bundle: EvidenceBundle;
    }
  | {
      type: "gptr.progress";
      timestamp: string;
      researchId: string;
      stage: string;
      message: string;
    }
  | {
      type: "research.progress" | "research.completed" | "research.failed";
      timestamp: string;
      progress: ResearchRunProgress;
      telemetry: ResearchTelemetrySnapshot;
    }
  | {
      type: "research.activity";
      timestamp: string;
      activity: ResearchActivity;
      telemetry: ResearchTelemetrySnapshot;
    }
  | {
      type: "research.diagnostic";
      timestamp: string;
      diagnostic: ResearchDiagnosticRecord;
    }
  | {
      type: "gptr.rework_rejected";
      timestamp: string;
      message: string;
    }
  | WorkflowRuntimeEvent;

export interface ResearchRunResult {
  workflowPath: string;
  output: string;
  workflow: WorkflowResult;
  evidenceBundles?: EvidenceBundle[];
  citations?: VerifiedCitation[];
  citationWarnings?: string[];
  evidenceQuality?: EvidenceQualityAssessment;
  researchTelemetry?: ResearchTelemetrySnapshot;
}

export interface ResearchRunnerOptions {
  settings?: RuntimeSettings;
  onEvent?: (event: ResearchRunnerEvent) => void;
  requestInput?: (request: {
    stepId: string;
    kind: "workflow_input" | "human_input" | "approval";
    prompt: string;
  }) => Promise<string>;
  signal?: AbortSignal;
  researchProfile?: ResearchProfile;
  researchCapabilities?: ResearchCapabilities;
}

export async function runResearchTopic(
  topic: string,
  options: ResearchRunnerOptions = {},
): Promise<ResearchRunResult> {
  const settings = options.settings ?? settingsFromEnv();
  const fallbackPolicy = defaultResearchProfile(settings.retrievers);
  const taskProfile = options.researchProfile ?? fallbackPolicy.profile;
  const capabilities = options.researchCapabilities ??
    fallbackPolicy.capabilities;
  const temporalContext = createTaskTemporalContext(
    new Date(),
    settings.timeZone,
  );
  const relativeYearScope = resolveRelativeYearScope(topic, temporalContext);
  const lang = /[\u3400-\u9fff]/u.test(topic) ? "zh" : "en";
  const agentsDir = agentsDirForLanguage(lang);

  options.signal?.throwIfAborted();
  const healthTimeout = AbortSignal.timeout(settings.gptrHealthTimeoutMs);
  let health: Response;
  try {
    health = await fetch(new URL("/health", settings.gptrServiceUrl), {
      signal: options.signal
        ? AbortSignal.any([options.signal, healthTimeout])
        : healthTimeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (healthTimeout.aborted) {
      throw new Error("GPT Researcher 健康检查超时。");
    }
    throw error;
  }
  if (!health.ok) {
    throw new Error(
      `GPT Researcher service is unavailable (${health.status}).`,
    );
  }

  const composed = await composeValidatedWorkflow({
    description: researchCompositionDescription(
      topic,
      temporalContext,
      taskProfile,
      capabilities,
    ),
    agentsDir,
    agentsDirName: lang === "zh" ? "agency-agents-zh" : "agency-agents",
    llmConfig: settings.planner,
    autoRun: true,
    timeoutMs: settings.gptrResearchTimeoutMs + settings.gptrCleanupGraceMs,
    lang,
    saveDir: resolve(".think-tank", "workflows"),
  }, undefined, { taskProfile, capabilities }, relativeYearScope);
  options.signal?.throwIfAborted();

  const workflowDefinition = parseWorkflow(composed.savedPath);
  const researchProfiles = resolveWorkflowResearchProfiles(
    workflowDefinition,
    taskProfile,
    capabilities,
  );
  options.onEvent?.({
    type: "workflow.composed",
    timestamp: new Date().toISOString(),
    workflowPath: composed.savedPath,
    warnings: composed.warnings,
    researchProfiles: Object.fromEntries(researchProfiles),
  });

  const workflowInputs: Record<string, string> = {};
  for (
    const request of collectWorkflowInputRequests(
      workflowDefinition,
      workflowInputs,
    )
  ) {
    if (!options.requestInput) {
      throw new Error(
        `AO workflow requires user input at "${request.stepId}".`,
      );
    }
    const answer = await options.requestInput({
      stepId: request.stepId,
      kind: request.kind,
      prompt: request.prompt,
    });
    options.signal?.throwIfAborted();
    if (request.kind === "approval" && !isApprovalGranted(answer)) {
      throw new Error(`AO approval declined at "${request.stepId}".`);
    }
    workflowInputs[request.inputName] = answer;
  }

  const evidenceLedger = new EvidenceLedger();
  const telemetry = new ResearchTelemetryTracker();
  const publishTelemetry = (update: ResearchTelemetryUpdate): void => {
    options.onEvent?.({
      type: "research.diagnostic",
      timestamp: update.diagnosticRecord.timestamp,
      diagnostic: update.diagnosticRecord,
    });
    if (update.publicEvent) {
      const type = update.publicEvent.state === "completed"
        ? "research.completed"
        : update.publicEvent.state === "failed" ||
            update.publicEvent.state === "canceled"
        ? "research.failed"
        : "research.progress";
      options.onEvent?.({
        type,
        timestamp: update.publicEvent.updatedAt,
        progress: update.publicEvent,
        telemetry: update.snapshot,
      });
    }
    if (update.activityEvent) {
      options.onEvent?.({
        type: "research.activity",
        timestamp: update.activityEvent.timestamp,
        activity: update.activityEvent,
        telemetry: update.snapshot,
      });
    }
  };
  const connector = createRuntimeConnector(
    settings,
    {
      onResearchEvent: (event, invocation) => {
        publishTelemetry(telemetry.observe(
          event,
          telemetryIdentity(invocation),
        ));
      },
      onResearchHeartbeat: (invocation) => {
        const update = telemetry.heartbeat(
          new Date().toISOString(),
          telemetryIdentity(invocation),
        );
        if (update) publishTelemetry(update);
      },
      onResearchComplete: (response, invocation) => {
        publishTelemetry(telemetry.complete({
          timestamp: new Date().toISOString(),
          sourceUrls: response.sourceUrls,
          cost: response.cost,
        }, telemetryIdentity(invocation)));
      },
      onResearchFailure: (failure, invocation) => {
        publishTelemetry(telemetry.fail(
          failure,
          telemetryIdentity(invocation),
        ));
      },
      onEvidenceBundle: (bundle) => {
        options.onEvent?.({
          type: "evidence.bundle.recorded",
          timestamp: bundle.completedAt,
          bundle,
        });
      },
      onReworkRejected: (reason) => {
        options.onEvent?.({
          type: "gptr.rework_rejected",
          timestamp: new Date().toISOString(),
          message: reason,
        });
      },
    },
    options.signal,
    temporalContext,
    { profile: taskProfile, capabilities },
    evidenceLedger,
  );

  options.signal?.throwIfAborted();
  const workflowResult = await runWorkflowFile(composed.savedPath, {
    connector,
    agentsDir,
    concurrency: settings.concurrency,
    verify: Boolean(settings.verifierModel),
    inputs: workflowInputs,
    researchProfiles,
    onEvent: options.onEvent,
  });
  options.signal?.throwIfAborted();

  if (!workflowResult.success) {
    throw new Error("AO workflow failed.");
  }

  const citationResult = normalizeFinalCitations(
    workflowResult.steps.at(-1)?.output ?? "",
    evidenceLedger.publicSources(),
  );
  const evidenceBundles = evidenceLedger.snapshot();
  const evidenceQuality = assessEvidenceQuality({
    citationNormalization: citationResult,
    evidenceBundles,
  });

  return {
    workflowPath: composed.savedPath,
    output: citationResult.markdown,
    workflow: workflowResult,
    evidenceBundles,
    citations: citationResult.citations,
    citationWarnings: citationResult.warnings,
    evidenceQuality,
    researchTelemetry: telemetry.snapshot(),
  };
}

function telemetryIdentity(
  invocation: {
    id: string;
    aoStepId: string;
    queuedAt: string;
    startedAt: string;
    researchProfile: ResearchProfile;
    budget: { waitedMs: number };
  },
): ResearchRunIdentity {
  return {
    aoStepId: invocation.aoStepId,
    researchRunId: invocation.id,
    mode: invocation.researchProfile.mode,
    queuedAt: invocation.queuedAt,
    startedAt: invocation.startedAt,
    queueWaitMs: invocation.budget.waitedMs,
  };
}

export function isApprovalGranted(answer: string): boolean {
  return /^(?:y(?:es)?|true|1|是|同意|批准|继续|确认)$/iu.test(
    answer.trim(),
  );
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
    researching: "正在综合多个来源中的相关信息。",
    scraping_complete: "网页内容抓取完成。",
    fetching_query_content: "正在提取当前查询对应的相关内容。",
    images: "已整理本轮研究发现的候选图片。",
    writing_report: "正在根据研究证据撰写报告。",
    report_written: "报告已完成，正在整理引用与交付内容。",
  };
  if (fixedMessages[stage]) {
    return fixedMessages[stage];
  }
  if (/^(?:subquery_)?context_not_found$/iu.test(stage)) {
    return "当前子问题未找到可用上下文，将继续使用其他检索结果。";
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
    const count = countMatch(
      /Combined research context:\s+(\d+)\s+MCP sources?/iu,
    );
    return count !== undefined
      ? `已合并研究上下文：${count} 个 MCP 来源，并纳入网页内容。`
      : "研究上下文已合并。";
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
