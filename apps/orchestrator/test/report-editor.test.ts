import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  InMemoryReportDocumentStore,
  ReportDocumentConflictError,
  reportMarkdownFingerprint,
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
  assert.equal(applied.document.version, 1);
  assert.equal(applied.document.isDirty, true);
  const saved = service.saveVersion({ taskId: document.taskId, expectedVersion: applied.document.version });
  assert.equal(saved.version, 2);
  assert.equal(saved.isDirty, false);
  const messages = service.conversations(document.taskId, block.id)[0]?.messages ?? [];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "event"],
  );
  assert.equal(messages[1]?.operationId, proposal.operation.id);
  assert.equal(messages[2]?.operationId, proposal.operation.id);
});

test("invalidates every applied operation in a discarded draft batch", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  let replacement = "Saved paragraph.";
  const service = new ReportEditorService(documents, store, {
    async rewrite() {
      const current = replacement;
      replacement = replacement === "Saved paragraph."
        ? "Draft paragraph one."
        : "Draft paragraph two.";
      return current;
    },
  });
  const document = documents.getOrCreate("report-editor-discard-batch", markdown);
  const firstBlock = document.blocks.find((item) => item.id === "paragraph-1")!;
  const firstProposal = await service.propose({
    taskId: document.taskId,
    blockId: firstBlock.id,
    documentVersion: document.version,
    originalFingerprint: firstBlock.fingerprint,
    instruction: "Revise the paragraph.",
  });
  const firstApplied = service.apply(document.taskId, firstProposal.operation.id);
  const saved = service.saveVersion({ taskId: document.taskId, expectedVersion: firstApplied.document.version });
  const savedBlock = saved.blocks.find((item) => item.id === "paragraph-1")!;

  const secondProposal = await service.propose({
    taskId: document.taskId,
    blockId: savedBlock.id,
    documentVersion: saved.version,
    originalFingerprint: savedBlock.fingerprint,
    instruction: "Revise the paragraph again.",
  });
  const secondApplied = service.apply(document.taskId, secondProposal.operation.id);
  const secondBlock = secondApplied.document.blocks.find((item) => item.id === "paragraph-1")!;
  const thirdProposal = await service.propose({
    taskId: document.taskId,
    blockId: secondBlock.id,
    documentVersion: secondApplied.document.version,
    originalFingerprint: secondBlock.fingerprint,
    instruction: "Revise the paragraph a third time.",
  });
  service.apply(document.taskId, thirdProposal.operation.id);

  const discarded = service.discardDraft({ taskId: document.taskId, expectedVersion: saved.version });
  assert.equal(discarded.currentMarkdown, saved.currentMarkdown);
  assert.equal(store.getOperation(firstProposal.operation.id)?.state, "applied");
  assert.equal(store.getOperation(secondProposal.operation.id)?.state, "discarded");
  assert.equal(store.getOperation(thirdProposal.operation.id)?.state, "discarded");
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
  const assistantMessage = service.conversations(document.taskId, block.id)[0]?.messages.find((message) => message.role === "assistant");
  assert.equal(
    assistantMessage?.content,
    "我已完成修改，右侧已经生成预览。",
  );
  assert.equal(assistantMessage?.operationId, first.operation.id);

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

test("keeps one continuous report conversation across different selected blocks", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-single-conversation", markdown);
  const first = document.blocks.find((item) => item.id === "paragraph-1")!;
  const second = document.blocks.find((item) => item.id === "paragraph-2")!;

  const firstProposal = await service.propose({
    taskId: document.taskId,
    blockId: first.id,
    documentVersion: document.version,
    originalFingerprint: first.fingerprint,
    instruction: "Revise the first paragraph.",
  });
  service.reject(document.taskId, firstProposal.operation.id);
  const secondProposal = await service.propose({
    taskId: document.taskId,
    blockId: second.id,
    documentVersion: document.version,
    originalFingerprint: second.fingerprint,
    instruction: "Revise the second paragraph.",
    conversationId: firstProposal.conversation.id,
  });

  assert.equal(secondProposal.conversation.id, firstProposal.conversation.id);
  assert.equal(secondProposal.conversation.blockId, "document");
  assert.equal(service.conversations(document.taskId).length, 1);
  assert.deepEqual(
    service.conversations(document.taskId)[0]?.messages.filter((message) => message.role === "user").map((message) => message.blockId),
    ["paragraph-1", "paragraph-2"],
  );
});

