import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryReportDocumentStore,
  ReportDocumentConflictError,
  SqliteReportDocumentStore,
} from "../src/report-document-store.js";
import {
  InMemoryReportEditorStore,
  OpenAIReportEditorModel,
  ReportEditorService,
  SqliteReportEditorStore,
  type ReportEditorModel,
  type ReportEditorModelInput,
} from "../src/report-editor.js";

const markdown = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";

const model: ReportEditorModel = {
  async rewrite() {
    return "Updated first paragraph.";
  },
};

test("applies only the proposed block and keeps an auditable conversation", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-task", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const proposal = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Make this more direct.",
  });
  const applied = service.apply(document.taskId, proposal.operation.id);

  assert.equal(
    applied.document.currentMarkdown,
    "# Title\n\nUpdated first paragraph.\n\nSecond paragraph.",
  );
  assert.equal(applied.document.baselineMarkdown, markdown);
  assert.equal(applied.document.version, 2);
  assert.deepEqual(
    service.conversations(document.taskId, block.id)[0]?.messages.map((message) => message.role),
    ["user", "assistant", "event"],
  );
});

test("keeps the replacement out of the conversation and carries prior turns forward", async () => {
  let lastInput: ReportEditorModelInput | undefined;
  const conversationalModel: ReportEditorModel = {
    async rewrite(input) {
      lastInput = input;
      return {
        replacementMarkdown: "Updated first paragraph.",
        reply: "我已完成修改，右侧已经生成预览。",
      };
    },
  };
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, conversationalModel);
  const document = documents.getOrCreate("report-editor-conversation", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const first = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Make this clearer.",
  });
  assert.equal(first.operation.replacementMarkdown, "Updated first paragraph.");
  assert.equal(
    service.conversations(document.taskId, block.id)[0]?.messages.find((message) => message.role === "assistant")?.content,
    "我已完成修改，右侧已经生成预览。",
  );

  service.apply(document.taskId, first.operation.id);
  const updated = documents.get(document.taskId)!;
  const updatedBlock = updated.blocks.find((item) => item.id === "paragraph-1")!;
  await service.propose({
    taskId: document.taskId,
    blockId: updatedBlock.id,
    documentVersion: updated.version,
    originalFingerprint: updatedBlock.fingerprint,
    instruction: "Make it more concise.",
    conversationId: first.conversation.id,
  });
  assert.deepEqual(lastInput?.conversationHistory?.map((message) => message.role), ["user", "assistant"]);
  assert.equal(lastInput?.conversationHistory?.[1]?.content, "我已完成修改，右侧已经生成预览。");
});

test("answers a conversational message without creating an edit operation", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, {
    async plan() {
      return { intent: "chat", urls: [], targetBlockIds: [] };
    },
    async answer() {
      return "可以，我们可以继续讨论这份报告。";
    },
    async rewrite() {
      throw new Error("rewrite must not be called for chat");
    },
  });
  const document = documents.getOrCreate("report-editor-chat", markdown);
  const plan = await service.planMessage({
    taskId: document.taskId,
    scope: "document",
    blockIds: [],
    documentVersion: document.version,
    instruction: "你能和我聊聊吗？",
  });
  assert.equal(plan.intent, "chat");
  const answer = await service.answerMessage({
    taskId: document.taskId,
    scope: "document",
    blockIds: [],
    documentVersion: document.version,
    instruction: "你能和我聊聊吗？",
  });
  assert.equal(answer.summary, "可以，我们可以继续讨论这份报告。");
  assert.equal(service.operations(document.taskId).length, 0);
  assert.deepEqual(
    service.conversations(document.taskId, "document")[0]?.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("rejects nested structured output instead of treating it as report markdown", async () => {
  const editorModel = new OpenAIReportEditorModel(
    { model: "test", api_key: "test", base_url: "https://example.com/v1" } as never,
    {
      async chat() {
        return {
          content: JSON.stringify({
            replacementMarkdown: JSON.stringify({ replacementMarkdown: "corrupt report" }),
            reply: "done",
          }),
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    } as never,
  );
  await assert.rejects(
    () => editorModel.rewrite({ blockMarkdown: markdown, instruction: "Change it." }),
    /nested structured response/u,
  );
});

test("rejects a stale proposal instead of overwriting a newer block", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-stale", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const first = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "First proposal.",
  });
  documents.replaceScope({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: [block.id],
    expectedVersion: document.version,
    expectedFingerprint: block.fingerprint,
    replacementMarkdown: "A newer paragraph.",
  });

  assert.throws(
    () => service.apply(document.taskId, first.operation.id),
    ReportDocumentConflictError,
  );
  assert.equal(store.getOperation(first.operation.id)?.state, "stale");
  assert.equal(
    documents.get(document.taskId)?.currentMarkdown,
    "# Title\n\nA newer paragraph.\n\nSecond paragraph.",
  );
});

