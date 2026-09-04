import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { WorkflowDefinition } from "agency-orchestrator";

import {
  resolveWorkflowResearchProfiles,
} from "../src/research-profile-mapping.js";
import {
  ResearchProfileError,
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfileDefaults,
} from "../src/research-profile.js";
import {
  currentResearchProfileEnvironment,
} from "../src/research-profile-runtime.js";

interface MergeFixtureCase {
  name: string;
  environment: string;
  taskInput: unknown;
  stepOverride?: unknown;
  expected?: unknown;
  error?: {
    code: string;
    path: string;
  };
}

interface MergeFixtureEnvironment {
  defaults: ResearchProfileDefaults;
  capabilities: ResearchCapabilities;
}

interface MergeFixtureFile {
  environments: Record<string, MergeFixtureEnvironment>;
  cases: MergeFixtureCase[];
}

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/research-profile/v1/merge-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as MergeFixtureFile;

for (const fixture of fixtures.cases) {
  test(`ResearchProfile mapping: ${fixture.name}`, () => {
    const environment = fixtures.environments[fixture.environment];
    assert.ok(environment, `unknown fixture environment ${fixture.environment}`);
    const taskProfile = resolveResearchProfile(
      fixture.taskInput,
      environment.defaults,
      environment.capabilities,
    );
    const workflow = workflowWithStepOverride(
      Object.hasOwn(fixture, "stepOverride"),
      fixture.stepOverride,
    );

    if (fixture.expected !== undefined) {
      const result = resolveWorkflowResearchProfiles(
        workflow,
        taskProfile,
        environment.capabilities,
      );
      assert.deepEqual(result.get("research_market"), fixture.expected);
      assert.equal(isDeeplyFrozen(result.get("research_market")), true);
      return;
    }

    assert.throws(
      () =>
        resolveWorkflowResearchProfiles(
          workflow,
          taskProfile,
          environment.capabilities,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ResearchProfileError);
        assert.equal(error.code, fixture.error?.code);
        assert.equal(error.path, fixture.error?.path);
        return true;
      },
    );
  });
}

test("workflow-level think_tank configuration is rejected", () => {
  const environment = fixtures.environments.current!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.llm.params = { think_tank: {} };

  assert.throws(
    () =>
      resolveWorkflowResearchProfiles(
        workflow,
        taskProfile,
        environment.capabilities,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_invariant_violation");
      assert.equal(error.path, "$.llm.params.think_tank");
      return true;
    },
  );
});

test("interactive steps cannot declare a research profile", () => {
  const environment = fixtures.environments.current!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps.unshift({
    id: "clarify",
    type: "human_input",
    role: "",
    task: "",
    llm: { params: { think_tank: {} } },
  });

  assert.throws(
    () =>
      resolveWorkflowResearchProfiles(
        workflow,
        taskProfile,
        environment.capabilities,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_invariant_violation");
      assert.equal(
        error.path,
        "$.steps[\"clarify\"].llm.params.think_tank",
      );
      return true;
    },
  );
});

test("synthesis steps require referenced output from a declared dependency", () => {
  const environment = fixtures.environments.expanded!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.llm = {
    params: { think_tank: { mode: "synthesis" } },
  };

  assert.throws(
    () =>
      resolveWorkflowResearchProfiles(
        workflow,
        taskProfile,
        environment.capabilities,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_invariant_violation");
      assert.equal(
        error.path,
        '$.steps["final"].llm.params.think_tank.mode',
      );
      return true;
    },
  );
});

test("synthesis steps can reuse rendered outputs from their AO dependencies", () => {
  const environment = fixtures.environments.expanded!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";
  workflow.steps[1]!.llm = {
    params: { think_tank: { mode: "synthesis" } },
  };

  const profiles = resolveWorkflowResearchProfiles(
    workflow,
    taskProfile,
    environment.capabilities,
  );

  assert.equal(profiles.get("final")?.mode, "synthesis");
  assert.equal(
    profiles.get("final")?.quality.curateSources,
    false,
    "terminal synthesis must not inherit task-level source curation",
  );
});

test("terminal aggregation steps default to synthesis without an explicit mode", () => {
  const environment = fixtures.environments.expanded!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";

  const profiles = resolveWorkflowResearchProfiles(
    workflow,
    taskProfile,
    environment.capabilities,
  );

  assert.equal(profiles.get("final")?.mode, "synthesis");
  assert.equal(profiles.get("research_market")?.mode, "standard");
});

