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
import {
  InMemoryResearchTaskStore,
  type ResearchTaskEventDraft,
  type ResearchTaskStore,
} from "./research-task-store.js";
import type {
  ResearchCapabilities,
  ResearchProfile,
} from "./research-profile.js";
import type { EvidenceBundle } from "./evidence-bundle.js";
import type { EvidenceQualityAssessment } from "./evidence-quality.js";
import type { ResearchTelemetrySnapshot } from "./research-telemetry.js";

export type ResearchTaskStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "canceling"
  | "canceled"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export interface ResearchTaskSnapshot {
  id: string;
  topic: string;
  status: ResearchTaskStatus;
  createdAt: string;
  updatedAt: string;
  workflowPath?: string;
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
  researchTelemetry?: ResearchTelemetrySnapshot;
}

export interface ContentAcceptance {
  status: "passed" | "warning";
  warnings: string[];
}

export interface ResearchTaskPolicy {
  researchProfile?: ResearchProfile;
  researchCapabilities?: ResearchCapabilities;
}

export interface ResearchInputRequest {
  stepId: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export interface ResearchTaskEvent {
  id: number;
  taskId: string;
  timestamp: string;
  type: "task.queued" | "task.running" | "task.completed"
    | "task.needs_input" | "task.input_received"
    | "task.canceling" | "task.canceled"
    | "task.completed_with_warnings" | "task.failed"
    | ResearchRunnerEvent["type"];
  data: Record<string, unknown>;
}

export type ResearchTaskRunner = (
  topic: string,
  onEvent: (event: ResearchRunnerEvent) => void,
  controls: {
    requestInput: (request: ResearchInputRequest) => Promise<string>;
    signal: AbortSignal;
    researchProfile?: ResearchProfile;
    researchCapabilities?: ResearchCapabilities;
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
      id: randomUUID(),
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

    this.#queue = this.#queue
      .then(() => this.#execute(snapshot.id))
      .catch(() => undefined);

    return { ...snapshot };
  }

  get(id: string): ResearchTaskSnapshot | undefined {
    const snapshot = this.#store.load(id)?.snapshot;
    if (!snapshot?.output || !snapshot.citations?.length) {
      return snapshot;
    }
    return {
      ...snapshot,
      output: formatCitationReport(snapshot.output, snapshot.citations),
    };
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

  answerInput(id: string, answer: string): boolean {
    const normalized = answer.trim();
    const task = this.#store.load(id)?.snapshot;
    const runtime = this.#runtime.get(id);
    if (
      !task ||
      task.status !== "needs_input" ||
      !runtime?.inputResolver ||
      !normalized
    ) {
      return false;
    }

    const resolver = runtime.inputResolver;
    runtime.inputResolver = undefined;
    runtime.inputRejecter = undefined;
    const stepId = task.pendingInput?.stepId;
    this.#record(
      id,
      { status: "running", pendingInput: undefined },
      "task.input_received",
      { stepId },
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
    if (snapshot.status === "queued" || snapshot.status === "needs_input") {
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

  async #execute(id: string): Promise<void> {
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
            this.#record(
              id,
              changes,
              event.type,
              structuredClone(event.activity) as unknown as
                Record<string, unknown>,
            );
            return;
          }
          if (
            event.type === "research.progress" ||
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
          }
          if (event.type === "evidence.bundle.recorded") {
            const existing = this.#store.load(id)?.snapshot
              .evidenceBundles ?? [];
            changes.evidenceBundles = [
              ...existing,
              structuredClone(event.bundle),
            ];
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
          requestInput: (request) => this.#requestInput(id, request),
          signal: controller.signal,
          researchProfile: queued.researchProfile,
          researchCapabilities: queued.researchCapabilities,
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
      this.#record(
        id,
        {
          status,
          workflowPath: result.workflowPath,
          output: result.output,
          citations: result.citations ?? [],
          contentAcceptance,
          ...(result.evidenceQuality === undefined
            ? {}
            : {
                evidenceQuality: structuredClone(result.evidenceQuality),
              }),
          ...(result.evidenceBundles === undefined
            ? {}
            : {
                evidenceBundles: structuredClone(result.evidenceBundles),
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
      if (currentStatus === "canceled") {
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
    request: ResearchInputRequest,
  ): Promise<string> {
    const runtime = this.#runtimeFor(id);
    if (runtime.inputResolver) {
      throw new Error("task already has a pending input request");
    }
    this.#pauseExecutionTimer(runtime);
    this.#record(
      id,
      { status: "needs_input", pendingInput: request },
      "task.needs_input",
      { ...request },
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
