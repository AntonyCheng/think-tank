import { randomUUID } from "node:crypto";

import {
  localizeResearchProgress,
  type ResearchRunResult,
  type ResearchRunnerEvent,
} from "./research-runner.js";
import {
  formatCitationReport,
  type VerifiedCitation,
} from "./citations.js";
import { applyCurrentEvidenceQualityTargets } from "./evidence-quality.js";
import {
  InMemoryResearchTaskStore,
  type StoredResearchDiagnostic,
  type ResearchTaskEventDraft,
  type ResearchTaskStore,
} from "./research-task-store.js";
import type {
  ResearchCapabilities,
  ResearchProfile,
} from "./research-profile.js";
import type { EvidenceBundle } from "./evidence-bundle.js";
import type { EvidenceQualityAssessment } from "./evidence-quality.js";
import type { ReportEvidencePolicy } from "./report-evidence-policy.js";
import type { ResearchTelemetrySnapshot } from "./research-telemetry.js";
import type {
  WorkflowCheckpoint,
  WorkflowRunRequest,
} from "./workflow-checkpoint.js";
import type { WorkflowPlan } from "./workflow-plan.js";

export type ResearchTaskStatus =
  | "queued"
  | "recoverable"
  | "running"
  | "needs_input"
  | "canceling"
  | "canceled"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export type ResearchHistoryFilter =
  | "all"
  | "completed"
  | "warnings"
  | "unfinished";

export interface ResearchTaskHistoryEntry {
  id: string;
  topic: string;
  status: ResearchTaskStatus;
  createdAt: string;
  updatedAt: string;
  expertCount: number;
  sourceCount: number;
  elapsedMs?: number;
  costUsd?: number;
  warningCount: number;
  hasReport: boolean;
}

export interface ResearchTaskHistoryPage {
  items: ResearchTaskHistoryEntry[];
  nextCursor?: string;
}

export interface ResearchTaskSnapshot {
  id: string;
  topic: string;
  status: ResearchTaskStatus;
  createdAt: string;
  updatedAt: string;
  workflowPath?: string;
  workflowPlan?: WorkflowPlan;
  reportStepId?: string;
  output?: string;
  citations?: VerifiedCitation[];
  warnings?: string[];
  error?: string;
  pendingInput?: ResearchInputRequest;
  researchProfile?: ResearchProfile;
  researchCapabilities?: ResearchCapabilities;
  evidenceBundles?: EvidenceBundle[];
  contentAcceptance?: ContentAcceptance;
  evidenceQuality?: EvidenceQualityAssessment;
  reportEvidencePolicy?: ReportEvidencePolicy;
  researchTelemetry?: ResearchTelemetrySnapshot;
  recovery?: {
    latestRunId: string;
    checkpointAt: string;
    reason: "restart";
  };
  revisions?: ResearchTaskRevision[];
}

export interface ResearchTaskRevision {
  runId: string;
  createdAt: string;
  reason: WorkflowCheckpoint["reason"];
  output?: string;
}

export interface ContentAcceptance {
  status: "passed" | "warning";
  warnings: string[];
}

export interface ResearchTaskPolicy {
  taskId?: string;
  researchProfile?: ResearchProfile;
  researchCapabilities?: ResearchCapabilities;
  deferredStart?: boolean;
}