test("URL-only task source grants survive terminal synthesis inference", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    {
      source: {
        mode: "urls",
        urls: ["https://www.hrbcu.edu.cn/xxgk/sdjj.htm"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "school_research";
  workflow.steps[1]!.task = "Synthesize {{school_research}}.";

  const profiles = resolveWorkflowResearchProfiles(
    workflow,
    taskProfile,
    environment.capabilities,
  );

  assert.equal(profiles.get("final")?.mode, "synthesis");
  assert.deepEqual(profiles.get("final")?.source, taskProfile.source);
});

test("domain-constrained task source grants survive terminal synthesis inference", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    {
      source: {
        mode: "web",
        retrievers: ["duckduckgo"],
        includeDomains: ["hrbcu.edu.cn"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "school_research";
  workflow.steps[1]!.task = "Synthesize {{school_research}}.";

  const profiles = resolveWorkflowResearchProfiles(
    workflow,
    taskProfile,
    environment.capabilities,
  );

  assert.equal(profiles.get("final")?.mode, "synthesis");
  assert.deepEqual(profiles.get("final")?.source, taskProfile.source);
});

test("an explicit terminal research mode is not overwritten by inference", () => {
  const environment = fixtures.environments.expanded!;
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Investigate gaps in {{market_research}}.";
  workflow.steps[1]!.llm = {
    params: { think_tank: { mode: "standard" } },
  };

  const profiles = resolveWorkflowResearchProfiles(
    workflow,
    taskProfile,
    environment.capabilities,
  );

  assert.equal(profiles.get("final")?.mode, "standard");
});

test("workflow research profiles cannot broaden the task source grant", () => {
  const environment = fixtures.environments.expanded!;
  const taskProfile = resolveResearchProfile(
    {
      source: {
        mode: "urls",
        urls: ["https://example.com/report"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(true, {
    source: {
      mode: "urls",
      urls: ["https://example.com/report"],
      web: {
        retrievers: ["duckduckgo"],
      },
    },
  });

  assert.throws(
    () =>
      resolveWorkflowResearchProfiles(
        workflow,
        taskProfile,
        environment.capabilities,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(
        error.path,
        '$.steps["research_market"].llm.params.think_tank.source.web',
      );
      return true;
    },
  );
});

function withForceDeep<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.GPTR_RESEARCH_FORCE_DEEP;
  if (value === undefined) delete process.env.GPTR_RESEARCH_FORCE_DEEP;
  else process.env.GPTR_RESEARCH_FORCE_DEEP = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.GPTR_RESEARCH_FORCE_DEEP;
    else process.env.GPTR_RESEARCH_FORCE_DEEP = previous;
  }
}

test("GPTR_RESEARCH_FORCE_DEEP promotes a web research step to deep, leaving synthesis alone", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";

  const profiles = withForceDeep("1", () =>
    resolveWorkflowResearchProfiles(
      workflow,
      taskProfile,
      environment.capabilities,
    ),
  );

  assert.equal(profiles.get("research_market")?.mode, "deep");
  assert.deepEqual(profiles.get("research_market")?.deep, {
    breadth: 2,
    depth: 1,
    concurrency: 1,
  });
  assert.equal(profiles.get("final")?.mode, "synthesis");
});

test("GPTR_RESEARCH_FORCE_DEEP parses an explicit shape and clamps to deployment limits", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";

  const profiles = withForceDeep("9x9x9", () =>
    resolveWorkflowResearchProfiles(
      workflow,
      taskProfile,
      environment.capabilities,
    ),
  );

  assert.deepEqual(profiles.get("research_market")?.deep, {
    breadth: environment.capabilities.deepResearch!.maxBreadth,
    depth: environment.capabilities.deepResearch!.maxDepth,
    concurrency: 4,
  });
});

test("GPTR_RESEARCH_FORCE_DEEP is ignored for a non-web task source", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    { source: { mode: "urls", urls: ["https://example.com/report"] } },
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(false);
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";

  const profiles = withForceDeep("1", () =>
    resolveWorkflowResearchProfiles(
      workflow,
      taskProfile,
      environment.capabilities,
    ),
  );

  assert.equal(profiles.get("research_market")?.mode, "standard");
});

test("GPTR_RESEARCH_FORCE_DEEP does not override a step's explicit mode", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const taskProfile = resolveResearchProfile(
    null,
    environment.defaults,
    environment.capabilities,
  );
  const workflow = workflowWithStepOverride(true, { mode: "standard" });
  workflow.steps[0]!.output = "market_research";
  workflow.steps[1]!.task = "Synthesize {{market_research}}.";

  const profiles = withForceDeep("1", () =>
    resolveWorkflowResearchProfiles(
      workflow,
      taskProfile,
      environment.capabilities,
    ),
  );

  assert.equal(profiles.get("research_market")?.mode, "standard");
});

function workflowWithStepOverride(
  hasOverride: boolean,
  override?: unknown,
): WorkflowDefinition {
  return {
    name: "profile mapping",
    agents_dir: "./agents",
    llm: { provider: "openai" },
    steps: [
      {
        id: "research_market",
        role: "research/analyst",
        task: "Research the market.",
        ...(hasOverride
          ? { llm: { params: { think_tank: override } } }
          : {}),
      },
      {
        id: "final",
        role: "research/writer",
        task: "Write the final report.",
        depends_on: ["research_market"],
        acceptance: "The output contains a final report.",
      },
    ],
  };
}

function isDeeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}