test("supersedes an earlier pending preview in the same scope", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-supersede", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const first = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "First change.",
  });
  const second = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Use a different change.",
    conversationId: first.conversation.id,
  });

  assert.equal(store.getOperation(first.operation.id)?.state, "rejected");
  assert.equal(store.getOperation(second.operation.id)?.state, "proposed");
  assert.equal(service.operations(document.taskId, block.id).filter((item) => item.state === "proposed").length, 1);
});

test("allows an AI proposal to delete the selected report block", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const deletionModel: ReportEditorModel = {
    async rewrite() {
      return { replacementMarkdown: "", reply: "已删除选中内容，右侧可以预览结果。" };
    },
  };
  const service = new ReportEditorService(documents, store, deletionModel);
  const document = documents.getOrCreate("report-editor-delete", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const proposal = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Delete this paragraph.",
  });
  assert.equal(proposal.operation.replacementMarkdown, "");

  const applied = service.apply(document.taskId, proposal.operation.id);
  assert.doesNotMatch(applied.document.currentMarkdown, /First paragraph\./u);
  assert.match(applied.document.currentMarkdown, /Second paragraph\./u);
});

test("records a manual scoped save as an undoable edit operation", () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-manual", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const saved = service.saveManual({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: [block.id],
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    replacementMarkdown: "Manually revised paragraph.",
  });

  assert.equal(saved.operation.origin, "manual");
  assert.equal(saved.operation.state, "applied");
  assert.equal(
    saved.document.currentMarkdown,
    "# Title\n\nManually revised paragraph.\n\nSecond paragraph.",
  );
  assert.match(
    service.conversations(document.taskId, block.id)[0]?.messages.at(-1)?.content ?? "",
    /手动保存/u,
  );

  const undone = service.undo(document.taskId, saved.operation.id);
  assert.equal(undone.document.currentMarkdown, markdown);
});

test("replaces only a verified text range inside a selected block", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const textModel: ReportEditorModel = {
    async rewrite() {
      return { replacementMarkdown: "section", reply: "已生成文字级修改预览。" };
    },
  };
  const service = new ReportEditorService(documents, store, textModel);
  const document = documents.getOrCreate("report-editor-text-range", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;
  const rangeStart = block.markdown.indexOf("paragraph");
  const rangeEnd = rangeStart + "paragraph".length;

  const proposal = await service.propose({
    taskId: document.taskId,
    scope: "text",
    blockIds: [block.id],
    rangeStart,
    rangeEnd,
    originalText: "paragraph",
    documentVersion: document.version,
    instruction: "Replace the selected word.",
  });
  const applied = service.apply(document.taskId, proposal.operation.id);

  assert.equal(proposal.operation.scope, "text");
  assert.equal(proposal.operation.rangeStart, rangeStart);
  assert.equal(applied.document.currentMarkdown, "# Title\n\nFirst section.\n\nSecond paragraph.");
});

test("restores a report snapshot through an auditable operation", () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-restore", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;
  const saved = service.saveManual({
    taskId: document.taskId,
    blockIds: [block.id],
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    replacementMarkdown: "A newer paragraph.",
  });

  const restored = service.restoreVersion({
    taskId: document.taskId,
    version: 1,
    expectedVersion: saved.document.version,
  });
  assert.equal(restored.operation.origin, "restore");
  assert.equal(restored.document.currentMarkdown, markdown);
  assert.equal(restored.document.version, 3);
});

