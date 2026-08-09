import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  buildDAG,
  executeDAG,
  parseWorkflow,
  validateWorkflow,
  type DAGNode,
  type LLMConnector,
  type StepDefinition,
  type StepResult,
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
  stepName?: string;
  role?: string;
  agentName?: string;
  agentEmoji?: string;
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
  requestInput?: (request: WorkflowInteractiveInputRequest) => Promise<string>;
  signal?: AbortSignal;
  resume?: WorkflowResumeState;
  onCheckpointStep?: (step: StepResult) => void;
}

export interface WorkflowResumeState {
  completedSteps: StepResult[];
  outputVariables: Record<string, string>;
  fromStep?: string;
}

export interface WorkflowInputRequest {
  stepId: string;
  inputName: string;
  kind: "workflow_input" | "human_input" | "approval";
  prompt: string;
}

export interface WorkflowInteractiveInputRequest {
  stepId: string;
  inputName: string;
  kind: "human_input" | "approval";
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
  return { workflow, inputs };
}

function interactiveInputName(step: StepDefinition): string {
  if (step.type === "approval") {
    return step.output || `__approval_${step.id}`;
  }
  return step.output || `__human_input_${step.id}`;
}

export function bundledAgentsDir(): string {
  // agency-orchestrator publishes an ESM-only export. Resolving it through
  // createRequire selects the unavailable CommonJS condition at runtime.
  const aoEntry = fileURLToPath(import.meta.resolve("agency-orchestrator"));
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
    if (hasContentLengthLimit(step.task) ||
      (step.acceptance !== undefined && hasContentLengthLimit(step.acceptance))) {
      errors.push(
        `Step "${step.id}" must not impose a character, word, or token limit on research content. Require coverage and evidence instead.`,
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

function hasContentLengthLimit(value: string): boolean {
  return /(?:\b(?:at\s+least|at\s+most|no\s+more\s+than|minimum|maximum|max(?:imum)?)\s+\d[\d,]*\s*(?:words?|characters?|tokens?)\b|\b\d[\d,]*\s*(?:words?|characters?|tokens?)\s*(?:or\s+more|or\s+fewer|maximum|max(?:imum)?)\b|\d[\d,]*\s*(?:个)?(?:字|字符|词|单词|tokens?)\s*(?:以内|以下|以上|不少于|不得少于|不超过|最多|至少))/iu.test(value);
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

  const resume = resolveWorkflowResume(workflow, options.resume);
  const prepared = prepareWorkflowForExecution(
    workflow,
    { ...options.inputs, ...resume.outputVariables },
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
      ...(node.step.name?.trim() ? { stepName: node.step.name.trim() } : {}),
      ...(node.step.role?.trim() ? { role: node.step.role.trim() } : {}),
      ...(node.agentName?.trim() ? { agentName: node.agentName.trim() } : {}),
      ...(node.agentEmoji?.trim() ? { agentEmoji: node.agentEmoji.trim() } : {}),
      status: node.status,
      timestamp: new Date().toISOString(),
      verification: node.verification,
    });
  };

  const execute = () => executeDAG(dag, {
    connector: options.connector,
    agentsDir,
    llmConfig: runtimeWorkflow.llm,
    concurrency: options.concurrency ?? runtimeWorkflow.concurrency ?? 2,
    inputs: prepared.inputs,
    verify: options.verify ?? runtimeWorkflow.verify ?? false,
    skipStepIds: resume.skipStepIds,
    restoredStepMeta: resume.restoredStepMeta,
    onStepStart: (node) => emit("step.started", node),
    onStepComplete: (node) => {
      emit("step.completed", node);
      if (
        node.status === "completed" &&
        !resume.skipStepIds.has(node.step.id)
      ) {
        options.onCheckpointStep?.(stepResultForNode(node));
      }
    },
  });

  const interactiveSteps = runtimeWorkflow.steps.filter(
    (step): step is StepDefinition & { type: "human_input" | "approval" } =>
      step.type === "human_input" || step.type === "approval",
  );
  const result = interactiveSteps.length === 0
    ? await execute()
    : await executeWithRuntimeInputBridge(
      execute,
      interactiveSteps,
      options.requestInput,
      options.signal,
    );

  return result;
}

function resolveWorkflowResume(
  workflow: WorkflowDefinition,
  resume: WorkflowResumeState | undefined,
): {
  outputVariables: Record<string, string>;
  skipStepIds: Set<string>;
  restoredStepMeta: Map<string, Partial<StepResult>>;
} {
  if (!resume) {
    return {
      outputVariables: {},
      skipStepIds: new Set(),
      restoredStepMeta: new Map(),
    };
  }

  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const invalidated = resume.fromStep
    ? invalidatedStepIds(workflow, resume.fromStep)
    : new Set<string>();
  const completed = resume.completedSteps.filter(
    (step) => step.status === "completed" &&
      steps.has(step.id) &&
      !invalidated.has(step.id),
  );
  const completedIds = new Set(completed.map((step) => step.id));
  const outputVariables: Record<string, string> = {};
  for (const step of completed) {
    if (step.output_var && step.output !== undefined) {
      outputVariables[step.output_var] = step.output;
    }
  }
  return {
    outputVariables,
    skipStepIds: completedIds,
    restoredStepMeta: new Map(completed.map((step) => [step.id, step])),
  };
}

function invalidatedStepIds(
  workflow: WorkflowDefinition,
  fromStep: string,
): Set<string> {
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const target = steps.get(fromStep);
  if (!target) {
    throw new Error(`AO resume step "${fromStep}" does not exist.`);
  }
  if (target.type && target.type !== "normal") {
    throw new Error(`AO resume step "${fromStep}" must be a normal step.`);
  }
  const dependents = new Map<string, string[]>();
  for (const step of workflow.steps) {
    for (const dependency of step.depends_on ?? []) {
      const values = dependents.get(dependency) ?? [];
      values.push(step.id);
      dependents.set(dependency, values);
    }
  }
  const invalidated = new Set<string>([fromStep]);
  const pending = [fromStep];
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const dependent of dependents.get(id) ?? []) {
      if (invalidated.has(dependent)) continue;
      invalidated.add(dependent);
      pending.push(dependent);
    }
  }
  return invalidated;
}

