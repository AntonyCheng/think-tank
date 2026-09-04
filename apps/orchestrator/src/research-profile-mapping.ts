import type {
  StepDefinition,
  WorkflowDefinition,
} from "agency-orchestrator";

import {
  ResearchProfileError,
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfile,
  type ResearchProfileDefaults,
  type ResearchRetriever,
  type ResearchSourcePolicy,
} from "./research-profile.js";
import { assertSourceScopeWithinTask } from "./research-source-scope.js";

const PROFILE_PARAMETER = "think_tank";

export interface WorkflowResearchProfileContext {
  taskProfile: ResearchProfile;
  capabilities: ResearchCapabilities;
}

export function resolveWorkflowResearchProfiles(
  workflow: WorkflowDefinition,
  taskProfile: ResearchProfile,
  capabilities: ResearchCapabilities,
): ReadonlyMap<string, ResearchProfile> {
  assertWorkflowResearchProfilePlacement(workflow);
  const defaults = defaultsFrom(taskProfile, capabilities);
  const profiles = new Map<string, ResearchProfile>();
  for (const step of workflow.steps) {
    const hasOverride = hasThinkTankParameter(step.llm?.params);
    const path = stepProfilePath(step.id);

    if (step.type !== undefined && step.type !== "normal") {
      continue;
    }

    try {
      const inferSynthesis =
        !hasExplicitResearchMode(step) &&
        isTerminalAggregationStep(workflow, step);
      const forcedDeep =
        !inferSynthesis && !hasExplicitResearchMode(step)
          ? forcedDeepResearchOverride(taskProfile, capabilities)
          : undefined;
      const stepOverride = hasOverride
        ? profileObject(step.llm?.params?.[PROFILE_PARAMETER])
        : {};
      const mergedOverride = inferSynthesis
        ? { ...stepOverride, mode: "synthesis" }
        : forcedDeep
          ? { ...stepOverride, ...forcedDeep }
          : hasOverride
            ? stepOverride
            : undefined;
      const profile = mergedOverride !== undefined
        ? resolveResearchProfile(
          mergeProfile(taskProfile, mergedOverride),
          defaults,
          capabilities,
        )
        : taskProfile;
      assertSourceScopeWithinTask(taskProfile.source, profile.source);
      assertSynthesisPlacement(workflow, step, profile);
      profiles.set(step.id, profile);
    } catch (error) {
      if (!(error instanceof ResearchProfileError)) {
        throw error;
      }
      throw new ResearchProfileError(
        error.code,
        rebasePath(error.path, path),
        error.message,
      );
    }
  }

  return profiles;
}

function isTerminalAggregationStep(
  workflow: WorkflowDefinition,
  step: StepDefinition,
): boolean {
  const isTerminal = !workflow.steps.some(
    (candidate) => candidate.depends_on?.includes(step.id),
  );
  if (!isTerminal || (step.depends_on?.length ?? 0) === 0) {
    return false;
  }
  return referencesDependencyOutput(workflow, step);
}

function referencesDependencyOutput(
  workflow: WorkflowDefinition,
  step: StepDefinition,
): boolean {
  const dependencyOutputs = new Set(
    (step.depends_on ?? [])
      .map((dependencyId) =>
        workflow.steps.find((candidate) => candidate.id === dependencyId)
          ?.output
      )
      .filter((output): output is string => Boolean(output)),
  );
  const referencedOutputs = [
    ...step.task.matchAll(/\{\{(\w+)\}\}/gu),
  ].flatMap((match) => match[1] ? [match[1]] : []);
  return (
    dependencyOutputs.size > 0 &&
    referencedOutputs.some((output) => dependencyOutputs.has(output))
  );
}

function assertSynthesisPlacement(
  workflow: WorkflowDefinition,
  step: StepDefinition,
  profile: ResearchProfile,
): void {
  if (profile.mode !== "synthesis") return;

  if (!referencesDependencyOutput(workflow, step)) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      "$.mode",
      "Synthesis steps must reference output from a declared dependency.",
    );
  }
}

function hasExplicitResearchMode(step: StepDefinition): boolean {
  const value = step.llm?.params?.[PROFILE_PARAMETER];
  return isObject(value) && Object.hasOwn(value, "mode");
}

/**
 * Operator switch: when GPTR_RESEARCH_FORCE_DEEP is set, every web-search
 * research step that has not chosen its own mode runs in deep mode. Deep owns
 * the recursive web exploration, so it is only forced where a web search is
 * already permitted (not url-only, local, or hybrid). The value may be
 * "<breadth>x<depth>x<concurrency>" (default "2x1x1"); breadth and depth are
 * clamped to the deployment's deep-research limits.
 */
