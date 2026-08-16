import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildResearchComposeSystemPrompt,
  composeValidatedWorkflow,
  workflowFileName,
  type ResearchWorkflowComposer,
} from "../src/workflow-composer.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
} from "../src/research-profile.js";

const agentsDir = join(import.meta.dirname, "fixtures", "agents");

test("uses the task-owned filename instead of a long research topic", () => {
  assert.equal(workflowFileName({
    description: "全国两会政策部署与中长期增长动能的传导机制研究 - 关注财政、产业、就业与消费政策之间的协同性",
    agentsDir,
    llmConfig: { provider: "openai" },
    workflowFileName: "a7aa1b59-e7a8-4382-af68-1357a8b19107.yaml",
  }), "a7aa1b59-e7a8-4382-af68-1357a8b19107.yaml");
});

test("recomposes when AO returns a dangling step dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid.yaml");
  const validPath = join(directory, "valid.yaml");
  await writeFile(invalidPath, workflowYaml("research_competitive_analysis"));
  await writeFile(validPath, workflowYaml("research_competitive_landscape"));

  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return { yaml: "", savedPath, relativePath: savedPath, warnings: [] };
  };

  const result = await composeValidatedWorkflow({
    description: "Research Dify business logic",
    agentsDir,
    agentsDirName: "agency-agents-zh",
    llmConfig: { provider: "openai" },
    autoRun: true,
    lang: "zh",
    saveDir: directory,
  }, compose);

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[1]!, /depends_on/u);
  assert.match(descriptions[1]!, /steps\[\]\.id/u);
  assert.match(descriptions[1]!, /完整工作流 YAML/u);
});

test("recomposes when AO adds a research content length limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "length-limit.yaml");
  const validPath = join(directory, "valid.yaml");
  await writeFile(invalidPath, workflowYaml("research_competitive_landscape").replace(
    "    task: Write the final report.\n",
    "    task: Write the final report in no more than 800 words.\n",
  ));
  await writeFile(validPath, workflowYaml("research_competitive_landscape"));

  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return { yaml: "", savedPath, relativePath: savedPath, warnings: [] };
  };

  const result = await composeValidatedWorkflow({
    description: "Research topic",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose);

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[1]!, /character, word, or token limit/u);
});

test("retains the invalid initial YAML in a private composition diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "length-limit.yaml");
  const validPath = join(directory, "valid.yaml");
  const invalidYaml = workflowYaml("research_competitive_landscape").replace(
    "    task: Write the final report.\n",
    "    task: Write the final report in no more than 800 words.\n",
  );
  await writeFile(invalidPath, invalidYaml);
  await writeFile(validPath, workflowYaml("research_competitive_landscape"));

  let calls = 0;
  const compose: ResearchWorkflowComposer = async () => {
    calls += 1;
    return {
      yaml: calls === 1 ? invalidYaml : "valid yaml",
      savedPath: calls === 1 ? invalidPath : validPath,
      relativePath: "workflow.yaml",
      warnings: [],
    };
  };
  const diagnostics: Array<Record<string, unknown>> = [];

  await composeValidatedWorkflow({
    description: "Research topic",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, undefined, undefined, undefined, (diagnostic) => {
    diagnostics.push(diagnostic as unknown as Record<string, unknown>);
  });

  assert.deepEqual(diagnostics, [{
    stage: "workflow_validation",
    message: "Generated workflow did not pass preflight validation.",
    workflowPath: invalidPath,
    validationErrors: [
      'Step "synthesize_final_report" must not impose a character, word, or token limit on research content. Require coverage and evidence instead.',
    ],
    rawOutput: invalidYaml,
  }]);
});

test("research composition prompt never asks for a report length limit", () => {
  const prompt = buildResearchComposeSystemPrompt([
    { path: "research/analyst", name: "Analyst", description: "Research" },
  ], {
    agentsDirName: "agency-agents-zh",
    llmConfig: { provider: "openai", model: "test-model" },
    timeoutMs: 300_000,
  });

  assert.doesNotMatch(prompt, /800\s*words|500\s*words|under\s+\d+\s+words/iu);
  assert.match(prompt, /Never impose a character, word, or token limit/iu);
});