test("stores the original user instruction separately from the execution instruction", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, model);
  const document = documents.getOrCreate("report-editor-original-instruction", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const proposal = await service.propose({
    taskId: document.taskId,
    blockId: block.id,
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "Rewrite the selected paragraph with concise wording.",
    userInstruction: "缩写总体判断第一段的内容，使其更加凝练、清晰。",
  });

  assert.equal(
    service.conversations(document.taskId, block.id)[0]?.messages.find((message) => message.role === "user")?.content,
    "缩写总体判断第一段的内容，使其更加凝练、清晰。",
  );
  assert.equal(proposal.operation.state, "proposed");
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

test("routes an explicit selected-block deletion to a preview without trusting model classification", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  let plannerCalled = false;
  const service = new ReportEditorService(documents, store, {
    async plan() {
      plannerCalled = true;
      return { intent: "chat", urls: [], targetBlockIds: [] };
    },
    async rewrite() {
      return { replacementMarkdown: "", reply: "已准备删除预览。" };
    },
  });
  const document = documents.getOrCreate("report-editor-explicit-delete", markdown);
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;

  const plan = await service.planMessage({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: [block.id],
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: "删除这一段",
  });

  assert.equal(plannerCalled, false);
  assert.equal(plan.intent, "edit");
  const proposal = await service.propose({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: [block.id],
    documentVersion: document.version,
    originalFingerprint: block.fingerprint,
    instruction: plan.editInstruction!,
  });
  assert.equal(proposal.operation.state, "proposed");
  assert.equal(proposal.operation.replacementMarkdown, "");
  assert.equal(service.operations(document.taskId).length, 1);
});

test("streams a complete conversational answer before persisting it", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, {
    async rewrite() {
      throw new Error("rewrite must not be called for chat");
    },
    async *streamAnswer() {
      yield "第一";
      yield "条";
    },
  });
  const document = documents.getOrCreate("report-editor-stream", markdown);
  const events = [] as Array<{ type: string; content?: string; summary?: string }>;
  for await (const event of service.streamAnswerMessage({
    taskId: document.taskId,
    scope: "document",
    blockIds: [],
    documentVersion: document.version,
    instruction: "给我一个结论。",
  })) {
    events.push(event.type === "delta"
      ? event
      : { type: event.type, summary: event.summary });
  }
  assert.deepEqual(events, [
    { type: "delta", content: "第一" },
    { type: "delta", content: "条" },
    { type: "done", summary: "第一条" },
  ]);
  assert.deepEqual(
    service.conversations(document.taskId, "document")[0]?.messages.map((message) => [message.role, message.content]),
    [["user", "给我一个结论。"], ["assistant", "第一条"]],
  );
});

test("uses the latest model settings for each streamed report answer", async (t) => {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    model: unknown;
  }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model?: unknown;
    };
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      model: body.model,
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        "data: [DONE]\n\n",
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const port = (upstream.address() as AddressInfo).port;
  let config = {
    model: "old-model",
    api_key: "old-key",
    base_url: `http://127.0.0.1:${port}/old/v1`,
  } as never;
  const editorModel = new OpenAIReportEditorModel(() => config);
  const input = {
    blockMarkdown: markdown,
    instruction: "Summarize the report.",
  };

  for await (const _delta of editorModel.streamAnswer(input)) {
    // Drain the first response before changing settings.
  }
  config = {
    model: "new-model",
    api_key: "new-key",
    base_url: `http://127.0.0.1:${port}/new/v1`,
  } as never;
  for await (const _delta of editorModel.streamAnswer(input)) {
    // Drain the second response so all request assertions are deterministic.
  }

  assert.deepEqual(requests, [
    {
      path: "/old/v1/chat/completions",
      authorization: "Bearer old-key",
      model: "old-model",
    },
    {
      path: "/new/v1/chat/completions",
      authorization: "Bearer new-key",
      model: "new-model",
    },
  ]);
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

test("applies structural block edits without resolving removed block ids", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const structuralModel: ReportEditorModel = {
    async rewrite(input) {
      if (input.instruction === "merge") return { replacementMarkdown: "Merged paragraph." };
      if (input.instruction === "split") return { replacementMarkdown: "First half.\n\nSecond half." };
      return { replacementMarkdown: "# Retyped paragraph" };
    },
  };
  const service = new ReportEditorService(documents, store, structuralModel);
  const document = documents.getOrCreate("report-editor-structural", markdown);
  const paragraphs = document.blocks.filter((item) => item.kind === "paragraph");

  const merged = await service.propose({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: paragraphs.map((item) => item.id),
    documentVersion: document.version,
    originalFingerprint: reportMarkdownFingerprint(paragraphs.map((item) => item.markdown).join("\n\n")),
    instruction: "merge",
  });
  const mergedApplied = service.apply(document.taskId, merged.operation.id);
  assert.equal(mergedApplied.operation.structuralChange, "merge");
  assert.equal(mergedApplied.operation.appliedScopeMarkdown, "Merged paragraph.");
  assert.match(
    service.conversations(document.taskId, paragraphs.map((item) => item.id).join(","))[0]?.messages.find((message) => message.role === "event")?.content ?? "",
    /修改已暂存/u,
  );
  const mergedUndone = service.undo(document.taskId, merged.operation.id);
  assert.equal(mergedUndone.document.currentMarkdown, markdown);

  const restored = documents.get(document.taskId)!;
  const first = restored.blocks.find((item) => item.kind === "paragraph")!;
  const split = await service.propose({
    taskId: restored.taskId,
    blockId: first.id,
    documentVersion: restored.version,
    originalFingerprint: first.fingerprint,
    instruction: "split",
  });
  const splitApplied = service.apply(restored.taskId, split.operation.id);
  assert.equal(splitApplied.operation.structuralChange, "split");

  const splitDocument = documents.get(restored.taskId)!;
  const splitBlocks = splitDocument.blocks.filter((item) => item.text.includes("half"));
  assert.equal(splitBlocks.length, 2);
  assert.equal(service.undo(restored.taskId, split.operation.id).document.currentMarkdown, markdown);
});

