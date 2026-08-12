import type { WorkflowDefinition } from "agency-orchestrator";

import type { ResearchMode, ResearchProfile } from "./research-profile.js";

export interface WorkflowPlan {
  schemaVersion: 1;
  workflowName: string;
  steps: WorkflowPlanStep[];
}

export interface WorkflowPlanStep {
  id: string;
  name: string;
  role: string;
  task: string;
  type: "expert" | "human_input" | "approval";
  dependsOn: string[];
  mode?: ResearchMode;
  terminal: boolean;
}

/**
 * Produces the task plan displayed to research clients. Runtime configuration,
 * model settings, and credentials stay server-side.
 */
export function projectWorkflowPlan(
  workflow: WorkflowDefinition,
  researchProfiles: ReadonlyMap<string, ResearchProfile>,
): WorkflowPlan {
  return {
    schemaVersion: 1,
    workflowName: workflow.name,
    steps: workflow.steps.map((step) => ({
      id: step.id,
      name: step.name?.trim() || step.id,
      role: step.role?.trim() || "",
      task: step.task.trim(),
      type: step.type === "human_input"
        ? "human_input"
        : step.type === "approval"
        ? "approval"
        : "expert",
      dependsOn: [...(step.depends_on ?? [])],
      ...(researchProfiles.get(step.id) === undefined
        ? {}
        : { mode: researchProfiles.get(step.id)?.mode }),
      terminal: !workflow.steps.some((candidate) =>
        candidate.depends_on?.includes(step.id)
      ),
    })),
  };
}
