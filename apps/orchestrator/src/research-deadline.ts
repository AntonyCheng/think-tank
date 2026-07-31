export interface ResearchDeadline {
  executionTimeoutMs: number;
  connectorTimeoutMs: number;
  outerTimeoutMs?: number;
}

/**
 * Keeps the owned GPTR process deadline inside AO's retry deadline. AO's
 * timeout wrapper cannot cancel an in-flight connector promise, so the
 * researcher must have enough time to stop its worker and report a terminal
 * error before AO considers retrying the step.
 */
export function resolveResearchDeadline(options: {
  configuredResearchTimeoutMs: number;
  aoAttemptTimeoutMs?: number;
  cleanupGraceMs: number;
}): ResearchDeadline {
  const { configuredResearchTimeoutMs, aoAttemptTimeoutMs, cleanupGraceMs } =
    options;
  assertPositive(configuredResearchTimeoutMs, "configuredResearchTimeoutMs");
  assertPositive(cleanupGraceMs, "cleanupGraceMs");

  const outerTimeoutMs = aoAttemptTimeoutMs && aoAttemptTimeoutMs > 0
    ? aoAttemptTimeoutMs
    : undefined;
  if (!outerTimeoutMs) {
    return {
      executionTimeoutMs: configuredResearchTimeoutMs,
      connectorTimeoutMs: configuredResearchTimeoutMs + cleanupGraceMs,
    };
  }
  if (outerTimeoutMs <= cleanupGraceMs) {
    throw new Error(
      "AO step timeout must exceed GPTR cleanup grace time.",
    );
  }

  const executionTimeoutMs = Math.min(
    configuredResearchTimeoutMs,
    outerTimeoutMs - cleanupGraceMs,
  );
  if (executionTimeoutMs < 1) {
    throw new Error("Resolved GPTR execution timeout must be positive.");
  }
  return {
    executionTimeoutMs,
    // Reserve a small transport window after the Researcher deadline and
    // before AO's non-canceling outer timeout.
    connectorTimeoutMs: Math.max(
      executionTimeoutMs + 1,
      outerTimeoutMs - Math.min(5_000, cleanupGraceMs),
    ),
    outerTimeoutMs,
  };
}

function assertPositive(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
