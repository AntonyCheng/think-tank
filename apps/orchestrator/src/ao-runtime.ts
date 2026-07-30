import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import {
  buildDAG,
  executeDAG,
  parseWorkflow,
  validateWorkflow,
  type DAGNode,
  type LLMConnector,
  type StepDefinition,
  type WorkflowDefinition,
  type WorkflowResult,
} from "agency-orchestrator";

import {
  assertWorkflowResearchProfilePlacement,
  resolveWorkflowResearchProfiles,
  type WorkflowResearchProfileContext,
} from "./research-profile-mapping.js";
import type { ResearchProfile } from "./research-profile.js";

const require = createRequire(import.meta.url);

export interface WorkflowRuntimeEvent {
  type: "step.started" | "step.completed";
  stepId: string;
  status: DAGNode["status"];
  timestamp: string;
  verification?: NonNullable<DAGNode["verification"]>;
}

export interface RunWorkflowOptions {
  connector: LLMConnector;
  agentsDir?: string;
  inputs?: Record<string, string>;
  concurrency?: number;
  verify?: boolean;
  researchProfiles?: ReadonlyMap<string, ResearchProfile>;
  onEvent?: (event: WorkflowRuntimeEvent) => void;
}

export interface WorkflowInputRequest {
  stepId: string;
  inputName: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export function collectWorkflowInputRequests(
  workflow: WorkflowDefinition,
  provided: Record<string, string>,
): WorkflowInputRequest[] {
  const requests: WorkflowInputRequest[] = [];
  for (const input of workflow.inputs ?? []) {
    if (
      !provided[input.name]?.trim() &&
      input.default === undefined
    ) {
      requests.push({
        stepId: `input:${input.name}`,
        inputName: input.name,
        kind: "workflow_input",
        prompt: input.description?.trim() || `请输入 ${input.name}`,
      });
    }
  }
  for (const step of workflow.steps) {
    if (step.type !== "human_input" && step.type !== "approval") {
      continue;
    }
    const inputName = interactiveInputName(step);
    if (provided[inputName]?.trim()) {
      continue;
    }
    requests.push({
      stepId: step.id,
      inputName,
      kind: step.type,
      prompt: step.prompt?.trim() ||
        (step.type === "approval" ? "请确认是否继续 (yes/no)" : "请输入"),
    });
  }
  return requests;
}

export function prepareWorkflowForExecution(
  source: WorkflowDefinition,
  provided: Record<string, string>,
): { workflow: WorkflowDefinition; inputs: Map<string, string> } {
  const workflow = structuredClone(source);
  const inputs = new Map<string, string>();
  for (const input of workflow.inputs ?? []) {
    if (input.default !== undefined) {
      inputs.set(input.name, input.default);
    }
  }
  for (const [name, value] of Object.entries(provided)) {
    inputs.set(name, value);
  }
  for (const step of workflow.steps) {
    if (step.type === "human_input" || step.type === "approval") {
      step.output = interactiveInputName(step);
      // AO's library executor can prefill human_input from its context.
      // approval always reads process.stdin, so the HTTP adapter normalizes
      // it to the equivalent prefilled human_input in this runtime copy.
      step.type = "human_input";
    }
  }
  return { workflow, inputs };
}

function interactiveInputName(step: StepDefinition): string {
  if (step.type === "approval") {
    return step.output || `__approval_${step.id}`;
  }
  return step.output || `__human_input_${step.id}`;
}

export function bundledAgentsDir(): string {
  const aoEntry = require.resolve("agency-orchestrator");
  return resolve(dirname(aoEntry), "..", "agency-agents");
}

export function agentsDirForLanguage(lang: "zh" | "en"): string {
  if (lang === "en") {
    return bundledAgentsDir();
  }

  const packageJson = require.resolve("agency-agents-zh/package.json");
  return dirname(packageJson);
}

export function preflightWorkflow(
  workflow: WorkflowDefinition,
  agentsDir: string,
  researchContext?: WorkflowResearchProfileContext,
): string[] {
  const errors = [...validateWorkflow(workflow, agentsDir)];
  const dag = buildDAG(workflow);
  const terminalNodes = [...dag.nodes.values()].filter(
    (node) => node.dependents.length === 0,
  );

  if (terminalNodes.length !== 1) {
    errors.push(
      `Research workflow must have exactly one terminal deliverable step; found ${terminalNodes.length}.`,
    );
  } else if (terminalNodes[0]?.step.type !== undefined &&
             terminalNodes[0].step.type !== "normal") {
    errors.push("The terminal deliverable step must be a normal expert step.");
  } else if (!terminalNodes[0]?.step.acceptance?.trim()) {
    errors.push(
      `Terminal step "${terminalNodes[0]?.step.id}" must declare non-empty acceptance criteria.`,
    );
  }

  for (const step of workflow.steps) {
    const unsafeFields = unsafeStepLlmFields(step);
    if (unsafeFields.length > 0) {
      errors.push(
        `Step "${step.id}" cannot override ${unsafeFields.join(", ")} because it would bypass the GPT Researcher connector.`,
      );
    }
  }

  try {
    if (researchContext) {
      resolveWorkflowResearchProfiles(
        workflow,
        researchContext.taskProfile,
        researchContext.capabilities,
      );
    } else {
      assertWorkflowResearchProfilePlacement(workflow);
    }
  } catch (error) {
    errors.push(
      error instanceof Error && "path" in error
        ? `${String(error.path)}: ${error.message}`
        : error instanceof Error ? error.message : String(error),
    );
  }

  return [...new Set(errors)];
}

function unsafeStepLlmFields(step: StepDefinition): string[] {
  if (!step.llm) {
    return [];
  }

  return (["provider", "base_url", "api_key"] as const).filter(
    (field) => step.llm?.[field] !== undefined,
  );
}

export async function runWorkflowFile(
  workflowPath: string,
  options: RunWorkflowOptions,
): Promise<WorkflowResult> {
  const workflow = parseWorkflow(workflowPath);
  const agentsDir = options.agentsDir ?? bundledAgentsDir();
  const errors = preflightWorkflow(workflow, agentsDir);

  if (errors.length > 0) {
    throw new Error(`Invalid AO workflow:\n- ${errors.join("\n- ")}`);
  }

  const prepared = prepareWorkflowForExecution(
    workflow,
    options.inputs ?? {},
  );
  const runtimeWorkflow = prepared.workflow;
  injectResearchProfiles(runtimeWorkflow, options.researchProfiles);
  injectResearchStepContext(runtimeWorkflow);
  const dag = buildDAG(runtimeWorkflow);
  const emit = (
    type: WorkflowRuntimeEvent["type"],
    node: DAGNode,
  ): void => {
    options.onEvent?.({
      type,
      stepId: node.step.id,
      status: node.status,
      timestamp: new Date().toISOString(),
      verification: node.verification,
    });
  };

  const result = await executeDAG(dag, {
    connector: options.connector,
    agentsDir,
    llmConfig: runtimeWorkflow.llm,
    concurrency: options.concurrency ?? runtimeWorkflow.concurrency ?? 2,
    inputs: prepared.inputs,
    verify: options.verify ?? runtimeWorkflow.verify ?? false,
    onStepStart: (node) => emit("step.started", node),
    onStepComplete: (node) => emit("step.completed", node),
  });

  return result;
}

function injectResearchProfiles(
  workflow: WorkflowDefinition,
  profiles: ReadonlyMap<string, ResearchProfile> | undefined,
): void {
  if (!profiles) return;
  for (const step of workflow.steps) {
    const profile = profiles.get(step.id);
    if (!profile) continue;
    step.llm = {
      ...step.llm,
      params: {
        ...step.llm?.params,
        think_tank: profile,
      },
    };
  }
}

function injectResearchStepContext(
  workflow: WorkflowDefinition,
): void {
  for (const step of workflow.steps) {
    if (
      step.type !== undefined &&
      step.type !== "normal"
    ) {
      continue;
    }
    step.llm = {
      ...step.llm,
      params: {
        ...step.llm?.params,
        think_tank_runtime: {
          aoStepId: step.id,
          dependsOn: [...(step.depends_on ?? [])],
        },
      },
    };
  }
}
