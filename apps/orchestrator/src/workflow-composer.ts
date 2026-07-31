import {
  composeWorkflow,
  parseWorkflow,
  validateWorkflow,
} from "agency-orchestrator";

import { preflightWorkflow } from "./ao-runtime.js";
import type {
  WorkflowResearchProfileContext,
} from "./research-profile-mapping.js";
import type { RelativeYearScope } from "./task-temporal-context.js";
import {
  validateWorkflowRelativeYearScope,
} from "./workflow-temporal-validation.js";
import { analyzeWorkflowTopology } from "./workflow-topology.js";

type ComposeWorkflowOptions = Parameters<typeof composeWorkflow>[0];
type ComposeWorkflowResult = Awaited<ReturnType<typeof composeWorkflow>>;

export type ResearchWorkflowComposer = (
  options: ComposeWorkflowOptions,
) => Promise<ComposeWorkflowResult>;

export async function composeValidatedWorkflow(
  options: ComposeWorkflowOptions,
  compose: ResearchWorkflowComposer = composeWorkflow,
  researchContext?: WorkflowResearchProfileContext,
  relativeYearScope?: RelativeYearScope,
): Promise<ComposeWorkflowResult> {
  const first = await compose(options);
  const firstErrors = validateComposedWorkflow(
    first.savedPath,
    options.agentsDir,
    researchContext,
    relativeYearScope,
  );
  if (firstErrors.length === 0) {
    return withTopologyWarnings(first);
  }

  const second = await compose({
    ...options,
    description: recomposeDescription(options.description, firstErrors),
  });
  const secondErrors = validateComposedWorkflow(
    second.savedPath,
    options.agentsDir,
    researchContext,
    relativeYearScope,
  );
  if (secondErrors.length > 0) {
    throw new Error(
      [
        "AO 工作流自动重新编排后仍未通过预检：",
        ...secondErrors.map((error) => `- ${error}`),
      ].join("\n"),
    );
  }

  return withTopologyWarnings({
    ...second,
    warnings: [
      "AO 第一次编排未通过预检，已自动重新编排。",
      ...second.warnings,
    ],
  });
}

function withTopologyWarnings(
  result: ComposeWorkflowResult,
): ComposeWorkflowResult {
  const workflow = parseWorkflow(result.savedPath);
  const topology = analyzeWorkflowTopology(workflow);
  return {
    ...result,
    warnings: [...result.warnings, ...topology.warnings],
  };
}

export function validateComposedWorkflow(
  workflowPath: string,
  agentsDir: string,
  researchContext?: WorkflowResearchProfileContext,
  relativeYearScope?: RelativeYearScope,
): string[] {
  try {
    const workflow = parseWorkflow(workflowPath);
    const parserErrors = validateWorkflow(workflow, agentsDir);
    if (parserErrors.length > 0) {
      return [...new Set(parserErrors)];
    }
    return [
      ...preflightWorkflow(workflow, agentsDir, researchContext),
      ...validateWorkflowRelativeYearScope(workflow, relativeYearScope),
    ];
  } catch (error) {
    return [
      error instanceof Error ? error.message : String(error),
    ];
  }
}

function recomposeDescription(
  originalDescription: string,
  errors: readonly string[],
): string {
  return [
    originalDescription,
    "",
    "上一轮 AO 工作流未通过执行前预检，请重新生成完整 YAML。",
    "校验错误：",
    ...errors.map((error) => `- ${error}`),
    "",
    "重新编排要求（必须遵守）：",
    "- 每个 depends_on 值必须逐字匹配同一 YAML 中已声明的 steps[].id。",
    "- depends_on 不得填写 step.output 名称或自行改写的近似名称。",
    "- 输出完整工作流，不要输出解释或局部补丁。",
  ].join("\n");
}
