import { useCallback, useEffect, useMemo, useState } from "react";
import { applyEvent, type TaskEvent } from "../domain/research-events";
import type { ResearchTaskSnapshot } from "../domain/task";
import { getResearchTask, subscribeToTaskEvents } from "../services/api-client";

export type ConnectionState = "loading" | "open" | "closed" | "error";

export interface ResearchStoreState {
  snapshot?: ResearchTaskSnapshot;
  events: TaskEvent[];
  connection: ConnectionState;
  error?: string;
  updateSnapshot: (snapshot: ResearchTaskSnapshot) => void;
}

export function useResearchStore(taskId: string): ResearchStoreState {
  const [state, setState] = useState<Omit<ResearchStoreState, "updateSnapshot">>({ events: [], connection: "loading" });
  const updateSnapshot = useCallback((snapshot: ResearchTaskSnapshot) => {
    setState((current) => ({ ...current, snapshot }));
  }, []);
  useEffect(() => {
    let active = true;
    setState({ events: [], connection: "loading" });
    getResearchTask(taskId).then((snapshot) => {
      if (active) setState((current) => ({
        ...current,
        snapshot,
        connection: current.connection,
        error: undefined,
      }));
    }).catch((reason) => {
      if (active) setState((current) => ({ ...current, connection: "error", error: reason instanceof Error ? reason.message : String(reason) }));
    });
    const unsubscribe = subscribeToTaskEvents(taskId, (event) => {
      if (!active) return;
      setState((current) => ({
        ...current,
        events: current.events.some((item) => item.id === event.id) ? current.events : [...current.events, event],
        snapshot: current.snapshot ? applyEvent(current.snapshot, event) : current.snapshot,
      }));
      if (
        event.type.startsWith("research.") ||
        event.type === "task.completed" ||
        event.type === "task.completed_with_warnings"
      ) {
        void getResearchTask(taskId).then((snapshot) => {
          if (!active) return;
          setState((current) => ({
            ...current,
            snapshot: !current.snapshot || snapshot.updatedAt >= current.snapshot.updatedAt
              ? snapshot
              : current.snapshot,
          }));
        }).catch(() => undefined);
      }
    }, (connection) => {
      if (active) setState((current) => ({ ...current, connection: connection === "open" ? "open" : "closed" }));
    });
    return () => { active = false; unsubscribe(); };
  }, [taskId]);
  return { ...state, updateSnapshot };
}

export function useOrderedEvents(events: TaskEvent[]): TaskEvent[] {
  return useMemo(() => [...events].sort((left, right) => left.id - right.id), [events]);
}
