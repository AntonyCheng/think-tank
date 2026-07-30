import type { TaskTemporalContext } from "./contracts.js";

export interface RelativeYearScope {
  count: number;
  startYear: number;
  endYear: number;
  includesCurrentYearToDate: boolean;
}

const RELATIVE_YEAR_PATTERN =
  /(?:最近|近|过去)\s*([0-9]{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:个)?\s*(?:完整\s*)?(?:自然\s*)?年/u;

export function createTaskTemporalContext(
  now: Date,
  timeZone: string,
): TaskTemporalContext {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Task start time must be a valid date.");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) {
      throw new Error(`Task time is missing ${type}.`);
    }
    return part;
  };

  return Object.freeze({
    startedAt: now.toISOString(),
    timeZone,
    localDate: `${value("year")}-${value("month")}-${value("day")}`,
    localTime: `${value("hour")}:${value("minute")}:${value("second")}`,
    weekday: new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      weekday: "long",
    }).format(now),
  });
}

export function resolveRelativeYearScope(
  topic: string,
  context: TaskTemporalContext,
): RelativeYearScope | undefined {
  const match = topic.match(RELATIVE_YEAR_PATTERN);
  const count = match?.[1] ? parseYearCount(match[1]) : undefined;
  if (count === undefined || count < 1 || count > 20) {
    return undefined;
  }

  const currentYear = Number(context.localDate.slice(0, 4));
  if (!Number.isInteger(currentYear)) {
    return undefined;
  }
  const completedCalendarYears =
    /完整\s*(?:自然\s*)?年|完整\s*年度/u.test(match?.[0] ?? "");
  const endYear = completedCalendarYears ? currentYear - 1 : currentYear;
  return Object.freeze({
    count,
    startYear: endYear - count + 1,
    endYear,
    includesCurrentYearToDate: !completedCalendarYears,
  });
}

export function renderRelativeYearScope(
  topic: string,
  context: TaskTemporalContext,
): string {
  const scope = resolveRelativeYearScope(topic, context);
  if (!scope) return "";

  const expression = topic.match(RELATIVE_YEAR_PATTERN)?.[0] ?? "相对年份";
  const years = Array.from(
    { length: scope.count },
    (_, index) => scope.startYear + index,
  );
  return [
    "<relative_year_scope>",
    `本任务的“${expression}”范围：${years.join("、")}。`,
    ...(scope.includesCurrentYearToDate
      ? [
          `${scope.endYear} 年仅统计到 ${context.localDate}，必须标记为年初至今，不得描述为完整年度。`,
        ]
      : []),
    `AO 的研究步骤、最终汇总任务和 acceptance 必须共同覆盖 ${years.join("、")}，不得自行改成其他年份范围。`,
    "</relative_year_scope>",
  ].join("\n");
}

export function renderTaskTemporalContext(
  context: TaskTemporalContext,
): string {
  return [
    "<runtime_context>",
    `任务启动时间（UTC）：${context.startedAt}`,
    `当前日期：${context.localDate}`,
    `当前时间：${context.localTime}`,
    `星期：${context.weekday}`,
    `时区：${context.timeZone}`,
    "",
    "时间解释规则：",
    "- 以上时间是本次任务的权威时间基准。",
    "- 遇到“当前、最近、今天、今年、最新”等表达时，检索词必须包含对应年份或日期范围，并优先使用接近当前日期的来源。",
    "- “近 N 年”“最近 N 年”“过去 N 年”默认包含当前年度截至任务启动日期，并向前覆盖 N-1 个年度；只有用户明确要求“完整自然年”时才排除当前年度。",
    "- 不得把历史事件描述为当前事件；历史资料只能作为明确标注日期的背景。",
    "- 如果没有找到足够新的可靠资料，必须明确说明最新可验证资料的截止日期。",
    "</runtime_context>",
  ].join("\n");
}

function parseYearCount(value: string): number | undefined {
  if (/^[0-9]{1,2}$/u.test(value)) {
    return Number(value);
  }
  const normalized = value.replaceAll("两", "二");
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (normalized === "十") return 10;
  if (!normalized.includes("十")) {
    return digits[normalized];
  }
  const [tens, ones] = normalized.split("十");
  const tensValue = tens ? digits[tens] : 1;
  const onesValue = ones ? digits[ones] : 0;
  if (tensValue === undefined || onesValue === undefined) {
    return undefined;
  }
  return tensValue * 10 + onesValue;
}
