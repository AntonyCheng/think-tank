import {
  OpenAICompatibleConnector,
  type LLMConfig,
  type LLMConnector,
  type LLMResult,
} from "agency-orchestrator";

export interface RoutingConnectorOptions {
  research: LLMConnector;
  onReworkRejected?: (reason: string) => void;
  verifier?: {
    apiKey: string;
    baseUrl?: string;
    model: string;
    connector?: LLMConnector;
  };
}

export class RoutingConnector implements LLMConnector {
  readonly #research: LLMConnector;
  readonly #onReworkRejected?: RoutingConnectorOptions["onReworkRejected"];
  readonly #verifier?: RoutingConnectorOptions["verifier"];
  readonly #verifierConnector?: LLMConnector;

  constructor(options: RoutingConnectorOptions) {
    this.#research = options.research;
    this.#onReworkRejected = options.onReworkRejected;
    this.#verifier = options.verifier;
    this.#verifierConnector = options.verifier
      ? options.verifier.connector ?? new OpenAICompatibleConnector({
          apiKey: options.verifier.apiKey,
          baseUrl: options.verifier.baseUrl,
        })
      : undefined;
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    if (isAcceptanceReview(userMessage) && this.#verifierConnector && this.#verifier) {
      return this.#verifierConnector.chat(systemPrompt, userMessage, {
        ...config,
        provider: "openai",
        model: this.#verifier.model,
        base_url: this.#verifier.baseUrl,
        api_key: this.#verifier.apiKey,
        temperature: 0,
      });
    }

    const previousDeliverable = extractAcceptanceReworkSource(userMessage);
    const researchConfig = previousDeliverable
      ? withSynthesisReworkProfile(config)
      : config;
    const result = await this.#research.chat(
      systemPrompt,
      userMessage,
      researchConfig,
    );
    if (previousDeliverable) {
      const regression = describeReworkRegression(
        previousDeliverable,
        result.content,
      );
      if (regression) {
        this.#onReworkRejected?.(regression);
        throw new Error(`GPTR 自动返工产出退化：${regression}`);
      }
    }
    return result;
  }
}

function withSynthesisReworkProfile(config: LLMConfig): LLMConfig {
  const params = {
    ...(config.params ?? {}),
  } as Record<string, unknown>;
  const current = params.think_tank;
  const common = current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  delete common.deep;
  return {
    ...config,
    params: {
      ...params,
      think_tank: {
        ...common,
        mode: "synthesis",
      },
    },
  };
}

function isAcceptanceReview(userMessage: string): boolean {
  return (
    userMessage.includes('{"pass": true/false, "failed"') ||
    (
      userMessage.includes('"criterion"') &&
      userMessage.includes('"why"') &&
      userMessage.includes('"failed"')
    )
  );
}

function extractAcceptanceReworkSource(
  userMessage: string,
): string | undefined {
  const markerPairs = [
    {
      start: "以下是你上一版的产出，请在此基础上修改，不要从零重写：",
      end: "\n\n---\n验收核对发现以下条目未满足：",
    },
    {
      start: "Below is your previous deliverable. Revise it in place — do NOT rewrite from scratch:",
      end: "\n\n---\nAcceptance review found the following criteria NOT met:",
    },
  ];
  for (const markers of markerPairs) {
    const start = userMessage.lastIndexOf(markers.start);
    if (start < 0) continue;
    const contentStart = start + markers.start.length;
    const end = userMessage.indexOf(markers.end, contentStart);
    if (end > contentStart) {
      return userMessage.slice(contentStart, end).trim();
    }
  }
  return undefined;
}

function describeReworkRegression(
  previous: string,
  candidate: string,
): string | undefined {
  const normalized = candidate.trim();
  if (!normalized) {
    return "返回内容为空，已保留第一版报告。";
  }

  const previousHeadings = countMatches(previous, /^#{1,6}\s+\S/gmu);
  const candidateHeadings = countMatches(normalized, /^#{1,6}\s+\S/gmu);
  const opening = normalized.slice(0, 1_000);
  const processMarkers = [
    /用户(?:要求|希望)我(?:修改|修订|检查|核查|重新)/u,
    /主要问题(?:是|如下)/u,
    /(?:让我|我需要|我将|接下来)(?:先|重新|检查|核查|查找|确认|修改|分析)/u,
    /(?:检查|核查)(?:原始|现有|提供的)(?:数据|材料|来源)/u,
    /\bthe user (?:asks|wants) me to (?:revise|modify|check|verify)\b/iu,
    /\b(?:let me|i need to|i will now) (?:check|verify|revise|inspect)\b/iu,
    /\b(?:main|primary) (?:issues|problems) (?:are|include)\b/iu,
  ];
  const processMarkerCount = processMarkers.filter((pattern) =>
    pattern.test(opening)
  ).length;
  const retainsReportShape = normalized.length >= previous.length * 0.6 &&
    (
      previousHeadings < 3 ||
      candidateHeadings >= Math.ceil(previousHeadings / 2)
    );
  if (processMarkerCount >= 2 && !retainsReportShape) {
    return "返回的是修改过程说明，而不是修改后的完整报告，已保留第一版报告。";
  }

  const substantiallyShorter = previous.length >= 1_500 &&
    normalized.length < previous.length * 0.45;
  const lostStructure = previousHeadings >= 3 &&
    candidateHeadings < Math.ceil(previousHeadings / 2);
  if (substantiallyShorter && lostStructure) {
    return "返回内容相较第一版大幅缩短且丢失主要章节，已保留第一版报告。";
  }
  return undefined;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}
