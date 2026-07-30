import type { ResearchProfile } from "./research-profile.js";
import {
  type ResearchActivity,
  ResearchActivityProjector,
  type ResearchPhase,
  semanticResearchStage,
} from "./research-activity.js";

export type {
  ResearchActivity,
  ResearchActivityKind,
  ResearchPhase,
} from "./research-activity.js";

export interface ResearchRunIdentity {
  aoStepId: string;
  researchRunId: string;
  mode: ResearchProfile["mode"];
  queuedAt: string;
  startedAt: string;
  queueWaitMs: number;
}

export interface ResearchRunCost {
  status: "reported" | "unavailable";
  currency: "USD";
  amount?: number;
  provenance: "gptr";
  estimated: true;
}

export interface DeepResearchProgress {
  currentLevel?: number;
  totalLevels?: number;
  completedQueries?: number;
  totalQueries?: number;
  currentBranch?: number;
  totalBranches?: number;
}

export interface ResearchRunProgress {
  schemaVersion: 1;
  aoStepId: string;
  researchRunId: string;
  mode: ResearchProfile["mode"];
  state: "queued" | "running" | "completed" | "failed" | "canceled";
  phase: ResearchPhase;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  queueWaitMs: number;
  elapsedMs: number;
  sourceCount: number;
  activityCount?: number;
  deep?: DeepResearchProgress;
  cost: ResearchRunCost;
}

export interface ResearchTelemetrySnapshot {
  schemaVersion: 1;
  runs: ResearchRunProgress[];
  summary: {
    runCount: number;
    completedRunCount: number;
    uniqueSourceCount: number;
    activityCount?: number;
    reportedCostUsd: number;
    reportedCostRuns: number;
    totalElapsedMs: number;
  };
}

export interface ResearchDiagnosticRecord {
  timestamp: string;
  aoStepId: string;
  researchRunId: string;
  rawType: string;
  rawStage: string;
  data: Record<string, unknown>;
  truncated: boolean;
}

export interface ResearchTelemetryUpdate {
  publicEvent?: ResearchRunProgress;
  activityEvent?: ResearchActivity;
  diagnosticRecord: ResearchDiagnosticRecord;
  snapshot: ResearchTelemetrySnapshot;
}

export interface ResearchCompletion {
  timestamp: string;
  sourceUrls: readonly string[];
  cost: unknown;
}

export interface ResearchFailure {
  timestamp: string;
  state: "failed" | "canceled";
  error: unknown;
}

export interface RawResearchEvent {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export class ResearchTelemetryTracker {
  readonly #runs = new Map<string, ResearchRunProgress>();
  readonly #fingerprints = new Map<string, string>();
  readonly #activities = new ResearchActivityProjector();