test("turns a missing task error into a field-level repair instruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "missing-task.yaml");
  const validPath = join(directory, "valid.yaml");
  await writeFile(invalidPath, workflowYaml("research_competitive_landscape").replace(
    "    task: Research the competitive landscape.\n",
    "",
  ));
  await writeFile(validPath, workflowYaml("research_competitive_landscape"));

  const descriptions: string[] = [];
  const repairs: Array<{ attempt: number; errorCount: number }> = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return { yaml: "", savedPath, relativePath: savedPath, warnings: [] };
  };

  const result = await composeValidatedWorkflow({
    description: "Compare China and US economies",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, undefined, undefined, (repair) => repairs.push(repair));

  assert.equal(result.savedPath, validPath);
  assert.deepEqual(repairs, [{ attempt: 1, errorCount: 1, maxAttempts: 2 }]);
  assert.match(descriptions[1]!, /research_competitive_landscape/u);
  assert.match(descriptions[1]!, /task:\s*\|/u);
  assert.match(descriptions[1]!, /id、role、task 和 output/u);
});

test("fails after two bounded repair attempts when AO remains invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid.yaml");
  await writeFile(invalidPath, workflowYaml("missing_step"));
  let calls = 0;
  const compose: ResearchWorkflowComposer = async () => {
    calls += 1;
    return { yaml: "", savedPath: invalidPath, relativePath: invalidPath, warnings: [] };
  };

  await assert.rejects(
    composeValidatedWorkflow({
      description: "Research topic",
      agentsDir,
      llmConfig: { provider: "openai" },
    }, compose),
    /2[\s\S]*missing_step/u,
  );
  assert.equal(calls, 3);
});

test("recomposes when AO returns an invalid step research profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid-profile.yaml");
  const validPath = join(directory, "valid-profile.yaml");
  await writeFile(invalidPath, workflowYamlWithProfile([
    "mode: deep",
    "deep:",
    "  breadth: 2",
    "  depth: 2",
    "  concurrency: 2",
  ]));
  await writeFile(validPath, workflowYamlWithProfile([]));

  const capabilities: ResearchCapabilities = {
    modes: ["standard"], sourceModes: ["web"], retrievers: ["duckduckgo"],
    maxRetrievers: 1, sourceCuration: false, domainFilters: false,
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
    return { yaml: "", savedPath, relativePath: savedPath, warnings: [] };
  };

  const result = await composeValidatedWorkflow({
    description: "Research topic",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, { taskProfile, capabilities });

  assert.equal(result.savedPath, validPath);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[1]!, /\$\.steps\["research_competitive_landscape"\][\s\S]*not enabled/u);
});

test("recomposes when AO contradicts the resolved relative-year scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-compose-"));
  const invalidPath = join(directory, "invalid-years.yaml");
  const validPath = join(directory, "valid-years.yaml");
  await writeFile(invalidPath, temporalWorkflowYaml(2023, 2025));
  await writeFile(validPath, temporalWorkflowYaml(2024, 2026));

  const descriptions: string[] = [];
  const compose: ResearchWorkflowComposer = async (options) => {
    descriptions.push(options.description);
    const savedPath = descriptions.length === 1 ? invalidPath : validPath;
    return { yaml: "", savedPath, relativePath: savedPath, warnings: [] };
  };

  const result = await composeValidatedWorkflow({
    description: "Analyze recent US economic conditions",
    agentsDir,
    llmConfig: { provider: "openai" },
  }, compose, undefined, {
    count: 3, startYear: 2024, endYear: 2026, includesCurrentYearToDate: true,
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
    ...(profileLines.length > 0 ? [
      "    llm:", "      params:", "        think_tank:",
      ...profileLines.map((line) => `          ${line}`),
    ] : []),
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
    `name: US economy ${startYear}-${endYear}`,
    `description: Analyze the US economy from ${startYear} to ${endYear}.`,
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