function stepResultForNode(node: DAGNode): StepResult {
  return {
    id: node.step.id,
    role: node.step.role,
    agentName: node.agentName,
    agentEmoji: node.agentEmoji,
    status: "completed",
    output: node.result,
    output_var: node.step.output,
    acceptance: node.acceptance,
    verification: node.verification,
    duration: Math.max(0, (node.endTime ?? Date.now()) - (node.startTime ?? Date.now())),
    tokens: node.tokenUsage ?? { input: 0, output: 0 },
  };
}

let interactiveExecutionTail: Promise<void> = Promise.resolve();

async function executeWithRuntimeInputBridge(
  execute: () => Promise<WorkflowResult>,
  steps: Array<StepDefinition & { type: "human_input" | "approval" }>,
  requestInput: RunWorkflowOptions["requestInput"],
  signal: AbortSignal | undefined,
): Promise<WorkflowResult> {
  if (!requestInput) {
    throw new Error("AO workflow has an interactive step but no input handler.");
  }

  let releaseQueue!: () => void;
  const previous = interactiveExecutionTail;
  interactiveExecutionTail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  const input = new PassThrough();
  const previousStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const previousWebInput = process.env.AO_WEB_INPUT;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let pending = false;
  let aborted: Error | undefined;

  const abort = (): void => {
    aborted = signal?.reason instanceof Error
      ? signal.reason
      : new Error("AO workflow execution aborted.");
    input.end();
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      enumerable: true,
      value: input,
    });
    process.env.AO_WEB_INPUT = "1";
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const text = typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
      const match = text.match(/__AO_INPUT_REQUEST__(\{[^\n]+\})/u);
      if (!match) {
        return originalWrite(chunk, ...(args as []));
      }

      const visible = text.replace(/\n?__AO_INPUT_REQUEST__\{[^\n]+\}\n?/u, "");
      if (visible) originalWrite(visible, ...(args as []));
      if (pending) {
        aborted = new Error("AO workflow requested more than one simultaneous input.");
        input.end();
        return true;
      }

      try {
        const raw = JSON.parse(match[1]!) as {
          stepId?: unknown;
          prompt?: unknown;
          type?: unknown;
        };
        const stepId = typeof raw.stepId === "string" ? raw.stepId : "";
        const step = steps.find((candidate) => candidate.id === stepId);
        if (!step || (raw.type !== "human_input" && raw.type !== "approval")) {
          throw new Error("AO workflow emitted an invalid input request.");
        }
        pending = true;
        void requestInput({
          stepId,
          inputName: interactiveInputName(step),
          kind: raw.type,
          prompt: typeof raw.prompt === "string" && raw.prompt.trim()
            ? raw.prompt.trim()
            : step.prompt?.trim() ||
              (raw.type === "approval" ? "请确认是否继续" : "请输入补充信息"),
        }).then((answer) => {
          pending = false;
          input.write(`${answer.trim()}\n`);
        }).catch((error: unknown) => {
          pending = false;
          aborted = error instanceof Error ? error : new Error(String(error));
          input.end();
        });
      } catch (error) {
        aborted = error instanceof Error ? error : new Error(String(error));
        input.end();
      }
      return true;
    }) as typeof process.stdout.write;

    const abortedExecution = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const result = await Promise.race([execute(), abortedExecution]);
    if (aborted) throw aborted;
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    process.stdout.write = originalWrite;
    if (previousWebInput === undefined) {
      delete process.env.AO_WEB_INPUT;
    } else {
      process.env.AO_WEB_INPUT = previousWebInput;
    }
    if (previousStdin) {
      Object.defineProperty(process, "stdin", previousStdin);
    } else {
      Reflect.deleteProperty(process, "stdin");
    }
    input.end();
    releaseQueue();
  }
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
          taskTemplate: step.task,
        },
      },
    };
  }
}
