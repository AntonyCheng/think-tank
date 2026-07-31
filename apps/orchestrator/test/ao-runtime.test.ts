import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type {
  LLMConfig,
  LLMConnector,
  LLMResult,
  WorkflowDefinition,
} from "agency-orchestrator";

import {
  collectWorkflowInputRequests,
  preflightWorkflow,
  prepareWorkflowForExecution,
  runWorkflowFile,
} from "../src/ao-runtime.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfile,
} from "../src/research-profile.js";
import { RoutingConnector } from "../src/routing-connector.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

class RecordingConnector implements LLMConnector {
  readonly calls: Array<{ systemPrompt: string; userMessage: string }> = [];

  async chat(
    systemPrompt: string,
    userMessage: string,
    _config: LLMConfig,
  ): Promise<LLMResult> {
    this.calls.push({ systemPrompt, userMessage });
    return {
      content: this.calls.length === 1 ? "evidence result" : "# final report",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class ConfigRecordingConnector implements LLMConnector {
  readonly configs: LLMConfig[] = [];

  async chat(
    _systemPrompt: string,
    _userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    this.configs.push(structuredClone(config));
    return {
      content: "# final report",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class VerifyingConnector extends RecordingConnector {
  override async chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    if (userMessage.includes('{"pass": true/false, "failed"')) {
      this.calls.push({ systemPrompt, userMessage });
      return {
        content: '{"pass":true,"failed":[]}',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    return super.chat(systemPrompt, userMessage, config);
  }
}

test("maps AO inputs, human input, and approval into prefillable requests", () => {
  const workflow: WorkflowDefinition = {
    name: "interactive",
    agents_dir: "agents",
    llm: { provider: "openai" },
    inputs: [{
      name: "region",
      description: "研究地域",
      required: true,
    }],
    steps: [
      {
        id: "clarify",
        type: "human_input",
        prompt: "请补充偏好。",
        output: "preference",
        role: "",
        task: "",
      },
      {
        id: "approve",
        type: "approval",
        prompt: "是否继续？",
        role: "",
        task: "",
      },
    ],
  };

  assert.deepEqual(
    collectWorkflowInputRequests(workflow, {}),
    [
      {
        stepId: "input:region",
        inputName: "region",
        kind: "workflow_input",
        prompt: "研究地域",
      },
      {
        stepId: "clarify",
        inputName: "preference",
        kind: "human_input",
        prompt: "请补充偏好。",
      },
      {
        stepId: "approve",
        inputName: "__approval_approve",
        kind: "approval",
        prompt: "是否继续？",
      },
    ],
  );

  const prepared = prepareWorkflowForExecution(workflow, {
    region: "中国",
    preference: "重视隐私",
    __approval_approve: "yes",
  });
  assert.equal(prepared.workflow.steps[1]?.type, "human_input");
  assert.equal(
    prepared.workflow.steps[1]?.output,
    "__approval_approve",
  );
  assert.equal(prepared.inputs.get("region"), "中国");
});

class RejectingVerifierConnector extends RecordingConnector {
  override async chat(
    systemPrompt: string,
    userMessage: string,
    _config: LLMConfig,
  ): Promise<LLMResult> {
    this.calls.push({ systemPrompt, userMessage });
    if (userMessage.includes('{"pass": true/false, "failed"')) {
      return {
        content: JSON.stringify({
          pass: false,
          failed: [{
            criterion: "The output contains a final report.",
            why: "The report needs revision.",
          }],
        }),
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    return {
      content: systemPrompt.includes("writer")
        ? "# final report requiring revision"
        : "evidence result",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class RegressiveResearchConnector implements LLMConnector {
  writerCalls = 0;

  async chat(
    systemPrompt: string,
    _userMessage: string,
    _config: LLMConfig,
  ): Promise<LLMResult> {
    if (!systemPrompt.includes("writer")) {
      return {
        content: "evidence result",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    this.writerCalls += 1;
    return {
      content: this.writerCalls === 1
        ? [
            "# 哈尔滨商业大学办学质量分析",
            "",
            "## 摘要",
            "这是包含完整结构和来源链接的第一版报告。",
            "",
            "## 就业质量",
            "就业数据需要结合官方报告审慎解读。",
            "",
            "## 综合评价",
            "学校具有鲜明的财经与商业办学特色。",
          ].join("\n")
        : [
            "用户要求我修改报告，主要问题是：",
            "",
            "1. “研究生就业率为82.14%”的链接需要重新确认。",
            "2. “服务省内企事业单位92家”的数据来源需要核查。",
            "",
            "让我检查原始数据来源。",
          ].join("\n"),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class AlwaysRejectingVerifier implements LLMConnector {
  async chat(): Promise<LLMResult> {
    return {
      content: JSON.stringify({
        pass: false,
        failed: [{
          criterion: "The output contains a final report.",
          why: "Citation evidence needs revision.",
        }],
      }),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class ImprovingResearchConnector implements LLMConnector {
  writerCalls = 0;

  async chat(
    systemPrompt: string,
    _userMessage: string,
    _config: LLMConfig,
  ): Promise<LLMResult> {
    if (!systemPrompt.includes("writer")) {
      return {
        content: "evidence result",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    this.writerCalls += 1;
    return {
      content: [
        ...(this.writerCalls === 1
          ? []
          : [
              "The user asks me to revise the report. The main issues are citations. I will now revise it.",
              "",
            ]),
        "# Final report",
        "",
        "## Summary",
        this.writerCalls === 1
          ? "Initial evidence summary."
          : "Revised evidence summary with corrected citations.",
        "",
        "## Evidence",
        "Verified source material.",
        "",
        "## Conclusion",
        "Balanced conclusion.",
      ].join("\n"),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

class PassingAfterReworkVerifier implements LLMConnector {
  calls = 0;

  async chat(): Promise<LLMResult> {
    this.calls += 1;
    return {
      content: JSON.stringify(
        this.calls === 1
          ? {
              pass: false,
              failed: [{
                criterion: "The output contains a final report.",
                why: "Citations need revision.",
              }],
            }
          : { pass: true, failed: [] },
      ),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

test("AO loads full expert prompts and executes dependencies in order", async () => {
  const connector = new RecordingConnector();
  const events: string[] = [];

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "test topic" },
    onEvent: (event) => events.push(`${event.type}:${event.stepId}`),
  });

  assert.equal(result.success, true);
  assert.equal(connector.calls.length, 2);
  assert.match(connector.calls[0]!.systemPrompt, /evidence analyst/i);
  assert.match(connector.calls[1]!.systemPrompt, /research writer/i);
  assert.match(connector.calls[1]!.userMessage, /evidence result/);
  assert.deepEqual(events, [
    "step.started:evidence",
    "step.completed:evidence",
    "step.started:final",
    "step.completed:final",
  ]);
});

test("injects each resolved profile into the AO runtime config", async () => {
  const connector = new ConfigRecordingConnector();
  const capabilities: ResearchCapabilities = {
    modes: ["standard"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
  };
  const profile: ResearchProfile = resolveResearchProfile(
    { limits: { maxIterations: 6 } },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "test topic" },
    researchProfiles: new Map([
      ["evidence", profile],
      ["final", profile],
    ]),
  });

  assert.equal(result.success, true);
  assert.equal(connector.configs.length, 2);
  assert.deepEqual(
    connector.configs[0]?.params?.think_tank,
    profile,
  );
  assert.deepEqual(
    connector.configs[0]?.params?.think_tank_runtime,
    {
      aoStepId: "evidence",
      dependsOn: [],
      taskTemplate: "Gather evidence about {{topic}}.",
    },
  );
  assert.deepEqual(
    connector.configs[1]?.params?.think_tank_runtime,
    {
      aoStepId: "final",
      dependsOn: ["evidence"],
      taskTemplate: "Produce the final report for {{topic}}.\nEvidence:\n{{evidence}}\n",
    },
  );
});

test("preflight blocks step credentials that would replace the connector", () => {
  const workflow: WorkflowDefinition = {
    name: "unsafe",
    agents_dir: "./agents",
    llm: { provider: "openai" },
    steps: [
      {
        id: "final",
        role: "research/writer",
        task: "Write",
        llm: { base_url: "https://bypass.example/v1" },
      },
    ],
  };

  const errors = preflightWorkflow(workflow, join(fixtures, "agents"));
  assert.ok(errors.some((error) => error.includes("bypass")));
});

test("preflight rejects misplaced research configuration without context", () => {
  const workflow: WorkflowDefinition = {
    name: "misplaced profile",
    agents_dir: "./agents",
    llm: {
      provider: "openai",
      params: { think_tank: {} },
    },
    steps: [
      {
        id: "final",
        role: "research/writer",
        task: "Write",
        acceptance: "The output contains a final report.",
      },
    ],
  };

  const errors = preflightWorkflow(workflow, join(fixtures, "agents"));
  assert.ok(
    errors.some((error) => error.includes("$.llm.params.think_tank")),
  );
});

test("preflight requires acceptance on the terminal step", () => {
  const workflow: WorkflowDefinition = {
    name: "missing acceptance",
    agents_dir: "./agents",
    llm: { provider: "openai" },
    steps: [
      {
        id: "final",
        role: "research/writer",
        task: "Write the final report.",
      },
    ],
  };

  const errors = preflightWorkflow(workflow, join(fixtures, "agents"));
  assert.ok(errors.some((error) => error.includes("acceptance")));
});

test("verified execution records a passing terminal acceptance", async () => {
  const connector = new VerifyingConnector();
  const events: Array<{ stepId: string; pass?: boolean }> = [];

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "test topic" },
    verify: true,
    onEvent: (event) => events.push({
      stepId: event.stepId,
      pass: event.verification?.pass,
    }),
  });

  assert.equal(result.steps.at(-1)?.verification?.pass, true);
  assert.equal(events.at(-1)?.pass, true);
  assert.equal(connector.calls.length, 3);
});

test("verified execution preserves the deliverable when acceptance fails", async () => {
  const connector = new RejectingVerifierConnector();

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "test topic" },
    verify: true,
  });

  assert.equal(result.steps.at(-1)?.verification?.pass, false);
  assert.equal(result.steps.at(-1)?.verification?.reworked, true);
  assert.match(result.steps.at(-1)?.output ?? "", /final report/u);
});

test("keeps the first report when GPTR rework regresses into process commentary", async () => {
  const research = new RegressiveResearchConnector();
  const rejectedReworks: string[] = [];
  const connector = new RoutingConnector({
    research,
    onReworkRejected: (reason) => rejectedReworks.push(reason),
    verifier: {
      apiKey: "key",
      model: "verifier",
      connector: new AlwaysRejectingVerifier(),
    },
  });

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "哈尔滨商业大学办学质量" },
    verify: true,
  });

  const final = result.steps.at(-1);
  assert.match(final?.output ?? "", /^# 哈尔滨商业大学办学质量分析/u);
  assert.doesNotMatch(final?.output ?? "", /用户要求我修改报告/u);
  assert.equal(final?.verification?.pass, false);
  assert.equal(final?.verification?.reworked, false);
  assert.deepEqual(rejectedReworks, [
    "返回的是修改过程说明，而不是修改后的完整报告，已保留第一版报告。",
  ]);
});

test("keeps a complete GPTR rework when it improves the deliverable", async () => {
  const connector = new RoutingConnector({
    research: new ImprovingResearchConnector(),
    verifier: {
      apiKey: "key",
      model: "verifier",
      connector: new PassingAfterReworkVerifier(),
    },
  });

  const result = await runWorkflowFile(join(fixtures, "workflow.yaml"), {
    connector,
    agentsDir: join(fixtures, "agents"),
    inputs: { topic: "test topic" },
    verify: true,
  });

  const final = result.steps.at(-1);
  assert.match(final?.output ?? "", /Revised evidence summary/u);
  assert.equal(final?.verification?.pass, true);
  assert.equal(final?.verification?.reworked, true);
});
