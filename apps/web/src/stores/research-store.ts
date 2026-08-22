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
  reconnect: () => void;
}

export function useResearchStore(taskId: string, initialData?: { snapshot: ResearchTaskSnapshot; events: TaskEvent[] }): ResearchStoreState {
  const [state, setState] = useState<Omit<ResearchStoreState, "updateSnapshot" | "reconnect">>({ events: [], connection: "loading" });
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const updateSnapshot = useCallback((snapshot: ResearchTaskSnapshot) => {
    setState((current) => ({ ...current, snapshot }));
  }, []);
  const reconnect = useCallback(() => {
    setConnectionGeneration((current) => current + 1);
  }, []);
  useEffect(() => {
    let active = true;
    let hasLoadedSnapshot = Boolean(initialData);
    setState({
      events: initialData?.events ?? [],
      connection: "loading",
      ...(initialData ? { snapshot: initialData.snapshot } : {}),
    });
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
    if (!initialData) void snapshotRefresh.flush();
    const initialTaskIsTerminal = initialData
      && ["canceled", "completed", "completed_with_warnings", "failed"].includes(initialData.snapshot.status);
    if (initialTaskIsTerminal) {
      return () => {
        active = false;
        snapshotRefresh.dispose();
      };
    }
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
  }, [initialData, taskId, connectionGeneration]);
  return { ...state, updateSnapshot, reconnect };
}

export function useOrderedEvents(events: TaskEvent[]): TaskEvent[] {
  return useMemo(() => [...events].sort((left, right) => left.id - right.id), [events]);
}