test("supports contiguous multi-block and explicit whole-document scopes", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const document = documents.getOrCreate("report-editor-scopes", markdown);
  const multiModel: ReportEditorModel = {
    async rewrite(input) {
      return input.blockMarkdown.includes("Second paragraph.")
        ? "First revised.\n\nSecond revised."
        : "# Revised title\n\nFirst paragraph.\n\nSecond paragraph.";
    },
  };
  const service = new ReportEditorService(documents, store, multiModel);
  const first = document.blocks.find((item) => item.id === "paragraph-1")!;
  const second = document.blocks.find((item) => item.id === "paragraph-2")!;
  const multi = await service.propose({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: [first.id, second.id],
    documentVersion: 1,
    instruction: "Revise both paragraphs.",
  });
  const multiApplied = service.apply(document.taskId, multi.operation.id);
  assert.match(multiApplied.document.currentMarkdown, /First revised\.\n\nSecond revised\./u);

  const whole = await service.propose({
    taskId: document.taskId,
    scope: "document",
    documentVersion: multiApplied.document.version,
    instruction: "Rewrite the report title only.",
  });
  const wholeApplied = service.apply(document.taskId, whole.operation.id);
  assert.equal(wholeApplied.document.currentMarkdown, "# Revised title\n\nFirst paragraph.\n\nSecond paragraph.");
});

test("performs exact whole-document replacements without calling the model", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const document = documents.getOrCreate("report-editor-deterministic", markdown);
  const service = new ReportEditorService(documents, store, {
    async rewrite() {
      throw new Error("the model must not be called for an exact replacement");
    },
  });
  const proposal = await service.propose({
    taskId: document.taskId,
    scope: "document",
    documentVersion: document.version,
    instruction: "把标题修改为“Revised title”",
  });
  assert.equal(
    proposal.operation.replacementMarkdown,
    "# Revised title\n\nFirst paragraph.\n\nSecond paragraph.",
  );
});

test("chunks a large whole-document edit while applying one previewed version", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const largeMarkdown = Array.from({ length: 18 }, (_, index) =>
    `## Section ${index + 1}\n\n${"detail ".repeat(1_800)}`,
  ).join("\n\n");
  const document = documents.getOrCreate("report-editor-chunked", largeMarkdown);
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const service = new ReportEditorService(documents, store, {
    async rewrite(input) {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { replacementMarkdown: input.blockMarkdown, reply: "Preview ready." };
    },
  });

  const proposal = await service.propose({
    taskId: document.taskId,
    scope: "document",
    documentVersion: document.version,
    instruction: "Keep all content unchanged.",
  });
  const applied = service.apply(document.taskId, proposal.operation.id);

  assert.ok(calls > 1);
  assert.ok(maximumActive > 1);
  assert.equal(applied.document.currentMarkdown, largeMarkdown);
  assert.equal(applied.document.version, 2);
});

test("uses only selected search sources and adopts them after apply", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  let observedSources: string[] = [];
  const service = new ReportEditorService(documents, store, {
    async rewrite(input) {
      observedSources = input.sources?.map((source) => source.url) ?? [];
      return { replacementMarkdown: "Evidence [source](https://example.com/source).", reply: "Preview ready." };
    },
  });
  const document = documents.getOrCreate("report-editor-search", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;
  const search = service.recordSearch({
    taskId: document.taskId,
    scopeKey: block.id,
    query: "evidence",
    retrievers: ["duckduckgo"],
    results: [{ provider: "duckduckgo", title: "Source", url: "https://example.com/source" }],
  });
  const sourceId = search.results[0]!.id;
  service.selectSearchResults(document.taskId, search.session.id, [sourceId]);

  const proposal = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Add evidence.",
    sourceIds: [sourceId],
  });
  assert.deepEqual(observedSources, ["https://example.com/source"]);
  service.apply(document.taskId, proposal.operation.id);
  const audit = service.audit(document.taskId, []);
  assert.equal(audit.verifiedLinks, 1);
});

test("persists conversations and restores content through a recorded undo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "think-tank-report-editor-"));
  const filePath = join(directory, "tasks.sqlite");
  const documents = new SqliteReportDocumentStore(filePath);
  const store = new SqliteReportEditorStore(filePath);
  const service = new ReportEditorService(documents, store, model);
  try {
    const document = documents.getOrCreate("report-editor-sqlite", markdown);
    const block = document.blocks.find((item) => item.id === "paragraph-1")!;
    const proposal = await service.propose({
      taskId: document.taskId,
      blockId: block.id,
      documentVersion: document.version,
      originalFingerprint: block.fingerprint,
      instruction: "Revise this sentence.",
    });
    const applied = service.apply(document.taskId, proposal.operation.id);
    const undone = service.undo(document.taskId, applied.operation.id);

    assert.equal(undone.document.currentMarkdown, markdown);
    assert.equal(undone.document.version, 3);
    assert.equal(store.getOperation(applied.operation.id)?.undoneOperationId, undone.operation.id);
    assert.equal(service.conversations(document.taskId, block.id)[0]?.messages.length, 5);
  } finally {
    store.close();
    documents.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
