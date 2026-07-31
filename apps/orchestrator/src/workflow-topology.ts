import type { WorkflowDefinition } from "agency-orchestrator";

export interface WorkflowTopologyAnalysis {
  criticalPathLength: number;
  maximumWidth: number;
  researchBranchCount: number;
  warnings: string[];
}

/**
 * Reports topology facts without rewriting a model-authored workflow. A
 * dependency is only suspicious when the downstream task does not reference
 * the declared dependency output at all; semantic dependencies remain intact.
 */
export function analyzeWorkflowTopology(
  workflow: WorkflowDefinition,
): WorkflowTopologyAnalysis {
  const steps = workflow.steps;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const levelCounts = new Map<number, number>();
  let criticalPathLength = 0;

  for (const step of steps) {
    const dependencies = step.depends_on ?? [];
    const stepDepth = dependencies.length === 0
      ? 1
      : 1 + Math.max(...dependencies.map((id) => depth.get(id) ?? 0));
    depth.set(step.id, stepDepth);
    levelCounts.set(stepDepth, (levelCounts.get(stepDepth) ?? 0) + 1);
    criticalPathLength = Math.max(criticalPathLength, stepDepth);
  }

  const roots = steps.filter((step) => (step.depends_on?.length ?? 0) === 0);
  const warnings = steps.flatMap((step) => {
    const dependencies = step.depends_on ?? [];
    if (dependencies.length !== 1 || step.type === "human_input" || step.type === "approval") {
      return [];
    }
    const dependency = byId.get(dependencies[0]!);
    if (!dependency?.output || referencesOutput(step.task, dependency.output)) {
      return [];
    }
    return [
      `步骤 "${step.id}" 依赖 "${dependency.id}"，但 task 未引用其 output；请确认这不是仅用于排序的依赖。`,
    ];
  });

  return {
    criticalPathLength,
    maximumWidth: Math.max(0, ...levelCounts.values()),
    researchBranchCount: roots.filter((step) => step.type === undefined || step.type === "normal").length,
    warnings,
  };
}

function referencesOutput(task: string, output: string): boolean {
  return task.includes(`{{${output}}}`);
}
