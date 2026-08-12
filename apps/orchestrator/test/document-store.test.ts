import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TaskDocumentStore } from "../src/document-store.js";

test("stores task-isolated camel-case records readable by the researcher", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "think-tank-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskDocumentStore(root);

  const record = await store.save(
    "task-1",
    "notes.txt",
    Buffer.from("private notes"),
  );
  const listed = await store.list("task-1");
  const stored = JSON.parse(
    await readFile(
      join(root, "task-1", record.documentId, "record.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  assert.deepEqual(listed, [record]);
  assert.equal(stored.documentId, record.documentId);
  assert.equal(stored.taskId, "task-1");
  assert.equal(stored.document_id, undefined);
  assert.equal(
    await readFile(
      join(root, "task-1", record.documentId, "content.txt"),
      "utf8",
    ),
    "private notes",
  );
});

test("copies task documents into an independent retry task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "think-tank-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskDocumentStore(root);
  const original = await store.save("source-task", "notes.txt", Buffer.from("retry me"));

  const copiedIds = await store.copyTask("source-task", "retry-task");
  const copied = await store.list("retry-task");

  assert.equal(copied.length, 1);
  assert.notEqual(copied[0]?.documentId, original.documentId);
  assert.equal(copiedIds.get(original.documentId), copied[0]?.documentId);
});

test("enforces per-file, task-size, and document-count limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "think-tank-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskDocumentStore(root, {
    maxBytes: 5,
    maxTaskBytes: 8,
    maxCount: 2,
  });

  await store.save("task-1", "one.txt", Buffer.from("1234"));
  await assert.rejects(
    store.save("task-1", "large.txt", Buffer.from("123456")),
    /per-file size limit/u,
  );
  await assert.rejects(
    store.save("task-1", "total.txt", Buffer.from("56789")),
    /task size limit/u,
  );
  await store.save("task-1", "two.txt", Buffer.from("5678"));
  await assert.rejects(
    store.save("task-1", "three.txt", Buffer.from("x")),
    /document count limit/u,
  );
});

test("rejects traversal and ignores an unrelated corrupt record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "think-tank-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskDocumentStore(root);
  const record = await store.save("task-1", "notes.md", Buffer.from("# Notes"));
  await writeFile(
    join(root, "task-1", record.documentId, "record.json"),
    "not-json",
  );

  assert.deepEqual(await store.list("task-1"), []);
  await assert.rejects(store.list("../task-1"), /invalid task id/u);
  await assert.rejects(
    store.save("task-1", "../notes.txt", Buffer.from("notes")),
    /invalid document name/u,
  );
  await assert.rejects(
    store.save("task-1", "archive.zip", Buffer.from("PK\u0003\u0004")),
    /document type is not allowed/u,
  );
});