  observe(
    event: RawResearchEvent,
    identity: ResearchRunIdentity,
  ): ResearchTelemetryUpdate {
    const phase = phaseForRawEvent(event);
    const existing = this.#runs.get(identity.researchRunId);
    const deep = deepProgressFromEvent(event) ?? existing?.deep;
    const activityEvent = this.#activities.observe(event, {
      aoStepId: identity.aoStepId,
      researchRunId: identity.researchRunId,
      phase,
    });
    const progress: ResearchRunProgress = {
      schemaVersion: 1,
      aoStepId: identity.aoStepId,
      researchRunId: identity.researchRunId,
      mode: identity.mode,
      state: "running",
      phase,
      startedAt: identity.startedAt,
      updatedAt: event.timestamp,
      queueWaitMs: identity.queueWaitMs,
      elapsedMs: elapsedMilliseconds(identity.startedAt, event.timestamp),
      sourceCount: this.#activities.runSourceCount(identity.researchRunId),
      activityCount: this.#activities.runActivityCount(
        identity.researchRunId,
      ),
      ...(deep ? { deep } : {}),
      cost: existing?.cost ?? unavailableCost(),
    };
    this.#runs.set(identity.researchRunId, progress);

    const fingerprint = JSON.stringify({ phase, deep });
    const duplicate = this.#fingerprints.get(identity.researchRunId) ===
      fingerprint;
    this.#fingerprints.set(identity.researchRunId, fingerprint);
    const diagnostic = sanitizeDiagnosticData(event.data);

    return {
      ...(duplicate ? {} : { publicEvent: structuredClone(progress) }),
      ...(activityEvent
        ? { activityEvent: structuredClone(activityEvent) }
        : {}),
      diagnosticRecord: {
        timestamp: event.timestamp,
        aoStepId: identity.aoStepId,
        researchRunId: identity.researchRunId,
        rawType: event.type,
        rawStage: semanticResearchStage(event),
        data: diagnostic.data,
        truncated: diagnostic.truncated,
      },
      snapshot: this.snapshot(),
    };
  }

  complete(
    completion: ResearchCompletion,
    identity: ResearchRunIdentity,
  ): ResearchTelemetryUpdate & { publicEvent: ResearchRunProgress } {
    this.#activities.reconcileSourceUrls(
      identity.researchRunId,
      completion.sourceUrls,
    );
    const existing = this.#runs.get(identity.researchRunId);
    const progress: ResearchRunProgress = {
      schemaVersion: 1,
      aoStepId: identity.aoStepId,
      researchRunId: identity.researchRunId,
      mode: identity.mode,
      state: "completed",
      phase: "completed",
      startedAt: identity.startedAt,
      updatedAt: completion.timestamp,
      completedAt: completion.timestamp,
      queueWaitMs: identity.queueWaitMs,
      elapsedMs: elapsedMilliseconds(
        identity.startedAt,
        completion.timestamp,
      ),
      sourceCount: this.#activities.runSourceCount(identity.researchRunId),
      activityCount: this.#activities.runActivityCount(
        identity.researchRunId,
      ),
      ...(existing?.deep ? { deep: existing.deep } : {}),
      cost: normalizedCost(completion.cost),
    };
    this.#runs.set(identity.researchRunId, progress);
    this.#fingerprints.set(identity.researchRunId, "completed");
    return {
      publicEvent: structuredClone(progress),
      diagnosticRecord: {
        timestamp: completion.timestamp,
        aoStepId: identity.aoStepId,
        researchRunId: identity.researchRunId,
        rawType: "research.completed",
        rawStage: "completed",
        data: {
          sourceCount: this.#activities.runSourceCount(
            identity.researchRunId,
          ),
          cost: structuredClone(completion.cost),
        },
        truncated: false,
      },
      snapshot: this.snapshot(),
    };
  }

  fail(
    failure: ResearchFailure,
    identity: ResearchRunIdentity,
  ): ResearchTelemetryUpdate & { publicEvent: ResearchRunProgress } {
    const existing = this.#runs.get(identity.researchRunId);
    const progress: ResearchRunProgress = {
      schemaVersion: 1,
      aoStepId: identity.aoStepId,
      researchRunId: identity.researchRunId,
      mode: identity.mode,
      state: failure.state,
      phase: failure.state,
      startedAt: identity.startedAt,
      updatedAt: failure.timestamp,
      completedAt: failure.timestamp,
      queueWaitMs: identity.queueWaitMs,
      elapsedMs: elapsedMilliseconds(identity.startedAt, failure.timestamp),
      sourceCount: this.#activities.runSourceCount(identity.researchRunId),
      activityCount: this.#activities.runActivityCount(
        identity.researchRunId,
      ),
      ...(existing?.deep ? { deep: existing.deep } : {}),
      cost: existing?.cost ?? unavailableCost(),
    };
    this.#runs.set(identity.researchRunId, progress);
    this.#fingerprints.set(identity.researchRunId, failure.state);
    return {
      publicEvent: structuredClone(progress),
      diagnosticRecord: {
        timestamp: failure.timestamp,
        aoStepId: identity.aoStepId,
        researchRunId: identity.researchRunId,
        rawType: `research.${failure.state}`,
        rawStage: failure.state,
        data: {
          errorName: failure.error instanceof Error
            ? failure.error.name
            : "Error",
        },
        truncated: true,
      },
      snapshot: this.snapshot(),
    };
  }

  snapshot(): ResearchTelemetrySnapshot {
    const runs = [...this.#runs.values()].map((run) =>
      structuredClone(run)
    );
    const reportedCosts = runs.flatMap((run) =>
      run.cost.status === "reported" && run.cost.amount !== undefined
        ? [run.cost.amount]
        : []
    );
    return {
      schemaVersion: 1,
      runs,
      summary: {
        runCount: runs.length,
        completedRunCount: runs.filter((run) => run.state === "completed")
          .length,
        uniqueSourceCount: this.#activities.taskUniqueSourceCount,
        activityCount: this.#activities.taskActivityCount,
        reportedCostUsd: reportedCosts.reduce(
          (total, cost) => total + cost,
          0,
        ),
        reportedCostRuns: reportedCosts.length,
        totalElapsedMs: runs.reduce((total, run) => total + run.elapsedMs, 0),
      },
    };
  }
}