export interface ResearchInputRequest {
  requestId: string;
  stepId: string;
  inputName?: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export type ResearchInputRequestDraft = Omit<ResearchInputRequest, "requestId">;

export interface ResearchTaskEvent {
  id: number;
  taskId: string;
  timestamp: string;
  type: "task.queued" | "task.running" | "task.completed"
    | "task.needs_input" | "task.input_received" | "task.recoverable"
    | "task.resumed" | "task.rerun_requested"
    | "task.checkpoint_saved"
    | "task.canceling" | "task.canceled"
    | "task.completed_with_warnings" | "task.failed"
    | ResearchRunnerEvent["type"];
  data: Record<string, unknown>;
}

export type ResearchTaskRunner = (
  topic: string,
  onEvent: (event: ResearchRunnerEvent) => void,
  controls: {
    taskId: string;
    requestInput: (request: ResearchInputRequestDraft) => Promise<string>;
    signal: AbortSignal;
    researchProfile?: ResearchProfile;
    researchCapabilities?: ResearchCapabilities;
    execution?: WorkflowRunRequest;
    saveCheckpoint: (checkpoint: WorkflowCheckpoint) => void;
  },
) => Promise<ResearchRunResult>;

interface RuntimeTask {
  listeners: Set<(event: ResearchTaskEvent) => void>;
  inputResolver?: (answer: string) => void;
  inputRejecter?: (error: Error) => void;
  controller?: AbortController;
  timeout?: NodeJS.Timeout;
  remainingExecutionMs?: number;
  activeSince?: number;
  timedOut?: boolean;
  transientProgress?: {
    changes: Partial<ResearchTaskSnapshot>;
    type: "research.progress";
    data: Record<string, unknown>;
  };
  transientProgressTimer?: NodeJS.Timeout;
}

export interface ResearchTaskManagerOptions {
  executionTimeoutMs?: number;
}

export class ResearchTaskManager {
  readonly #runner: ResearchTaskRunner;
  readonly #store: ResearchTaskStore;
  readonly #options: ResearchTaskManagerOptions;
  readonly #runtime = new Map<string, RuntimeTask>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    runner: ResearchTaskRunner,
    store: ResearchTaskStore = new InMemoryResearchTaskStore(),
    options: ResearchTaskManagerOptions = {},
  ) {
    if (
      options.executionTimeoutMs !== undefined &&
      (!Number.isInteger(options.executionTimeoutMs) ||
        options.executionTimeoutMs < 1)
    ) {
      throw new Error("executionTimeoutMs must be a positive integer");
    }
    this.#runner = runner;
    this.#store = store;
    this.#options = options;
    this.#store.recoverInterrupted();
  }

