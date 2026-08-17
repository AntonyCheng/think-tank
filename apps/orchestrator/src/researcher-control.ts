export interface ResearcherExecutionCapacity {
  concurrency: number;
  active: number;
  queued: number;
}

export type ResearcherExecutionCapacityUpdater = (
  serviceUrl: string,
  concurrency: number,
) => Promise<ResearcherExecutionCapacity>;

export const updateResearcherExecutionCapacity: ResearcherExecutionCapacityUpdater = async (
  serviceUrl,
  concurrency,
) => {
  const response = await fetch(
    new URL("/runtime/execution-capacity", serviceUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concurrency }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `研究执行服务未能应用并发设置（${response.status}）。`,
    );
  }
  const payload: unknown = await response.json();
  if (!isExecutionCapacity(payload)) {
    throw new Error("研究执行服务返回了无效的并发设置响应。");
  }
  if (payload.concurrency !== concurrency) {
    throw new Error("研究执行服务未应用请求的并发设置。");
  }
  return payload;
};

function isExecutionCapacity(
  value: unknown,
): value is ResearcherExecutionCapacity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.concurrency === "number" &&
    Number.isInteger(candidate.concurrency) &&
    candidate.concurrency >= 1 &&
    typeof candidate.active === "number" &&
    Number.isInteger(candidate.active) &&
    candidate.active >= 0 &&
    typeof candidate.queued === "number" &&
    Number.isInteger(candidate.queued) &&
    candidate.queued >= 0;
}
