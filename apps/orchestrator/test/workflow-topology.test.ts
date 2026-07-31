import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeWorkflowTopology } from "../src/workflow-topology.js";

test("reports fan-out/fan-in topology without warnings", () => {
  const topology = analyzeWorkflowTopology({
    name: "parallel research",
    agents_dir: "agency-agents",
    llm: { provider: "openai", model: "test" },
    steps: [
      { id: "facts", name: "Facts", role: "researcher", task: "collect", output: "facts" },
      { id: "market", name: "Market", role: "researcher", task: "collect", output: "market" },
      {
        id: "final",
        name: "Final",
        role: "editor",
        task: "use {{facts}} and {{market}}",
        output: "report",
        depends_on: ["facts", "market"],
      },
    ],
  });

  assert.equal(topology.criticalPathLength, 2);
  assert.equal(topology.maximumWidth, 2);
  assert.equal(topology.researchBranchCount, 2);
  assert.deepEqual(topology.warnings, []);
});

test("warns for a likely ordering-only research dependency", () => {
  const topology = analyzeWorkflowTopology({
    name: "serial research",
    agents_dir: "agency-agents",
    llm: { provider: "openai", model: "test" },
    steps: [
      { id: "facts", name: "Facts", role: "researcher", task: "collect", output: "facts" },
      {
        id: "market",
        name: "Market",
        role: "researcher",
        task: "independently collect market evidence",
        output: "market",
        depends_on: ["facts"],
      },
    ],
  });

  assert.equal(topology.maximumWidth, 1);
  assert.match(topology.warnings[0] ?? "", /仅用于排序/u);
});