  submit(
    topic: string,
    policy: ResearchTaskPolicy = {},
  ): ResearchTaskSnapshot {
    const normalized = topic.trim();
    if (!normalized) {
      throw new Error("topic must not be empty");
    }

    const timestamp = new Date().toISOString();
    const snapshot: ResearchTaskSnapshot = {
      id: policy.taskId ?? randomUUID(),
      topic: normalized,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(policy.researchProfile === undefined
        ? {}
        : { researchProfile: structuredClone(policy.researchProfile) }),
      ...(policy.researchCapabilities === undefined
        ? {}
        : {
            researchCapabilities: structuredClone(
              policy.researchCapabilities,
            ),
          }),
    };
    this.#runtime.set(snapshot.id, {
      listeners: new Set(),
    });
    this.#store.create(snapshot, {
      type: "task.queued",
      data: {
        topic: normalized,
        ...(snapshot.researchProfile === undefined
          ? {}
          : { researchProfile: snapshot.researchProfile }),
        ...(snapshot.researchCapabilities === undefined
          ? {}
          : { researchCapabilities: snapshot.researchCapabilities }),
      },
    });

    if (!policy.deferredStart) this.start(snapshot.id);

    return { ...snapshot };
  }

  start(id: string): boolean {
    const task = this.#store.load(id)?.snapshot;
    if (!task || task.status !== "queued") return false;
    this.#enqueue(id);
    return true;
  }

  resume(id: string): boolean {
    const task = this.#store.load(id)?.snapshot;
    const checkpoint = this.#store.latestCheckpoint(id);
    if (!task || task.status !== "recoverable" || !checkpoint) return false;
    this.#record(
      id,
      { status: "queued", recovery: undefined, error: undefined },
      "task.resumed",
      { runId: checkpoint.runId },
    );
    this.#enqueue(id, { checkpoint });
    return true;
  }

  rerun(id: string, fromStep: string): boolean {
    const task = this.#store.load(id)?.snapshot;
    const checkpoint = this.#store.latestCheckpoint(id);
    if (
      !task ||
      !checkpoint ||
      !["completed", "completed_with_warnings", "failed"].includes(task.status)
    ) {
      return false;
    }
    const target = checkpoint.completedSteps.find(
      (step) => step.id === fromStep && step.status === "completed",
    );
    if (!target || !target.role.trim()) return false;
    const revision: ResearchTaskRevision = {
      runId: checkpoint.runId,
      createdAt: new Date().toISOString(),
      reason: checkpoint.reason,
      output: task.output,
    };
    this.#record(
      id,
      {
        status: "queued",
        error: undefined,
        recovery: undefined,
        revisions: [...(task.revisions ?? []), revision],
      },
      "task.rerun_requested",
      { fromStep },
    );
    this.#enqueue(id, {
      checkpoint,
      fromStep,
    });
    return true;
  }

  get(id: string): ResearchTaskSnapshot | undefined {
    const stored = this.#store.load(id)?.snapshot;
    const snapshot = stored
      ? presentCurrentEvidenceQuality(stored)
      : undefined;
    if (
      !snapshot?.output ||
      !snapshot.citations?.length ||
      snapshot.reportEvidencePolicy?.strategy === "mixed_evidence"
    ) {
      return snapshot;
    }
    return {
      ...snapshot,
      output: formatCitationReport(snapshot.output, snapshot.citations),
    };
  }

  diagnostics(id: string): StoredResearchDiagnostic[] {
    return this.#store.loadDiagnostics(id);
  }

  evidenceBundles(id: string): EvidenceBundle[] {
    return this.#store.loadEvidenceBundles(id);
  }

  listHistory(input: {
    cursor?: string;
    limit?: number;
    query?: string;
    filter?: ResearchHistoryFilter;
  } = {}): ResearchTaskHistoryPage {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 50);
    const filter = input.filter ?? "all";
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const cursor = parseHistoryCursor(input.cursor);
    const entries = this.#store.list()
      .map(presentCurrentEvidenceQuality)
      .filter((task) => matchesHistoryFilter(task, filter))
      .filter((task) => !query || task.topic.toLocaleLowerCase().includes(query))
      .sort(compareHistoryTasks)
      .filter((task) => !cursor || isAfterHistoryCursor(task, cursor))
      .map(historyEntry);
    const items = entries.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(entries.length > items.length && last
        ? { nextCursor: historyCursor(last) }
        : {}),
    };
  }

  delete(id: string): "deleted" | "not_found" | "not_terminal" {
    const task = this.#store.load(id)?.snapshot;
    if (!task) return "not_found";
    if (!isTerminalTaskStatus(task.status)) return "not_terminal";
    this.#runtime.delete(id);
    return this.#store.delete(id) ? "deleted" : "not_found";
  }

  checkpoint(id: string): WorkflowCheckpoint | undefined {
    return this.#store.latestCheckpoint(id);
  }

  subscribe(
    id: string,
    listener: (event: ResearchTaskEvent) => void,
    afterEventId = 0,
  ): (() => void) | undefined {
    const stored = this.#store.load(id);
    if (!stored) {
      return undefined;
    }

    for (const event of stored.events) {
      if (event.id > afterEventId) {
        listener(presentTaskEvent(event));
      }
    }
    const runtime = this.#runtimeFor(id);
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  answerInput(id: string, answer: string, requestId?: string): boolean {
    const normalized = answer.trim();
    const task = this.#store.load(id)?.snapshot;
    const runtime = this.#runtime.get(id);
    if (
      !task ||
      task.status !== "needs_input" ||
      !runtime?.inputResolver ||
      !normalized ||
      (requestId !== undefined && task.pendingInput?.requestId !== requestId)
    ) {
      return false;
    }

    if (
      task.pendingInput?.kind === "approval" &&
      normalized !== "approved" &&
      normalized !== "declined"
    ) {
      return false;
    }

    const resolver = runtime.inputResolver;
    const rejecter = runtime.inputRejecter;
    runtime.inputResolver = undefined;
    runtime.inputRejecter = undefined;
    const pendingInput = task.pendingInput;
    if (pendingInput?.kind === "approval" && normalized === "declined") {
      const error = new Error("审批已被拒绝，研究任务未继续执行。");
      this.#clearExecutionTimer(runtime);
      this.#record(
        id,
        { status: "failed", pendingInput: undefined, error: error.message },
        "task.failed",
        { stepId: pendingInput.stepId, reason: "approval_declined", error: error.message },
      );
      runtime.controller?.abort(error);
      rejecter?.(error);
      return true;
    }

    this.#record(
      id,
      { status: "running", pendingInput: undefined },
      "task.input_received",
      { stepId: pendingInput?.stepId, requestId: pendingInput?.requestId },
    );
    this.#resumeExecutionTimer(id, runtime);
    resolver(normalized);
    return true;
  }

  cancel(id: string): boolean {
    const snapshot = this.#store.load(id)?.snapshot;
    if (!snapshot) {
      return false;
    }
    if (snapshot.status === "canceled") return true;
    if (isTerminalTaskStatus(snapshot.status)) return false;
    if (snapshot.status === "canceling") {
      return true;
    }

    const runtime = this.#runtimeFor(id);
    const error = new Error("任务已由用户取消。");
    if (
      snapshot.status === "queued" ||
      snapshot.status === "needs_input" ||
      snapshot.status === "recoverable"
    ) {
      this.#clearExecutionTimer(runtime);
      this.#record(
        id,
        {
          status: "canceled",
          pendingInput: undefined,
          error: error.message,
        },
        "task.canceled",
        { reason: "user", message: error.message },
      );
      runtime.controller?.abort(error);
      runtime.inputRejecter?.(error);
      runtime.inputResolver = undefined;
      runtime.inputRejecter = undefined;
      return true;
    }

    this.#record(
      id,
      { status: "canceling", pendingInput: undefined },
      "task.canceling",
      { reason: "user" },
    );
    runtime.controller?.abort(error);
    return true;
  }

  #enqueue(id: string, execution?: WorkflowRunRequest): void {
    this.#queue = this.#queue
      .then(() => this.#execute(id, execution))
      .catch(() => undefined);
  }

  async #execute(
    id: string,
    execution?: WorkflowRunRequest,
  ): Promise<void> {
    const queued = this.#store.load(id)?.snapshot;
    if (!queued || queued.status !== "queued") return;

    const runtime = this.#runtimeFor(id);
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.remainingExecutionMs = this.#options.executionTimeoutMs;
    runtime.timedOut = false;
    this.#record(id, { status: "running" }, "task.running", {});
    this.#resumeExecutionTimer(id, runtime);

    try {
      const result = await this.#runner(
        queued.topic,
        (event) => {
          const changes: Partial<ResearchTaskSnapshot> = {};
          if (event.type === "research.diagnostic") {
            this.#store.recordDiagnostic(id, event.diagnostic);
            return;
          }
          if (event.type === "research.activity") {
            changes.researchTelemetry = structuredClone(event.telemetry);
            // Activities describe distinct user-visible research work. They must
            // not be coalesced with high-frequency progress refreshes.
            this.#recordNow(
              id,
              changes,
              event.type,
              structuredClone(event.activity) as unknown as
                Record<string, unknown>,
            );
            return;
          }
          if (event.type === "research.progress") {
            changes.researchTelemetry = structuredClone(event.telemetry);
            this.#scheduleTransientProgress(
              id,
              changes,
              event.type,
              structuredClone(event.progress) as unknown as
                Record<string, unknown>,
            );
            return;
          }
          if (
            event.type === "research.completed" ||
            event.type === "research.failed"
          ) {
            changes.researchTelemetry = structuredClone(event.telemetry);
            this.#record(
              id,
              changes,
              event.type,
              structuredClone(event.progress) as unknown as
                Record<string, unknown>,
            );
            return;
          }
          if (event.type === "workflow.composed") {
            changes.workflowPath = event.workflowPath;
            changes.workflowPlan = structuredClone(event.workflowPlan);
          }
          if (event.type === "evidence.bundle.recorded") {
            if (!this.#store.appendEvidenceBundle(id, event.bundle)) {
              throw new Error(`task not found: ${id}`);
            }
            this.#record(id, changes, event.type, {
              aoStepId: event.bundle.aoStepId,
              researchRunId: event.bundle.researchRunId,
              attempt: event.bundle.attempt,
              mode: event.bundle.mode,
              queryCount: event.bundle.queries.length,
              sourceCount: event.bundle.sources.length,
            });
            return;
          }
          const { type, timestamp: _timestamp, ...data } = event;
          this.#record(id, changes, type, data);
        },
        {
          taskId: id,
          requestInput: (request) => this.#requestInput(id, request),
          signal: controller.signal,
          researchProfile: queued.researchProfile,
          researchCapabilities: queued.researchCapabilities,
          execution,
          saveCheckpoint: (checkpoint) => {
            this.#store.saveCheckpoint(checkpoint);
            this.#record(id, {}, "task.checkpoint_saved", {
              runId: checkpoint.runId,
              sequence: checkpoint.sequence,
            });
          },
        },
      );
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const contentWarnings = result.workflow.steps.flatMap((step) =>
        step.verification?.pass === false
          ? step.verification.failed.map((warning) => `${step.id}: ${warning}`)
          : []
      );
      const contentAcceptance: ContentAcceptance = {
        status: contentWarnings.length === 0 ? "passed" : "warning",
        warnings: contentWarnings,
      };
      const evidenceWarnings = result.evidenceQuality
        ? result.evidenceQuality.warnings.map((warning) => warning.message)
        : result.citationWarnings ?? [];
      const warnings = [...contentWarnings, ...evidenceWarnings];
      const status: ResearchTaskStatus = warnings.length > 0
        ? "completed_with_warnings"
        : "completed";
      if (
        result.evidenceBundles !== undefined &&
        !this.#store.replaceEvidenceBundles(id, result.evidenceBundles)
      ) {
        throw new Error(`task not found: ${id}`);
      }
      this.#record(
        id,
        {
          status,
          workflowPath: result.workflowPath,
          reportStepId: result.workflow.steps.at(-1)?.id,
          output: result.output,
          citations: result.citations ?? [],
          contentAcceptance,
          ...(result.evidenceQuality === undefined
            ? {}
            : {
                evidenceQuality: structuredClone(result.evidenceQuality),
              }),
          ...(result.reportEvidencePolicy === undefined
            ? {}
            : {
                reportEvidencePolicy: structuredClone(
                  result.reportEvidencePolicy,
                ),
              }),
          ...(result.researchTelemetry === undefined
            ? {}
            : {
                researchTelemetry: structuredClone(
                  result.researchTelemetry,
                ),
              }),
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        status === "completed"
          ? "task.completed"
          : "task.completed_with_warnings",
        {
          workflowPath: result.workflowPath,
          contentAcceptance,
          ...(result.evidenceQuality === undefined
            ? {}
            : { evidenceQuality: result.evidenceQuality }),
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      );
    } catch (error) {
      const currentStatus = this.#store.load(id)?.snapshot.status;
      if (currentStatus && isTerminalTaskStatus(currentStatus)) {
        return;
      }
      if (runtime.timedOut) {
        const message = "任务执行超时，请缩小研究范围后重试。";
        this.#record(
          id,
          { status: "failed", error: message, pendingInput: undefined },
          "task.failed",
          { error: message, reason: "timeout" },
        );
        return;
      }
      if (currentStatus === "canceling" || controller.signal.aborted) {
        const message = "任务已由用户取消。";
        this.#record(
          id,
          { status: "canceled", error: message, pendingInput: undefined },
          "task.canceled",
          { reason: "user", message },
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#record(
        id,
        { status: "failed", error: message, pendingInput: undefined },
        "task.failed",
        { error: message },
      );
    } finally {
      this.#clearExecutionTimer(runtime);
      runtime.controller = undefined;
      runtime.inputResolver = undefined;
      runtime.inputRejecter = undefined;
    }
  }

  #requestInput(
    id: string,
    request: ResearchInputRequestDraft,
  ): Promise<string> {
    const runtime = this.#runtimeFor(id);
    if (runtime.inputResolver) {
      throw new Error("task already has a pending input request");
    }
    const pendingInput: ResearchInputRequest = {
      ...request,
      requestId: randomUUID(),
    };
    this.#pauseExecutionTimer(runtime);
    this.#record(
      id,
      { status: "needs_input", pendingInput },
      "task.needs_input",
      { ...pendingInput },
    );
    return new Promise((resolve, reject) => {
      runtime.inputResolver = resolve;
      runtime.inputRejecter = reject;
    });
  }

  #record(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    type: ResearchTaskEvent["type"],
    data: Record<string, unknown>,
  ): void {
    this.#flushTransientProgress(id);
    this.#recordNow(id, changes, type, data);
  }

  #recordNow(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    type: ResearchTaskEvent["type"],
    data: Record<string, unknown>,
  ): void {
    const draft: ResearchTaskEventDraft = {
      type,
      data,
    };
    const transition = this.#store.record(id, changes, draft);
    if (!transition) {
      throw new Error(`task not found: ${id}`);
    }
    for (const listener of this.#runtimeFor(id).listeners) {
      listener(presentTaskEvent(transition.event));
    }
  }

  #scheduleTransientProgress(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    type: "research.progress",
    data: Record<string, unknown>,
  ): void {
    const runtime = this.#runtimeFor(id);
    runtime.transientProgress = {
      changes,
      type,
      data,
    };
    if (runtime.transientProgressTimer) return;
    runtime.transientProgressTimer = setTimeout(() => {
      runtime.transientProgressTimer = undefined;
      this.#flushTransientProgress(id);
    }, 750);
    runtime.transientProgressTimer.unref();
  }

  #flushTransientProgress(id: string): void {
    const runtime = this.#runtimeFor(id);
    if (runtime.transientProgressTimer) {
      clearTimeout(runtime.transientProgressTimer);
      runtime.transientProgressTimer = undefined;
    }
    const pending = runtime.transientProgress;
    runtime.transientProgress = undefined;
    if (!pending) return;
    this.#recordNow(id, pending.changes, pending.type, pending.data);
  }

  #runtimeFor(id: string): RuntimeTask {
    let runtime = this.#runtime.get(id);
    if (!runtime) {
      runtime = { listeners: new Set() };
      this.#runtime.set(id, runtime);
    }
    return runtime;
  }

  #resumeExecutionTimer(id: string, runtime: RuntimeTask): void {
    if (runtime.remainingExecutionMs === undefined || runtime.timeout) {
      return;
    }
    runtime.activeSince = Date.now();
    runtime.timeout = setTimeout(() => {
      runtime.timeout = undefined;
      runtime.timedOut = true;
      runtime.controller?.abort(new Error("任务执行超时。"));
    }, runtime.remainingExecutionMs);
  }

  #pauseExecutionTimer(runtime: RuntimeTask): void {
    if (!runtime.timeout || runtime.activeSince === undefined) return;
    clearTimeout(runtime.timeout);
    runtime.timeout = undefined;
    runtime.remainingExecutionMs = Math.max(
      0,
      (runtime.remainingExecutionMs ?? 0) -
        (Date.now() - runtime.activeSince),
    );
    runtime.activeSince = undefined;
  }

  #clearExecutionTimer(runtime: RuntimeTask): void {
    if (runtime.timeout) {
      clearTimeout(runtime.timeout);
      runtime.timeout = undefined;
    }
    runtime.activeSince = undefined;
  }
}

