import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryReportDocumentStore,
  parseReportBlocks,
  ReportDocumentConflictError,
  SqliteReportDocumentStore,
  type ReportDocumentStore,
} from "../src/report-document-store.js";

const markdown = "# Title\n\nFirst paragraph.\n\n- one\n- two\n\n> A quote\n\n```txt\ncode\n```\n";

for (const adapter of [
  {
    name: "memory",
    create: () => ({
      store: new InMemoryReportDocumentStore(),
      cleanup: () => undefined,
    }),
  },
  {
    name: "sqlite",
    create: () => {
      const directory = mkdtempSync(join(tmpdir(), "think-tank-report-"));
      const store = new SqliteReportDocumentStore(join(directory, "tasks.sqlite"));
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
  },
] as const) {
  test(`${adapter.name} creates one immutable report baseline`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const first = store.getOrCreate("task-1", markdown);
      const second = store.getOrCreate("task-1", "# replacement");

      assert.equal(first.version, 1);
      assert.equal(first.baselineMarkdown, markdown);
      assert.equal(first.currentMarkdown, markdown);
      assert.deepEqual(second, first);
      assert.deepEqual(store.get("task-1"), first);
      assert.equal(store.delete("task-1"), true);
      assert.equal(store.get("task-1"), undefined);
      assert.equal(store.delete("task-1"), false);
    } finally {
      cleanup();
    }
  });
}

test("parses stable editable markdown blocks", () => {
  const blocks = parseReportBlocks(markdown);
  assert.deepEqual(
    blocks.map((block) => [block.id, block.kind, block.text]),
    [
      ["heading-1", "heading", "Title"],
      ["paragraph-1", "paragraph", "First paragraph."],
      ["list-1", "list", "one two"],
      ["quote-1", "quote", "A quote"],
      ["code-1", "code", "txt code"],
    ],
  );
  assert.equal(blocks[1]?.markdown, "First paragraph.");
  assert.match(blocks[1]?.fingerprint ?? "", /^[a-f0-9]{64}$/u);
});

test("replaces exactly one current block after version and fingerprint checks", () => {
  const store = new InMemoryReportDocumentStore();
  const document = store.getOrCreate("replace-block", markdown);
  const block = document.blocks[1]!;
  const updated = store.replaceBlock({
    taskId: document.taskId,
    blockId: block.id,
    expectedVersion: document.version,
    expectedFingerprint: block.fingerprint,
    replacementMarkdown: "Updated paragraph.",
  });

  assert.equal(updated.currentMarkdown, markdown.replace("First paragraph.", "Updated paragraph."));
  assert.equal(updated.version, 2);
  assert.throws(() => store.replaceBlock({
    taskId: document.taskId,
    blockId: block.id,
    expectedVersion: document.version,
    expectedFingerprint: block.fingerprint,
    replacementMarkdown: "Stale replacement.",
  }), ReportDocumentConflictError);
});

test("records document snapshots and restores a selected version as a new version", () => {
  const store = new InMemoryReportDocumentStore();
  const first = store.getOrCreate("version-history", markdown);
  const block = first.blocks[1]!;
  const second = store.replaceBlock({
    taskId: first.taskId,
    blockId: block.id,
    expectedVersion: first.version,
    expectedFingerprint: block.fingerprint,
    replacementMarkdown: "Updated paragraph.",
  });
  assert.deepEqual(store.listVersions(first.taskId).map((item) => item.version), [1, 2]);
  const restored = store.restoreVersion({
    taskId: first.taskId,
    version: 1,
    expectedVersion: second.version,
  });
  assert.equal(restored.version, 3);
  assert.equal(restored.currentMarkdown, markdown);
  assert.deepEqual(store.listVersions(first.taskId).map((item) => item.version), [1, 2, 3]);
});

// Compile-time assertion for both store implementations.
const _stores: ReportDocumentStore[] = [new InMemoryReportDocumentStore()];