function phaseForRawEvent(event: RawResearchEvent): ResearchPhase {
  const stage = semanticResearchStage(event);
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
    return "searching";
  }
  if (
    stage.startsWith("scraping_") ||
    [
      "fetching_query_content",
      "added_source_url",
      "source.validation_started",
      "source.materialized",
      "source.unavailable",
        "source.domain_filtered",
        "retriever.summary",
      ].includes(stage)
  ) {
    return "collecting";
  }
  if (stage === "source.web_supplement_started") {
    return "searching";
  }
  if (
    [
      "researching",
      "research_progress",
      "context_combined",
      "deep_research.initialize",
      "deep_research.progress",
      "deep_research.complete",
      "synthesis.started",
      "synthesis.completed",
    ].includes(stage) ||
    /context_not_found$/u.test(stage)
  ) {
    return "analyzing";
  }
  if (stage === "writing_report") return "writing";
  if (
    [
      "report_written",
      "research_step_finalized",
      "gptr.report.normalized",
      "gptr.citations.normalized",
    ].includes(stage)
  ) {
    return "finalizing";
  }
  return "preparing";
}

function elapsedMilliseconds(startedAt: string, updatedAt: string): number {
  const elapsed = Date.parse(updatedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function unavailableCost(): ResearchRunCost {
  return {
    status: "unavailable",
    currency: "USD",
    provenance: "gptr",
    estimated: true,
  };
}

function deepProgressFromEvent(
  event: RawResearchEvent,
): DeepResearchProgress | undefined {
  if (semanticResearchStage(event) !== "deep_research.progress") {
    return undefined;
  }
  const values: DeepResearchProgress = {
    currentLevel: finiteNumber(event.data.currentLevel),
    totalLevels: finiteNumber(event.data.totalLevels),
    completedQueries: finiteNumber(event.data.completedQueries),
    totalQueries: finiteNumber(event.data.totalQueries),
    currentBranch: finiteNumber(event.data.currentBreadth),
    totalBranches: finiteNumber(event.data.totalBreadth),
  };
  const entries = Object.entries(values).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as DeepResearchProgress
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizedCost(value: unknown): ResearchRunCost {
  const amount = costAmount(value);
  return amount === undefined
    ? unavailableCost()
    : {
        status: "reported",
        currency: "USD",
        amount,
        provenance: "gptr",
        estimated: true,
      };
}

function costAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["totalCost", "total_cost", "cost", "amount"]) {
    const candidate = record[key];
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return undefined;
}

function sanitizeDiagnosticData(
  data: Record<string, unknown>,
): { data: Record<string, unknown>; truncated: boolean } {
  const state = { truncated: false };
  const sanitized = sanitizeDiagnosticValue(data, state, 0);
  return {
    data: sanitized && typeof sanitized === "object" &&
        !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : {},
    truncated: state.truncated,
  };
}

function sanitizeDiagnosticValue(
  value: unknown,
  state: { truncated: boolean },
  depth: number,
): unknown {
  if (depth > 8) {
    state.truncated = true;
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    const withoutPrompts = value
      .replace(/<runtime_context>[\s\S]*?<\/runtime_context>/giu, "")
      .replace(
        /<expert_system_prompt>[\s\S]*?<\/expert_system_prompt>/giu,
        "",
      )
      .replace(/<citation_contract>[\s\S]*?<\/citation_contract>/giu, "")
      .trim();
    if (withoutPrompts !== value.trim()) {
      state.truncated = true;
    }
    if (withoutPrompts.length <= 4_096) {
      return withoutPrompts;
    }
    state.truncated = true;
    return `${withoutPrompts.slice(0, 4_093)}...`;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) state.truncated = true;
    return value.slice(0, 100).map((item) =>
      sanitizeDiagnosticValue(item, state, depth + 1)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveDiagnosticKey(key)
          ? "[REDACTED]"
          : sanitizeDiagnosticValue(item, state, depth + 1),
      ]),
    );
  }
  return String(value);
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /api.?key|authorization|credential|password|secret|token|cookie/iu
    .test(key);
}
