import assert from "node:assert/strict";
import test from "node:test";
import type { TaskEvent } from "../src/domain/research-events";
import { subscribeToTaskEvents } from "../src/services/api-client";

class FakeEventSource {
  static latest: FakeEventSource | undefined;

  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string | URL) {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: TaskEvent): void {
    const message = { data: JSON.stringify(event) } as MessageEvent<string>;
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === "function") listener(message);
      else listener.handleEvent(message);
    }
  }
}

function taskEvent(id: number, type: TaskEvent["type"]): TaskEvent {
  return {
    id,
    type,
    taskId: "task-1",
    timestamp: "2026-08-14T12:00:00.000Z",
    data: {},
  };
}

test("forwards terminal events without closing the source during history replay", () => {
  const originalEventSource = globalThis.EventSource;
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: FakeEventSource,
  });

  try {
    for (const terminalType of [
      "task.canceled",
      "task.completed",
      "task.completed_with_warnings",
      "task.failed",
    ] as const) {
      const received: TaskEvent[] = [];
      const states: string[] = [];
      const unsubscribe = subscribeToTaskEvents(
        "task-1",
        (event) => received.push(event),
        (state) => states.push(state),
      );
      const source = FakeEventSource.latest;
      assert.ok(source);

      source.emit(taskEvent(1, "research.activity"));
      assert.equal(source.closed, false);
      source.emit(taskEvent(2, terminalType));

      assert.equal(source.closed, false);
      assert.deepEqual(received.map((event) => event.id), [1, 2]);
      assert.deepEqual(states, []);
      unsubscribe();
    }
  } finally {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: originalEventSource,
    });
    FakeEventSource.latest = undefined;
  }
});
