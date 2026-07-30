import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  composeValidatedWorkflow,
  type ResearchWorkflowComposer,
} from "../src/workflow-composer.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
} from "../src/research-profile.js";

const agentsDir = join(
  import.meta.dirname,
  "fixtures",
  "agents",
);

test("recomposes once when AO returns a dangling step dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid.yaml");
  const validPath = join(directory, "valid.yaml");
  await writeFile(invalidPath, workflowYaml("research_competitive_analysis"));
  await writeFile(validPath, workflowYaml("research_competitive_landscape"));

  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return {
      yaml: "",
      savedPath,
      relativePath: savedPath,
      warnings: [],
    };
  };

  const result = await composeValidatedWorkflow({
    description: "研究 Dify 商业逻辑",
    agentsDir,
    agentsDirName: "agency-agents-zh",
    llmConfig: { provider: "openai" },
    autoRun: true,
    lang: "zh",
    saveDir: directory,
  }, compose);

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[1]!, /依赖不存在的 step/u);
  assert.match(descriptions[1]!, /depends_on/u);
  assert.match(descriptions[1]!, /steps\[\]\.id/u);
});

test("fails after one retry when AO still returns an invalid DAG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid.yaml");
  await writeFile(invalidPath, workflowYaml("missing_step"));
  let calls = 0;
  const compose: ResearchWorkflowComposer = async () => {
    calls += 1;
    return {
      yaml: "",
      savedPath: invalidPath,
      relativePath: invalidPath,
      warnings: [],
    };
  };

  await assert.rejects(
    composeValidatedWorkflow({
      description: "研究主题",
      agentsDir,
      llmConfig: { provider: "openai" },
    }, compose),
    /自动重新编排后仍未通过预检[\s\S]*missing_step/u,
  );
  assert.equal(calls, 2);
});

test("recomposes once when AO returns an invalid step research profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid-profile.yaml");
  const validPath = join(directory, "valid-profile.yaml");
  await writeFile(
    invalidPath,
    workflowYamlWithProfile([
      "mode: deep",
      "deep:",
      "  breadth: 2",
      "  depth: 2",
      "  concurrency: 2",
    ]),
  );
  await writeFile(validPath, workflowYamlWithProfile([]));

  const capabilities: ResearchCapabilities = {
    modes: ["standard"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
  };
  const taskProfile = resolveResearchProfile(
    null,
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return {
      yaml: "",
      savedPath,
      relativePath: savedPath,
      warnings: [],
    };
  };

  const result = await composeValidatedWorkflow({
    description: "研究主题",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, { taskProfile, capabilities });

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(
    descriptions[1]!,
    /\$\.steps\["research_competitive_landscape"\][\s\S]*not enabled/u,
  );
});

test("recomposes once when AO contradicts the resolved relative-year scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid-years.yaml");
  const validPath = join(directory, "valid-years.yaml");
  await writeFile(invalidPath, temporalWorkflowYaml(2023, 2025));
  await writeFile(validPath, temporalWorkflowYaml(2024, 2026));

  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return {
      yaml: "",
      savedPath,
      relativePath: savedPath,
      warnings: [],
    };
  };

  const result = await composeValidatedWorkflow({
    description: "帮我分析一下美国近三年经济情况",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, undefined, {
    count: 3,
    startYear: 2024,
    endYear: 2026,
    includesCurrentYearToDate: true,
  });

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[1]!, /2023.*2025.*2024.*2026/su);
});

function workflowYaml(dependency: string): string {
  return [
    "name: dangling-dependency",
    "agents_dir: ./agents",
    "llm:",
    "  provider: openai",
    "  model: test-model",
    "steps:",
    "  - id: research_competitive_landscape",
    "    role: research/analyst",
    "    task: Research the competitive landscape.",
    "    output: dify_competitive_analysis",
    "  - id: synthesize_final_report",
    "    role: research/writer",
    "    task: Write the final report.",
    "    output: final_report",
    `    depends_on: [${dependency}]`,
    "    acceptance: |",
    "      1. The output contains a final report.",
    "",
  ].join("\n");
}

function workflowYamlWithProfile(profileLines: readonly string[]): string {
  return [
    "name: research-profile",
    "agents_dir: ./agents",
    "llm:",
    "  provider: openai",
    "  model: test-model",
    "steps:",
    "  - id: research_competitive_landscape",
    "    role: research/analyst",
    "    task: Research the competitive landscape.",
    ...(profileLines.length > 0
      ? [
          "    llm:",
          "      params:",
          "        think_tank:",
          ...profileLines.map((line) => `          ${line}`),
        ]
      : []),
    "    output: dify_competitive_analysis",
    "  - id: synthesize_final_report",
    "    role: research/writer",
    "    task: Write the final report.",
    "    output: final_report",
    "    depends_on: [research_competitive_landscape]",
    "    acceptance: |",
    "      1. The output contains a final report.",
    "",
  ].join("\n");
}

function temporalWorkflowYaml(startYear: number, endYear: number): string {
  return [
    `name: 美国经济分析（${startYear}-${endYear}）`,
    `description: 分析美国 ${startYear}-${endYear} 年经济情况`,
    "agents_dir: ./agents",
    "llm:",
    "  provider: openai",
    "  model: test-model",
    "steps:",
    "  - id: research_economy",
    "    role: research/analyst",
    `    task: Research the US economy from ${startYear} to ${endYear}.`,
    "    output: economy_research",
    "  - id: synthesize_final_report",
    "    role: research/writer",
    "    task: Write the final report from {{economy_research}}.",
    "    output: final_report",
    "    depends_on: [research_economy]",
    "    acceptance: |",
    `      1. The report covers ${startYear}-${endYear}.`,
    "",
  ].join("\n");
}