test("inserts a generated transition paragraph before the selected block", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  let receivedMode: ReportEditorModelInput["editMode"];
  const service = new ReportEditorService(documents, store, {
    async rewrite(input) {
      receivedMode = input.editMode;
      return { replacementMarkdown: "在外部冲击与韧性建设之间，需要先建立清晰的承接逻辑。", reply: "已生成新增段落预览。" };
    },
  });
  const document = documents.getOrCreate("report-editor-insert-before", markdown);
  const anchor = document.blocks.find((item) => item.id === "paragraph-2")!;

  const proposal = await service.propose({
    taskId: document.taskId,
    blockId: anchor.id,
    documentVersion: document.version,
    originalFingerprint: anchor.fingerprint,
    instruction: "请在这段之前加一个过渡的段落",
  });

  assert.equal(receivedMode, "insert_before");
  assert.equal(proposal.operation.placement, "insert_before");
  assert.equal(proposal.operation.state, "proposed");
  assert.equal(proposal.operation.originalMarkdown, "Second paragraph.");
  assert.equal(document.currentMarkdown, markdown);

  const applied = service.apply(document.taskId, proposal.operation.id);
  assert.equal(
    applied.document.currentMarkdown,
    "# Title\n\nFirst paragraph.\n\n在外部冲击与韧性建设之间，需要先建立清晰的承接逻辑。\n\nSecond paragraph.",
  );
  assert.match(applied.document.currentMarkdown, /Second paragraph\./u);
  assert.equal(applied.operation.structuralChange, "insert");
  assert.ok((applied.operation.appliedBlockIds ?? []).length >= 1);

  const undone = service.undo(document.taskId, proposal.operation.id);
  assert.equal(undone.document.currentMarkdown, markdown);
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
  assert.equal(restored.document.version, 2);
  assert.equal(restored.document.isDirty, true);
  assert.equal(service.saveVersion({ taskId: document.taskId, expectedVersion: restored.document.version }).version, 3);
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

test("asks for an application selection instead of silently editing the whole report", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, {
    async rewrite() {
      throw new Error("an unscoped local edit must not reach rewrite");
    },
    async plan() {
      throw new Error("an unscoped local edit must be rejected before planning");
    },
  });
  const document = documents.getOrCreate("report-editor-unscoped-local-edit", markdown);

  const plan = await service.planMessage({
    taskId: document.taskId,
    scope: "document",
    blockIds: [],
    documentVersion: document.version,
    instruction: "合并这俩段，再缩写这一段",
  });

  assert.equal(plan.intent, "clarify");
  assert.match(plan.reply ?? "", /选择段落/u);
  assert.match(plan.reply ?? "", /已选 N 段/u);
});

test("applies a selected three-block merge as one scoped preview", async () => {
  const documents = new InMemoryReportDocumentStore();
  const store = new InMemoryReportEditorStore();
  const service = new ReportEditorService(documents, store, {
    async rewrite(input) {
      assert.equal(input.blockMarkdown, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
      return { replacementMarkdown: "Merged and shortened paragraph.", reply: "已生成三段合并预览。" };
    },
  });
  const document = documents.getOrCreate(
    "report-editor-three-block-merge",
    "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nOutside paragraph.",
  );
  const paragraphs = document.blocks.filter((item) => item.kind === "paragraph");
  const selected = paragraphs.slice(0, 3);

  const proposal = await service.propose({
    taskId: document.taskId,
    scope: "blocks",
    blockIds: selected.map((item) => item.id),
    documentVersion: document.version,
    originalFingerprint: reportMarkdownFingerprint(selected.map((item) => item.markdown).join("\n\n")),
    instruction: "合并并缩写这三段",
  });
  assert.equal(proposal.operation.blockIds.length, 3);
  assert.equal(proposal.operation.state, "proposed");
  assert.equal(proposal.operation.replacementMarkdown, "Merged and shortened paragraph.");

  const applied = service.apply(document.taskId, proposal.operation.id);
  assert.match(applied.document.currentMarkdown, /Merged and shortened paragraph\./u);
  assert.doesNotMatch(applied.document.currentMarkdown, /First paragraph\.|Second paragraph\.|Third paragraph\./u);
  assert.match(applied.document.currentMarkdown, /Outside paragraph\./u);
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
  assert.equal(applied.document.version, 1);
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
    assert.equal(undone.document.version, 1);
    assert.equal(store.getOperation(applied.operation.id)?.undoneOperationId, undone.operation.id);
    const messages = service.conversations(document.taskId, block.id)[0]?.messages ?? [];
    assert.equal(messages.length, 4);
    assert.equal(messages.find((message) => message.role === "assistant")?.operationId, proposal.operation.id);
    assert.equal(messages.find((message) => message.role === "event")?.operationId, proposal.operation.id);
  } finally {
    store.close();
    documents.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
