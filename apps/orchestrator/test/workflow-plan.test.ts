import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowDefinition } from "agency-orchestrator";

import { projectWorkflowPlan } from "../src/workflow-plan.js";
import type { ResearchProfile } from "../src/research-profile.js";

test("projects a workflow into a safe expert roster", () => {
  const workflow: WorkflowDefinition = {
    name: "economic-review",
    agents_dir: "./agents",
    llm: { provider: "openai", api_key: "secret", model: "planner" },
    steps: [
      {
        id: "data",
        name: "Data analyst",
        role: "research/analyst",
        task: "Internal task instruction",
      },
      {
        id: "approval",
        role: "",
        type: "approval",
        prompt: "Internal approval prompt",
        task: "",
        depends_on: ["data"],
      },
      {
        id: "report",
        role: "research/writer",
        task: "Internal report instruction",
        depends_on: ["approval"],
      },
    ],
  };
  const profile = { mode: "deep" } as ResearchProfile;

  assert.deepEqual(
    projectWorkflowPlan(workflow, new Map([["data", profile]])),
    {
      schemaVersion: 1,
      workflowName: "economic-review",
      steps: [
        {
          id: "data",
          name: "Data analyst",
          role: "research/analyst",
          task: "Internal task instruction",
          type: "expert",
          dependsOn: [],
          mode: "deep",
          terminal: false,
        },
        {
          id: "approval",
          name: "approval",
          role: "",
          task: "",
          type: "approval",
          dependsOn: ["data"],
          terminal: false,
        },
        {
          id: "report",
          name: "report",
          role: "research/writer",
          task: "Internal report instruction",
          type: "expert",
          dependsOn: ["approval"],
          terminal: true,
        },
      ],
    },
  );
});
