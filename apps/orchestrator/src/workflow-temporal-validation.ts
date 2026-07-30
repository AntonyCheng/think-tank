import type { WorkflowDefinition } from "agency-orchestrator";

import type { RelativeYearScope } from "./task-temporal-context.js";

const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/gu;
const YEAR_RANGE_PATTERN =
  /\b((?:19|20)\d{2})\s*(?:-|–|—|至|到)\s*((?:19|20)\d{2})\b/gu;

export function validateWorkflowRelativeYearScope(
  workflow: WorkflowDefinition,
  scope: RelativeYearScope | undefined,
): string[] {
  if (!scope) return [];

  const declaredRanges = [
    workflow.name,
    workflow.description,
  ].flatMap((value) => extractRanges(value ?? ""));
  const conflictingRange = declaredRanges.find(
    ([startYear, endYear]) =>
      startYear !== scope.startYear || endYear !== scope.endYear,
  );
  if (conflictingRange) {
    return [scopeConflictMessage(scope, conflictingRange)];
  }

  const rootYears = new Set(
    workflow.steps
      .filter((step) => (step.depends_on?.length ?? 0) === 0)
      .flatMap((step) =>
        extractYears([
          step.id,
          step.name,
          step.output,
        ].filter((value): value is string => Boolean(value)).join(" "))
      ),
  );
  if (
    rootYears.size === scope.count &&
    !expectedYears(scope).every((year) => rootYears.has(year))
  ) {
    return [
      scopeConflictMessage(
        scope,
        [Math.min(...rootYears), Math.max(...rootYears)],
      ),
    ];
  }

  const dependedOn = new Set(
    workflow.steps.flatMap((step) => step.depends_on ?? []),
  );
  const terminalYears = new Set(
    workflow.steps
      .filter((step) => !dependedOn.has(step.id))
      .flatMap((step) =>
        extractYears(`${step.task}\n${step.acceptance ?? ""}`)
      ),
  );
  if (
    terminalYears.size === scope.count &&
    !expectedYears(scope).every((year) => terminalYears.has(year))
  ) {
    return [
      scopeConflictMessage(
        scope,
        [Math.min(...terminalYears), Math.max(...terminalYears)],
      ),
    ];
  }

  return [];
}

function extractRanges(value: string): Array<[number, number]> {
  return [...value.matchAll(YEAR_RANGE_PATTERN)].flatMap((match) => {
    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    return Number.isInteger(startYear) && Number.isInteger(endYear)
      ? [[startYear, endYear]]
      : [];
  });
}

function extractYears(value: string): number[] {
  return [...value.matchAll(YEAR_PATTERN)].map((match) => Number(match[0]));
}

function expectedYears(scope: RelativeYearScope): number[] {
  return Array.from(
    { length: scope.count },
    (_, index) => scope.startYear + index,
  );
}

function scopeConflictMessage(
  scope: RelativeYearScope,
  actual: readonly [number, number],
): string {
  const partial = scope.includesCurrentYearToDate
    ? `，其中 ${scope.endYear} 年仅统计到任务启动日期`
    : "";
  return [
    `工作流明确使用 ${actual[0]}-${actual[1]}，`,
    `但用户相对年份口径要求 ${scope.startYear}-${scope.endYear}${partial}。`,
  ].join("");
}
