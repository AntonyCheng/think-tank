import { createHash, randomUUID } from "node:crypto";

import type { StepResult } from "agency-orchestrator";

import type { EvidenceBundle } from "./evidence-bundle.js";

export interface CheckpointPendingInput {
  stepId: string;
  inputName?: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export interface WorkflowCheckpoint {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  parentRunId?: string;
  reason: "initial" | "resume" | "from_step";
  sequence: number;
  createdAt: string;
  workflow: {
    yaml: string;
    sha256: string;
  };
  inputs: Record<string, string>;
  inputHash: string;
  runtimeFingerprint: string;
  policyFingerprint: string;
  completedSteps: StepResult[];
  outputVariables: Record<string, string>;
  evidenceBundles: EvidenceBundle[];
  pendingInput?: CheckpointPendingInput;
}

export interface WorkflowRunRequest {
  checkpoint: WorkflowCheckpoint;
  fromStep?: string;
}

export function checkpointHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function createRunId(): string {
  return randomUUID();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}
