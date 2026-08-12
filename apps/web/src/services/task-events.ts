import { activityFromEvent, type ResearchActivity, type TaskEvent } from "../domain/research-events";

export function activitiesFromEvents(events: TaskEvent[]): ResearchActivity[] {
  return events.flatMap((event) => {
    const activity = activityFromEvent(event);
    return activity ? [activity] : [];
  });
}

export function formatElapsed(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds < 1_000) return "刚刚";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

