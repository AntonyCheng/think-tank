import {
  OpenAICompatibleConnector,
  type LLMConfig,
  type LLMConnector,
  type LLMResult,
} from "agency-orchestrator";

export interface ProviderRoute {
  connector: LLMConnector;
  config?: Partial<LLMConfig>;
}

export interface FailoverConnectorOptions {
  primary: ProviderRoute;
  fallback?: ProviderRoute;
  onFallback?: (error: Error) => void;
}

/** Routes one model call to the backup provider only for transient failures. */
export class FailoverConnector implements LLMConnector {
  readonly #primary: ProviderRoute;
  readonly #fallback?: ProviderRoute;
  readonly #onFallback?: (error: Error) => void;

  constructor(options: FailoverConnectorOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#onFallback = options.onFallback;
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    try {
      return await this.#primary.connector.chat(
        systemPrompt,
        userMessage,
        { ...config, ...this.#primary.config },
      );
    } catch (error) {
      const normalized = normalizeError(error);
      if (!this.#fallback || !isRetryableProviderError(normalized)) {
        throw normalized;
      }
      this.#onFallback?.(normalized);
      try {
        return await this.#fallback.connector.chat(
          systemPrompt,
          userMessage,
          { ...config, ...this.#fallback.config },
        );
      } catch (fallbackError) {
        throw new Error(
          `主模型服务暂时不可用，备用模型服务也调用失败：${normalizeError(fallbackError).message}`,
        );
      }
    }
  }
}

export function providerRoute(
  connector: LLMConnector,
  provider: { baseUrl: string; apiKey: string; model?: string },
): ProviderRoute {
  return {
    connector,
    config: {
      base_url: provider.baseUrl,
      api_key: provider.apiKey,
      ...(provider.model ? { model: provider.model } : {}),
    },
  };
}

export function openAiProviderConnector(
  provider: { baseUrl: string; apiKey: string; model: string },
): ProviderRoute {
  return providerRoute(
    new OpenAICompatibleConnector({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    }),
    provider,
  );
}

export function isRetryableProviderError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const status = message.match(/\b(?:http|status|code|error)\D{0,8}(4\d{2}|5\d{2})\b/u)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
  }
  return /(?:fetch|network|timeout|timed out|abort|econnreset|econnrefused|socket|connection|temporarily unavailable)/u.test(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