function historyEntry(task: ResearchTaskSnapshot): ResearchTaskHistoryEntry {
  const telemetry = task.researchTelemetry?.summary;
  const sourceCount = telemetry?.uniqueSourceCount ?? new Set(
    (task.evidenceBundles ?? []).flatMap((bundle) =>
      bundle.sources.flatMap((source) =>
        source.visibility === "public" ? [source.url] : []
      )
    ),
  ).size;
  const warningCount = (task.warnings?.length ?? 0) +
    (task.contentAcceptance?.warnings.length ?? 0) +
    (task.evidenceQuality?.warnings.length ?? 0);
  return {
    id: task.id,
    topic: task.topic,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expertCount: task.workflowPlan?.steps.length ?? 0,
    sourceCount,
    ...(telemetry?.totalElapsedMs === undefined
      ? {}
      : { elapsedMs: telemetry.totalElapsedMs }),
    ...(telemetry?.reportedCostUsd === undefined
      ? {}
      : { costUsd: telemetry.reportedCostUsd }),
    warningCount,
    hasReport: Boolean(task.output),
  };
}

function presentCurrentEvidenceQuality(
  snapshot: ResearchTaskSnapshot,
): ResearchTaskSnapshot {
  if (!snapshot.evidenceQuality) return snapshot;
  const previousQuality = snapshot.evidenceQuality;
  const evidenceQuality = applyCurrentEvidenceQualityTargets(previousQuality);
  const previousMessages = new Set(
    previousQuality.warnings.map((warning) => warning.message),
  );
  const warnings = [
    ...(snapshot.warnings ?? []).filter((warning) =>
      !previousMessages.has(warning)
    ),
    ...evidenceQuality.warnings.map((warning) => warning.message),
  ];
  return {
    ...snapshot,
    ...(snapshot.status === "completed_with_warnings" && warnings.length === 0
      ? { status: "completed" }
      : {}),
    evidenceQuality,
    ...(snapshot.warnings === undefined && warnings.length === 0
      ? {}
      : { warnings }),
  };
}

