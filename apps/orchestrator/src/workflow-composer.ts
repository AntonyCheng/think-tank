import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  buildRoleCatalog,
  composeWorkflow,
  createConnector,
  extractYamlFromResponse,
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

const MAX_RECOMPOSITION_ATTEMPTS = 2;

type ComposeWorkflowOptions = Parameters<typeof composeWorkflow>[0];
type ComposeWorkflowResult = Awaited<ReturnType<typeof composeWorkflow>>;

export type ResearchWorkflowComposer = (
  options: ComposeWorkflowOptions,
) => Promise<ComposeWorkflowResult>;

export interface WorkflowRecompositionAttempt {
  attempt: number;
  maxAttempts: number;
  errorCount: number;
}

export type WorkflowRecompositionObserver = (
  attempt: WorkflowRecompositionAttempt,
) => void;

export interface WorkflowCompositionDiagnostic {
  stage: "response_extraction" | "workflow_validation";
  message: string;
  workflowPath?: string;
  validationErrors?: string[];
  rawOutput?: string;
}

export type WorkflowCompositionDiagnosticObserver = (
  diagnostic: WorkflowCompositionDiagnostic,
) => void;

export class WorkflowCompositionError extends Error {
  readonly diagnostic: WorkflowCompositionDiagnostic;

  constructor(
    message: string,
    diagnostic: WorkflowCompositionDiagnostic,
  ) {
    super(message);
    this.name = "WorkflowCompositionError";
    this.diagnostic = diagnostic;
  }
}

export async function composeValidatedWorkflow(
  options: ComposeWorkflowOptions,
  compose: ResearchWorkflowComposer = composeResearchWorkflow,
  researchContext?: WorkflowResearchProfileContext,
  relativeYearScope?: RelativeYearScope,
  onRecomposition?: WorkflowRecompositionObserver,
  onDiagnostic?: WorkflowCompositionDiagnosticObserver,
): Promise<ComposeWorkflowResult> {
  let composed = await composeWithDiagnostics(options, compose, onDiagnostic);
  let errors = validateComposedWorkflow(
    composed.savedPath,
    options.agentsDir,
    researchContext,
    relativeYearScope,
  );
  if (errors.length === 0) {
    return withTopologyWarnings(composed);
  }
  onDiagnostic?.(validationDiagnostic(composed, errors));

  for (let attempt = 1; attempt <= MAX_RECOMPOSITION_ATTEMPTS; attempt += 1) {
    onRecomposition?.({
      attempt,
      maxAttempts: MAX_RECOMPOSITION_ATTEMPTS,
      errorCount: errors.length,
    });
    composed = await composeWithDiagnostics({
      ...options,
      description: recomposeDescription(
        options.description,
        errors,
        attempt,
        MAX_RECOMPOSITION_ATTEMPTS,
      ),
    }, compose, onDiagnostic);
    errors = validateComposedWorkflow(
      composed.savedPath,
      options.agentsDir,
      researchContext,
      relativeYearScope,
    );
    if (errors.length === 0) {
      return withTopologyWarnings({
        ...composed,
        warnings: [
          `AO 初稿未通过预检，已在第 ${attempt} 次自动重编排后修复。`,
          ...composed.warnings,
        ],
      });
    }
    onDiagnostic?.(validationDiagnostic(composed, errors));
  }

  throw new Error(
    [
      `AO 工作流经过 ${MAX_RECOMPOSITION_ATTEMPTS} 次自动重编排后仍未通过预检：`,
      ...errors.map((error) => `- ${error}`),
    ].join("\n"),
  );
}

async function composeWithDiagnostics(
  options: ComposeWorkflowOptions,
  compose: ResearchWorkflowComposer,
  onDiagnostic?: WorkflowCompositionDiagnosticObserver,
): Promise<ComposeWorkflowResult> {
  try {
    return await compose(options);
  } catch (error) {
    if (error instanceof WorkflowCompositionError) {
      onDiagnostic?.(error.diagnostic);
    }
    throw error;
  }
}

function validationDiagnostic(
  composed: ComposeWorkflowResult,
  validationErrors: string[],
): WorkflowCompositionDiagnostic {
  return {
    stage: "workflow_validation",
    message: "Generated workflow did not pass preflight validation.",
    workflowPath: composed.savedPath,
    validationErrors,
    rawOutput: composed.yaml,
  };
}

