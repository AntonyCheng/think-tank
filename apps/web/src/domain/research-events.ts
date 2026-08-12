import type { ResearchTaskSnapshot, WorkflowPlan } from "./task";

export const TASK_EVENT_TYPES = [
  "task.queued", "task.running", "task.needs_input", "task.input_received",
  "task.recoverable", "task.resumed", "task.rerun_requested", "task.checkpoint_saved",
  "task.canceling", "task.canceled", "task.completed", "task.completed_with_warnings",
  "task.failed", "workflow.composed", "workflow.repairing", "step.started",
  "step.completed", "research.activity", "research.progress", "research.completed",
  "research.failed", "gptr.progress", "gptr.completed", "evidence.bundle.recorded",
] as const;

export type TaskEventType = typeof TASK_EVENT_TYPES[number];

export interface TaskEvent {
  id: number;
  taskId: string;
  timestamp: string;
  type: TaskEventType;
  data: Record<string, unknown>;
}

export interface ResearchActivity {
  aoStepId: string;
  researchRunId: string;
  sequence: number;
  timestamp: string;
  phase: string;
  kind: string;
  message: string;
  sourceUrl?: string;
  runSourceCount: number;
  taskUniqueSourceCount: number;
  taskActivityCount: number;
}

export interface StepEventData {
  stepId: string;
  stepName?: string;
  role?: string;
  agentName?: string;
  agentEmoji?: string;
  status?: string;
}

export function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === "string" ? data[key] as string : undefined;
}

export function numberValue(data: Record<string, unknown>, key: string): number | undefined {
  return typeof data[key] === "number" ? data[key] as number : undefined;
}

export function activityFromEvent(event: TaskEvent): ResearchActivity | undefined {
  if (event.type !== "research.activity") return undefined;
  const value = event.data as unknown as Partial<ResearchActivity>;
  if (typeof value.message !== "string") return undefined;
  return {
    aoStepId: value.aoStepId ?? "unknown",
    researchRunId: value.researchRunId ?? "unknown",
    sequence: value.sequence ?? event.id,
    timestamp: value.timestamp ?? event.timestamp,
    phase: value.phase ?? "preparing",
    kind: value.kind ?? "status",
    message: value.message,
    sourceUrl: value.sourceUrl,
    runSourceCount: value.runSourceCount ?? 0,
    taskUniqueSourceCount: value.taskUniqueSourceCount ?? 0,
    taskActivityCount: value.taskActivityCount ?? 0,
  };
}

export function workflowPlanFromEvent(event: TaskEvent, previous?: WorkflowPlan): WorkflowPlan | undefined {
  if (event.type !== "workflow.composed") return undefined;
  const plan = event.data.workflowPlan;
  if (!plan || typeof plan !== "object") return undefined;
  const incoming = plan as WorkflowPlan;
  return {
    ...incoming,
    steps: incoming.steps.map((step) => ({
      ...step,
      task: step.task ?? previous?.steps.find((candidate) => candidate.id === step.id)?.task ?? "",
    })),
  };
}

export function applyEvent(
  snapshot: ResearchTaskSnapshot,
  event: TaskEvent,
): ResearchTaskSnapshot {
  const data = event.data;
  const statuses: Partial<Record<TaskEventType, ResearchTaskSnapshot["status"]>> = {
    "task.queued": "queued",
    "task.running": "running",
    "task.needs_input": "needs_input",
    "task.recoverable": "recoverable",
    "task.resumed": "queued",
    "task.canceling": "canceling",
    "task.canceled": "canceled",
    "task.completed": "completed",
    "task.completed_with_warnings": "completed_with_warnings",
    "task.failed": "failed",
  };
  const status = statuses[event.type];
  const plan = workflowPlanFromEvent(event, snapshot.workflowPlan);
  const next: ResearchTaskSnapshot = {
    ...snapshot,
    ...(status ? { status } : {}),
    ...(plan ? { workflowPlan: plan } : {}),
    ...(event.type === "task.needs_input" && isPendingInput(data) ? { pendingInput: data } : {}),
    ...(event.type === "task.input_received" ? { pendingInput: undefined } : {}),
    ...(event.type === "task.failed" ? { error: stringValue(data, "message") ?? stringValue(data, "error") } : {}),
    updatedAt: event.timestamp,
  };
  return next;
}

function isPendingInput(
  value: Record<string, unknown>,
): value is Record<string, unknown> & NonNullable<ResearchTaskSnapshot["pendingInput"]> {
  return typeof value.requestId === "string" &&
    typeof value.stepId === "string" &&
    typeof value.prompt === "string" &&
    (value.kind === "workflow_input" || value.kind === "human_input" || value.kind === "approval");
}