function matchesHistoryFilter(
  task: ResearchTaskSnapshot,
  filter: ResearchHistoryFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "completed") {
    return task.status === "completed" || task.status === "completed_with_warnings";
  }
  if (filter === "warnings") {
    return task.status === "completed_with_warnings" ||
      (task.contentAcceptance?.status === "warning") ||
      (task.evidenceQuality?.status === "warning");
  }
  return !["completed", "completed_with_warnings"].includes(task.status);
}

function compareHistoryTasks(
  left: ResearchTaskSnapshot,
  right: ResearchTaskSnapshot,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id);
}

function historyCursor(entry: Pick<ResearchTaskHistoryEntry, "updatedAt" | "id">): string {
  return `${entry.updatedAt}|${entry.id}`;
}

function parseHistoryCursor(value: string | undefined):
  | { updatedAt: string; id: string }
  | undefined {
  if (!value) return undefined;
  const delimiter = value.lastIndexOf("|");
  if (delimiter < 1 || delimiter === value.length - 1) {
    throw new Error("history cursor is invalid");
  }
  return {
    updatedAt: value.slice(0, delimiter),
    id: value.slice(delimiter + 1),
  };
}

function isAfterHistoryCursor(
  task: ResearchTaskSnapshot,
  cursor: { updatedAt: string; id: string },
): boolean {
  return task.updatedAt < cursor.updatedAt ||
    (task.updatedAt === cursor.updatedAt && task.id < cursor.id);
}

function presentTaskEvent(event: ResearchTaskEvent): ResearchTaskEvent {
  if (event.type !== "gptr.progress") {
    return event;
  }
  const stage = event.data.stage;
  const message = event.data.message;
  if (typeof stage !== "string" || typeof message !== "string") {
    return event;
  }
  const localized = localizeResearchProgress(stage, message, event.data);
  return localized === message
    ? event
    : {
      ...event,
      data: {
        ...event.data,
        message: localized,
      },
    };
}

function isTerminalTaskStatus(status: ResearchTaskStatus): boolean {
  return [
    "completed",
    "completed_with_warnings",
    "failed",
    "canceled",
  ].includes(status);
}