export async function composeResearchWorkflow(
  options: ComposeWorkflowOptions,
): Promise<ComposeWorkflowResult> {
  const roles = buildRoleCatalog(options.agentsDir);
  if (roles.length === 0) {
    throw new WorkflowCompositionError(
      "AO role catalog is empty.",
      {
        stage: "response_extraction",
        message: "The configured AO role catalog is empty.",
      },
    );
  }

  const connector = createConnector(options.llmConfig);
  let rawOutput: string;
  try {
    const result = await connector.chat(
      buildResearchComposeSystemPrompt(roles, options),
      options.description,
      {
        ...options.llmConfig,
        max_tokens: options.llmConfig.max_tokens ?? 8_192,
      },
    );
    rawOutput = result.content;
  } catch (error) {
    throw new WorkflowCompositionError(
      "AO workflow generation request failed.",
      {
        stage: "response_extraction",
        message: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const yaml = extractYamlFromResponse(rawOutput);
  if (!yaml || !yaml.includes("steps:")) {
    throw new WorkflowCompositionError(
      "AO did not return an extractable workflow YAML. The private task diagnostics retain the original response.",
      {
        stage: "response_extraction",
        message: "The model response did not contain a complete YAML workflow with steps.",
        rawOutput,
      },
    );
  }

  const saveDir = resolve(options.saveDir ?? ".think-tank/workflows");
  await mkdir(saveDir, { recursive: true });
  const fileName = `${workflowFileStem(options.description)}-${randomUUID()}.yaml`;
  const savedPath = resolve(saveDir, fileName);
  await writeFile(savedPath, `${yaml.trim()}\n`, "utf8");
  return {
    yaml,
    savedPath,
    relativePath: fileName,
    warnings: [],
  };
}

export function buildResearchComposeSystemPrompt(
  roles: ReadonlyArray<{ path: string; name: string; description: string }>,
  options: Pick<ComposeWorkflowOptions, "agentsDirName" | "llmConfig" | "timeoutMs">,
): string {
  const provider = JSON.stringify(options.llmConfig.provider);
  const model = options.llmConfig.model
    ? `  model: ${JSON.stringify(options.llmConfig.model)}\n`
    : "";
  const agentsDir = JSON.stringify(options.agentsDirName ?? "agency-agents-zh");
  const timeout = options.timeoutMs ?? 300_000;
  const catalog = roles.map((role) =>
    `- ${role.path} | ${role.name} | ${role.description}`
  ).join("\n");

  return `You are a research workflow architect. Return only one complete YAML code block, with no explanation.

The workflow is executed immediately. Do not generate inputs. Put the research request directly in the task fields.

Required YAML shape:
\`\`\`yaml
name: "Workflow name"
description: "One-line description"
agents_dir: ${agentsDir}
llm:
  provider: ${provider}
${model}  max_tokens: 8192
  timeout: ${timeout}
  retry: 2
concurrency: 3
steps:
  - id: expert_step
    role: "exact/catalog-role-path"
    name: "Expert title"
    task: |
      Specific research assignment.
    output: expert_findings
  - id: final_report
    role: "exact/catalog-role-path"
    name: "Lead analyst"
    task: |
      Synthesize {{expert_findings}} into the final report.
    output: final_report
    depends_on: [expert_step]
    acceptance: |
      1. The report covers the assigned research dimensions.
      2. Material factual claims retain inline source links.
\`\`\`

Rules:
- Use only exact role paths from the catalog.
- Use snake_case for every id and output. Each referenced {{variable}} must be an output from a listed dependency.
- Use independent research experts as parallel root steps. Use exactly one terminal, normal expert step to synthesize their outputs.
- Every normal step needs non-empty id, role, task, and output. The final step also needs 2-5 objectively checkable acceptance conditions.
- Never impose a character, word, or token limit in any task or acceptance criterion. Define report depth through coverage, evidence, comparison, implications, and uncertainty.
- Do not generate a references section. Keep observed source URLs inline in expert reports for later citation processing.

Available role catalog:
${catalog}`;
}

function workflowFileStem(description: string): string {
  const firstLine = description.trim().split(/\r?\n/u, 1)[0] || "research-workflow";
  const safe = firstLine
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return safe.slice(0, 80) || "research-workflow";
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
  attempt: number,
  maxAttempts: number,
): string {
  return [
    originalDescription,
    "",
    `上一轮 AO 工作流未通过执行前预检。这是第 ${attempt}/${maxAttempts} 次修复机会，请重新生成完整 YAML。`,
    "校验错误：",
    ...errors.map((error) => `- ${error}`),
    "",
    "重新编排要求（必须逐项满足）：",
    "- 每个普通步骤都必须声明非空 id、role、task 和 output。task 不得省略；请使用 task: | 并写入该专家的实际工作说明。",
    "- 唯一的最终交付步骤必须为普通步骤，并且必须声明非空 acceptance: 字段。",
    "- 每个 depends_on 值必须逐字匹配同一 YAML 中已经声明的 steps[].id。",
    "- depends_on 不得填写 step.output 名称或自行改写的近似名称。",
    ...targetedRepairRequirements(errors),
    "- 输出完整工作流 YAML，不要输出解释、Markdown 代码围栏或局部补丁。",
  ].join("\n");
}

function targetedRepairRequirements(errors: readonly string[]): string[] {
  const missingTaskStepIds = errors.flatMap((error) => {
    const match = /step\s+["']?([^"'\s]+)["']?\s+(?:缺少|lacks|missing)\s+task/iu.exec(
      error,
    );
    return match?.[1] ? [match[1]] : [];
  });
  return [...new Set(missingTaskStepIds)].map((stepId) =>
    `- 必须修复步骤 "${stepId}"：保留其 id、role 和 output，并添加非空 task: | 块；不要删除该步骤或以空字符串代替任务说明。`
  );
}
