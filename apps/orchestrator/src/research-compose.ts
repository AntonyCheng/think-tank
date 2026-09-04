import type { TaskTemporalContext } from "./contracts.js";
import type {
  ResearchCapabilities,
  ResearchProfile,
} from "./research-profile.js";
import {
  renderRelativeYearScope,
  renderTaskTemporalContext,
} from "./task-temporal-context.js";
import { strategyForProfile } from "./report-evidence-policy.js";

export function researchCompositionDescription(
  topic: string,
  temporalContext: TaskTemporalContext,
  taskProfile?: ResearchProfile,
  capabilities?: ResearchCapabilities,
): string {
  return [
    topic.trim(),
    "",
    renderTaskTemporalContext(temporalContext),
    ...renderOptionalBlock(renderRelativeYearScope(topic, temporalContext)),
    ...(taskProfile && capabilities
      ? ["", renderResearchProfileContract(taskProfile, capabilities)]
      : []),
    ...(taskProfile
      ? ["", renderReportEvidenceCompositionContract(taskProfile)]
      : []),
    "",
    "编排契约（必须遵守）：",
    "- 唯一的最终交付步骤必须声明非空 acceptance: 字段。",
    "- acceptance: 必须列出 2-5 条仅凭最终输出文本即可客观核对的条件。",
    "- 用户提出的内容、结构、篇幅、证据、来源和格式限制必须进入 acceptance:，不能只写在 task: 中。",
    "- Do not introduce any character, word, or token limit in task or acceptance, even when choosing a concise structure. Report depth must be defined by coverage, evidence, comparison, and uncertainty instead.",
    "- 每个 depends_on 值必须逐字匹配同一 YAML 中已声明的 steps[].id，不能填写 output 名称或近似名称。",
    "- depends_on 只能表示必须读取上游 output 的数据依赖，不能只为安排专家先后顺序而建立链。",
    "- 可独立检索的事实、市场、技术、政策等研究应作为并列根步骤；最终 synthesis 步骤再汇总所需分支。",
    "- 所有事实、数据、日期、价格、基准和引语必须保留专家报告中的 Markdown 来源链接；最终综合不得删除或改写 URL。",
    "- 最终步骤的 acceptance: 必须检查数据结论是否带有可点击的句内来源链接。",
    "- The final acceptance must verify that every assigned expert dimension is represented in the final report, including evidence, implications, and material uncertainty where applicable.",
    "- 任何 AO 步骤都不得生成参考来源章节，也不得把该章节列为 acceptance 条件；平台会在 AO 验收后根据已验证链接统一生成。",
  ].join("\n");
}

function renderOptionalBlock(value: string): string[] {
  return value ? ["", value] : [];
}

function renderReportEvidenceCompositionContract(
  profile: ResearchProfile,
): string {
  if (strategyForProfile(profile) === "private_bounded") {
    return [
      "Report evidence contract (mandatory):",
      "- This task has restricted evidence only. The generic public-link instructions above do not apply.",
      "- The final acceptance must not require clickable URLs, public citations, policy identifiers, dates, numbers, quotations, or a references section.",
      "- Acceptance must instead verify that the deliverable either makes only bounded, restricted-material conclusions or explicitly states that the evidence is insufficient.",
      "- Never expose a source locator, profile name, tool name, command, path, endpoint, or credential.",
    ].join("\n");
  }
  if (strategyForProfile(profile) === "mixed_evidence") {
    return [
      "Report evidence contract (mandatory):",
      "- Public factual claims require an observed public URL; restricted-material claims must be labeled and must not contain a URL or source identifier.",
      "- Final acceptance must distinguish these two evidence classes and must not require a public citation for a restricted-only conclusion.",
    ].join("\n");
  }
  return [
    "Report evidence contract (mandatory):",
    "- Final acceptance must require public factual claims to retain only observed, clickable source URLs.",
  ].join("\n");
}

function renderResearchProfileContract(
  profile: ResearchProfile,
  capabilities: ResearchCapabilities,
): string {
  return [
    "研究配置契约（必须遵守）：",
    "- 当前任务 Research Profile 已在提交时冻结；步骤未声明覆盖时完整继承。",
    `- mode: ${profile.mode}`,
    `- source: ${JSON.stringify(profile.source)}`,
    `- quality.curateSources: ${profile.quality.curateSources}`,
    "- limits:",
    `  maxSearchResultsPerQuery: ${profile.limits.maxSearchResultsPerQuery}`,
    `  maxIterations: ${profile.limits.maxIterations}`,
    `  maxSubtopics: ${profile.limits.maxSubtopics}`,
    `- 已启用 modes: ${capabilities.modes.join(", ")}`,
    `- 已启用 sourceModes: ${capabilities.sourceModes.join(", ")}`,
    `- 已启用 retrievers: ${capabilities.retrievers.join(", ")}`,
    `- URL 来源可用模式: ${
      capabilities.urlSourceModes?.join(", ") || "未启用"
    }`,
    `- 严格域名过滤可用模式: ${
      capabilities.domainFilterModes?.join(", ") || "未启用"
    }`,
    "- 专家步骤只能使用已启用能力；不得假设未列出的能力会自动降级。",
    "- 任务 source 是来源授权边界，不是提示词建议；步骤可以收窄但绝不能扩大。",
    "- URL 任务的步骤不得添加任务外 URL、切换成纯 Web，或为 URL-only 任务启用 Web；URL + Web 步骤可以关闭 Web。",
    "- 域名规则只能收窄：不得扩大 includeDomains，也不得移除任务级 excludeDomains。",
    "- 没有必要缩小来源权限时不要在步骤中覆盖 source，直接继承任务配置。",
    "- standard 是默认模式，适合边界明确、一次检索与分析即可完成的专家任务。",
    "- deep 适合开放式、需要顺着证据逐层追问的专家任务（例如“梳理某领域的全部主要玩家及其差异”“系统评估某方案的可行性与风险”）；它会自主拆解子问题并递归检索。边界清晰的事实核查仍用 standard。",
    "- deep 步骤必须通过 step.llm.params.think_tank 同时声明 mode 和完整的 deep 三参数：",
    "  llm:",
    "    params:",
    "      think_tank:",
    "        mode: deep",
    "        deep:",
    "          breadth: 3",
    "          depth: 2",
    "          concurrency: 2",
    ...(capabilities.deepResearch
      ? [
          `- deep 部署上限：breadth ${capabilities.deepResearch.maxBreadth}，depth ${capabilities.deepResearch.maxDepth}，预计研究调用数 ${capabilities.deepResearch.maxResearchCalls}；超限的步骤会被拒绝。`,
        ]
      : []),
    "- deep 只对纯 Web 来源可用；URL-only、本地文档、混合来源的步骤必须用 standard。",
    "- synthesis 只用于汇总、对比、审查或最终报告步骤；该步骤必须声明 depends_on。",
    "- synthesis 步骤的 task 必须用 {{变量名}} 引用至少一个上游 output 变量；它只复用这些材料，不重新联网检索。",
    "- 如需为普通专家步骤覆盖研究限额，同样用 step.llm.params.think_tank，只是把 mode/deep 换成 limits：",
    "  llm:",
    "    params:",
    "      think_tank:",
    "        limits:",
    "          maxSearchResultsPerQuery: 5",
    "          maxIterations: 4",
    "          maxSubtopics: 3",
    "- 未覆盖字段继承任务配置；数组一旦声明即整体替换。",
    "- 禁止声明顶层 llm.params.think_tank；human_input 和 approval 步骤也不得声明。",
  ].join("\n");
}
