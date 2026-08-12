export type TaskStatus =
  | "queued"
  | "recoverable"
  | "running"
  | "needs_input"
  | "canceling"
  | "canceled"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export type WorkflowStepType = "expert" | "human_input" | "approval";

export interface WorkflowStep {
  id: string;
  name: string;
  role: string;
  task: string;
  type: WorkflowStepType;
  dependsOn: string[];
  mode?: string;
  terminal: boolean;
}

export interface WorkflowPlan {
  schemaVersion: number;
  workflowName: string;
  steps: WorkflowStep[];
}

export interface PendingInput {
  requestId: string;
  stepId: string;
  inputName?: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export interface ResearchRunProgress {
  aoStepId: string;
  researchRunId: string;
  mode: string;
  state: "queued" | "running" | "completed" | "failed" | "canceled";
  phase: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  elapsedMs: number;
  sourceCount: number;
  activityCount?: number;
  deep?: {
    completedQueries?: number;
    totalQueries?: number;
    currentLevel?: number;
    totalLevels?: number;
  };
  cost: { amount?: number; status: string };
}

export interface ResearchTelemetry {
  runs: ResearchRunProgress[];
  summary: {
    runCount: number;
    completedRunCount: number;
    uniqueSourceCount: number;
    activityCount?: number;
    totalElapsedMs: number;
    reportedCostUsd: number;
  };
}

export interface ResearchTaskSnapshot {
  id: string;
  topic: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  workflowPlan?: WorkflowPlan;
  output?: string;
  warnings?: string[];
  error?: string;
  pendingInput?: PendingInput;
  researchTelemetry?: ResearchTelemetry;
  evidenceBundles?: Array<{ aoStepId: string; sources?: unknown[] }>;
}

export type ResearchHistoryFilter = "all" | "completed" | "warnings" | "unfinished";

export interface ResearchHistoryItem {
  id: string;
  topic: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  expertCount: number;
  sourceCount: number;
  warningCount: number;
  hasReport: boolean;
}

export interface ResearchHistoryPage {
  items: ResearchHistoryItem[];
  nextCursor?: string;
}

export interface ResearchTaskDiagnostic {
  id: number;
  timestamp: string;
  stage: string;
  message: string;
}