function forcedDeepResearchOverride(
  taskProfile: ResearchProfile,
  capabilities: ResearchCapabilities,
):
  | { mode: "deep"; deep: { breadth: number; depth: number; concurrency: number } }
  | undefined {
  const raw = process.env.GPTR_RESEARCH_FORCE_DEEP?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return undefined;
  if (taskProfile.source.mode !== "web") return undefined;
  const shape = raw.match(/^(\d+)x(\d+)x(\d+)$/i);
  const limits = capabilities.deepResearch;
  const clamp = (value: number, max: number | undefined) =>
    Math.max(1, max ? Math.min(value, max) : value);
  return {
    mode: "deep",
    deep: {
      breadth: clamp(shape ? Number(shape[1]) : 2, limits?.maxBreadth),
      depth: clamp(shape ? Number(shape[2]) : 1, limits?.maxDepth),
      concurrency: Math.min(Math.max(1, shape ? Number(shape[3]) : 1), 4),
    },
  };
}

export function assertWorkflowResearchProfilePlacement(
  workflow: WorkflowDefinition,
): void {
  if (hasThinkTankParameter(workflow.llm?.params)) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      "$.llm.params.think_tank",
      "Workflow-level think_tank configuration is not allowed.",
    );
  }

  for (const step of workflow.steps) {
    const hasOverride = hasThinkTankParameter(step.llm?.params);
    const path = stepProfilePath(step.id);

    if (
      hasOverride &&
      (step.type === "human_input" || step.type === "approval")
    ) {
      throw new ResearchProfileError(
        "profile_invariant_violation",
        path,
        "Interactive workflow steps cannot declare a research profile.",
      );
    }
  }
}

function mergeProfile(
  taskProfile: ResearchProfile,
  value: unknown,
): Record<string, unknown> {
  const override = profileObject(value);
  const merged: Record<string, unknown> = {
    ...taskProfile,
    ...override,
  };

  if (Object.hasOwn(override, "quality")) {
    merged.quality = mergeObject(taskProfile.quality, override.quality);
  }
  if (Object.hasOwn(override, "limits")) {
    merged.limits = mergeObject(taskProfile.limits, override.limits);
  }
  if (Object.hasOwn(override, "source")) {
    merged.source = mergeSource(taskProfile.source, override.source);
  }

  const mode = Object.hasOwn(override, "mode")
    ? override.mode
    : taskProfile.mode;
  if (
    mode === "synthesis" &&
    !hasExplicitCurateSources(override.quality)
  ) {
    merged.quality = {
      ...taskProfile.quality,
      ...(isObject(override.quality) ? override.quality : {}),
      curateSources: false,
    };
  }
  const hasExplicitDeep = Object.hasOwn(override, "deep");
  if (mode !== "deep" && !hasExplicitDeep) {
    delete merged.deep;
  } else if (
    mode === "deep" &&
    !hasExplicitDeep &&
    taskProfile.mode !== "deep"
  ) {
    delete merged.deep;
  }

  return merged;
}

function hasExplicitCurateSources(value: unknown): boolean {
  return isObject(value) && Object.hasOwn(value, "curateSources");
}

function mergeSource(
  taskSource: ResearchSourcePolicy,
  value: unknown,
): unknown {
  if (!isObject(value)) {
    return value;
  }

  const stepMode = value.mode === undefined ? "web" : value.mode;
  if (taskSource.mode !== "web" || stepMode !== "web") {
    return value;
  }

  return {
    ...taskSource,
    ...value,
  };
}

function mergeObject(
  base: object,
  value: unknown,
): unknown {
  if (!isObject(value)) {
    return value;
  }
  return {
    ...base as Record<string, unknown>,
    ...value,
  };
}

function profileObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      "$",
      "The step research profile must be an object.",
    );
  }
  return value;
}

function defaultsFrom(
  taskProfile: ResearchProfile,
  capabilities: ResearchCapabilities,
): ResearchProfileDefaults {
  const configuredRetrievers = webPolicyFrom(
    taskProfile.source,
  )?.retrievers;
  const configured = configuredRetrievers?.[0] ??
    capabilities.retrievers[0];
  if (!configured) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.retrievers",
      "At least one research retriever must be enabled.",
    );
  }
  return {
    defaultRetriever: configured,
    defaultRetrievers: configuredRetrievers,
  };
}

function webPolicyFrom(source: ResearchSourcePolicy):
  | { retrievers: readonly ResearchRetriever[] }
  | undefined {
  if (source.mode === "web") return source;
  if ("web" in source) return source.web;
  return undefined;
}

function hasThinkTankParameter(
  params: Record<string, unknown> | undefined,
): boolean {
  return params !== undefined && Object.hasOwn(params, PROFILE_PARAMETER);
}

function stepProfilePath(stepId: StepDefinition["id"]): string {
  return `$.steps[${JSON.stringify(stepId)}].llm.params.think_tank`;
}

function rebasePath(path: string, base: string): string {
  return path === "$" ? base : `${base}${path.slice(1)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
