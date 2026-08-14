import { useCallback, useEffect, useMemo, useState } from "react";
import { applyEvent, isTerminalTaskEvent, type TaskEvent } from "../domain/research-events";
import type { ResearchTaskSnapshot } from "../domain/task";
import { getResearchTask, subscribeToTaskEvents } from "../services/api-client";
import { createSnapshotRefreshScheduler } from "./snapshot-refresh";

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
    let hasLoadedSnapshot = false;
    setState({ events: [], connection: "loading" });
    const snapshotRefresh = createSnapshotRefreshScheduler(async () => {
      try {
        const snapshot = await getResearchTask(taskId);
        if (!active) return;
        hasLoadedSnapshot = true;
        setState((current) => ({
          ...current,
          snapshot: !current.snapshot || snapshot.updatedAt >= current.snapshot.updatedAt
            ? snapshot
            : current.snapshot,
          error: undefined,
        }));
      } catch (reason) {
        if (active && !hasLoadedSnapshot) {
          setState((current) => ({
            ...current,
            connection: "error",
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
      }
    });
    void snapshotRefresh.flush();
    const unsubscribe = subscribeToTaskEvents(taskId, (event) => {
      if (!active) return;
      setState((current) => ({
        ...current,
        events: current.events.some((item) => item.id === event.id) ? current.events : [...current.events, event],
        snapshot: current.snapshot ? applyEvent(current.snapshot, event) : current.snapshot,
      }));
      if (event.type.startsWith("research.")) snapshotRefresh.schedule();
      if (isTerminalTaskEvent(event)) void snapshotRefresh.flush();
    }, (connection) => {
      if (active) setState((current) => ({ ...current, connection: connection === "open" ? "open" : "closed" }));
    });
    return () => {
      active = false;
      snapshotRefresh.dispose();
      unsubscribe();
    };
  }, [taskId]);
  return { ...state, updateSnapshot };
}

export function useOrderedEvents(events: TaskEvent[]): TaskEvent[] {
  return useMemo(() => [...events].sort((left, right) => left.id - right.id), [events]);
}
