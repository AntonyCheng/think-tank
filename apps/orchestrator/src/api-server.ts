import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { parseWorkflow } from "agency-orchestrator";

import {
  assertCheckpointCompatible,
  checkpointPolicyFingerprint,
  checkpointRuntimeFingerprint,
  runResearchTopic,
} from "./research-runner.js";
import {
  ResearchTaskManager,
  type ResearchTaskEvent,
} from "./research-tasks.js";
import { SqliteResearchTaskStore } from "./research-task-store.js";
import { RuntimeSettingsStore } from "./settings-store.js";
import {
  ResearchProfileError,
  resolveResearchProfile,
  type ResearchProfile,
} from "./research-profile.js";
import {
  currentResearchProfileEnvironment,
} from "./research-profile-runtime.js";
import {
  CachedResearchCapabilityProvider,
  HttpResearchCapabilityProvider,
  type ResearchCapabilityProvider,
  type RetrieverCatalog,
} from "./gptr-capabilities.js";
import { replaceEnvironmentValue } from "./environment-file.js";
import { loadAgentCatalog } from "./agent-catalog.js";
import { agentsDirForLanguage } from "./ao-runtime.js";
import { TaskDocumentStore } from "./document-store.js";
import {
  InMemoryReportDocumentStore,
  ReportDocumentConflictError,
  SqliteReportTransactionRunner,
  SqliteReportDocumentStore,
  type ReportDocumentStore,
} from "./report-document-store.js";
import {
  InMemoryReportEditorStore,
  OpenAIReportEditorModel,
  ReportEditorService,
  SqliteReportEditorStore,
  UnavailableReportEditorModel,
} from "./report-editor.js";

const MAX_BODY_BYTES = 64 * 1024;
// Full-document report edits contain the complete Markdown document. Keep a
// generous transport limit for this endpoint without weakening other APIs.
const REPORT_EDITOR_BODY_BYTES = 16 * 1024 * 1024;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = resolve(moduleDirectory, "../../web/dist");

export function createApiServer(
  manager: ResearchTaskManager,
  settings?: RuntimeSettingsStore,
  researcherServiceUrl: () => string = () => "http://127.0.0.1:8010",
  capabilityProvider: ResearchCapabilityProvider =
    new CachedResearchCapabilityProvider(
      new HttpResearchCapabilityProvider(),
    ),
  environmentFilePath = resolve(moduleDirectory, "../../../.env"),
  reportDocuments: ReportDocumentStore = new InMemoryReportDocumentStore(),
  reportEditor = new ReportEditorService(
    reportDocuments,
    new InMemoryReportEditorStore(),
    settings
      ? new OpenAIReportEditorModel(settings.getRuntimeSettings().planner)
      : new UnavailableReportEditorModel(),
  ),
  webRoot = process.env.WEB_ROOT
    ? resolve(process.env.WEB_ROOT)
    : defaultWebRoot,
) {
  const documents = new TaskDocumentStore();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const readiness = await inspectRuntimeReadiness(
          settings,
          researcherServiceUrl(),
        );
        return sendJson(
          response,
          readiness.status === "ready" ? 200 : 503,
          readiness,
        );
      }

      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const asset = await readWebAsset(webRoot, url.pathname);
        if (asset) {
          response.writeHead(200, {
            "Content-Type": contentTypeFor(asset.file),
            "Cache-Control": asset.file === "index.html"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
          });
          response.end(asset.content);
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, {
          agents: await loadAgentCatalog(agentsDirForLanguage("zh")),
        });
      }

      if (
        settings &&
        request.method === "GET" &&
        url.pathname === "/api/settings"
      ) {
        const catalog = await loadRetrieverCatalog(
          settings,
          researcherServiceUrl(),
          capabilityProvider,
        );
        return sendJson(response, 200, {
          ...settings.getPublicSettings(),
          retrieverCapabilities: catalog.retrievers,
          maxRetrievers: catalog.maxRetrievers,
        });
      }

      if (
        settings &&
        request.method === "PUT" &&
        url.pathname === "/api/settings"
      ) {
        const body = await readJsonBody(request);
        const catalog = await loadRetrieverCatalog(
          settings,
          researcherServiceUrl(),
          capabilityProvider,
        );
        try {
          const apiKey = optionalApiKey(body.apiKey);
          if (apiKey) {
            await replaceEnvironmentValue(
              environmentFilePath,
              "OPENAI_API_KEY",
              apiKey,
            );
            settings.setApiKey(apiKey);
          }
          return sendJson(response, 200, {
            ...settings.update(body, {
              retrievers: catalog.retrievers.map((item) => item.id),
              maxRetrievers: catalog.maxRetrievers,
            }),
            retrieverCapabilities: catalog.retrievers,
            maxRetrievers: catalog.maxRetrievers,
          });
        } catch (error) {
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJsonBody(request);
        const topic = typeof body.topic === "string" ? body.topic : "";
        if (!topic.trim()) {
          return sendJson(response, 422, {
            error: "topic must be a non-empty string",
          });
        }
        const runtimeSettings = settings?.getRuntimeSettings();
        const catalog = settings
          ? await loadRetrieverCatalog(
              settings,
              researcherServiceUrl(),
              capabilityProvider,
            )
          : undefined;
        const retrievers = runtimeSettings?.retrievers ?? ["duckduckgo"];
        const availableRetrievers = catalog?.retrievers.map(
          (item) => item.id,
        ) ?? retrievers;
        const environment = currentResearchProfileEnvironment(
          retrievers,
          runtimeSettings?.gptrDeepLimits,
          catalog?.maxRetrievers,
          availableRetrievers,
        );
        try {
          const researchProfile = resolveResearchProfile(
            body.researchProfile,
            environment.defaults,
            environment.capabilities,
          );
          if (researchProfile.mode === "synthesis") {
            throw new ResearchProfileError(
              "profile_invariant_violation",
              "$.mode",
              "Synthesis mode is only valid as an AO step override.",
            );
          }
          return sendJson(
            response,
            202,
            manager.submit(topic, {
              ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
              researchProfile,
              researchCapabilities: environment.capabilities,
            }),
          );
        } catch (error) {
          if (!(error instanceof ResearchProfileError)) throw error;
          return sendJson(response, 422, {
            error: error.message,
            code: error.code,
            path: rebaseResearchProfilePath(error.path),
          });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const filter = url.searchParams.get("filter") ?? "all";
        if (![
          "all",
          "completed",
          "warnings",
          "unfinished",
        ].includes(filter)) {
          return sendJson(response, 422, { error: "history filter is invalid" });
        }
        const requestedLimit = url.searchParams.get("limit");
        const limit = requestedLimit === null
          ? undefined
          : Number(requestedLimit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          return sendJson(response, 422, { error: "history limit is invalid" });
        }
        return sendJson(response, 200, manager.listHistory({
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor")! }
            : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(url.searchParams.get("q")
            ? { query: url.searchParams.get("q")! }
            : {}),
          filter: filter as import("./research-tasks.js").ResearchHistoryFilter,
        }));
      }

      if (
        request.method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-document" &&
        segments.length === 4
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (
          !task.output ||
          !["completed", "completed_with_warnings"].includes(task.status)
        ) {
          return sendJson(response, 409, {
            error: "report document is only available after completion",
          });
        }
        const document = reportDocuments.getOrCreate(task.id, task.output);
        return sendJson(response, 200, {
          ...document,
          audit: reportEditor.audit(task.id, reportEditorSources(task)),
        });
      }

      if (
        request.method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-document" &&
        segments[4] === "versions" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report versions are only available after completion" });
        }
        reportDocuments.getOrCreate(task.id, task.output!);
        return sendJson(response, 200, { versions: reportDocuments.listVersions(task.id) });
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "messages" &&
        segments[5] === "stream" &&
        segments.length === 6
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const body = await readJsonBody(request, REPORT_EDITOR_BODY_BYTES);
        const scope: "document" | "text" | "blocks" = body.scope === "document"
          ? "document"
          : body.scope === "text" ? "text" : "blocks";
        const requestedBlockIds = Array.isArray(body.blockIds)
          ? body.blockIds.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
          : [];
        const blockId = requiredEditorString(body.blockId, "blockId");
        const blockIds = scope === "document"
          ? []
          : [...new Set(requestedBlockIds.length ? requestedBlockIds : blockId ? [blockId] : [])];
        const originalFingerprint = requiredEditorString(body.originalFingerprint, "originalFingerprint");
        const instruction = requiredEditorString(body.instruction, "instruction");
        const documentVersion = positiveEditorVersion(body.documentVersion);
        const rangeStart = integerEditorOffset(body.rangeStart);
        const rangeEnd = integerEditorOffset(body.rangeEnd);
        const originalText = typeof body.originalText === "string" ? body.originalText : undefined;
        if (((scope === "blocks" || scope === "text") && !blockIds.length) ||
          (scope === "text" && (rangeStart === undefined || rangeEnd === undefined || !originalText)) ||
          !instruction || !documentVersion) {
          return sendJson(response, 422, {
            error: "scope, documentVersion, and instruction are required; blocks scope needs blockIds",
          });
        }

        const document = reportDocuments.getOrCreate(task.id, task.output);
        const commonInput = {
          taskId: task.id,
          scope,
          blockIds,
          documentVersion,
          originalFingerprint,
          ...(scope === "text" ? { rangeStart, rangeEnd, originalText } : {}),
          instruction,
          ...(typeof body.conversationId === "string" && body.conversationId.trim()
            ? { conversationId: body.conversationId.trim() }
            : {}),
        };
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.on("close", abort);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        try {
          writeSse(response, "status", { message: "正在理解问题" });
          const plan = await reportEditor.planMessage(commonInput);
          if (plan.intent === "edit" || plan.intent === "edit_with_research") {
            writeSse(response, "fallback", {});
            response.end();
            return;
          }

          let sources: ReturnType<ReportEditorService["recordSearch"]>["results"] | undefined;
          if (plan.intent === "research") {
            writeSse(response, "status", { message: "正在检索资料" });
            const catalog = settings
              ? await loadRetrieverCatalog(settings, researcherServiceUrl(), capabilityProvider)
              : undefined;
            const retrievers = catalog
              ? catalog.retrievers.slice(0, catalog.maxRetrievers).map((item) => item.id)
              : ["duckduckgo"];
            const researched = await researchReportSources(researcherServiceUrl(), {
              query: plan.query ?? (plan.urls.length ? undefined : instruction),
              urls: plan.urls,
              retrievers,
              limit: 5,
            });
            const recorded = reportEditor.recordSearch({
              taskId: task.id,
              scopeKey: scope === "document" ? "document" : blockIds.join(","),
              query: plan.query ?? instruction,
              retrievers,
              results: researched.sources,
            });
            const readableIds = recorded.results
              .filter((source) => source.fetchStatus === "fetched")
              .map((source) => source.id);
            reportEditor.selectSearchResults(task.id, recorded.session.id, readableIds);
            sources = recorded.results;
          }

          for await (const event of reportEditor.streamAnswerMessage({
            ...commonInput,
            ...(plan.intent === "clarify" && plan.reply ? { fixedReply: plan.reply } : {}),
            ...(sources ? { sources } : {}),
            signal: controller.signal,
          })) {
            if (event.type === "delta") writeSse(response, "delta", { content: event.content });
            else writeSse(response, "done", {
              conversationId: event.conversation.id,
              documentVersion: event.document.version,
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            writeSse(response, "error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          response.off("close", abort);
          if (!response.writableEnded) response.end();
        }
        return;
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-document" &&
        segments[4] === "restore" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report versions are only available after completion" });
        }
        const body = await readJsonBody(request);
        const version = positiveEditorVersion(body.version);
        const documentVersion = positiveEditorVersion(body.documentVersion);
        if (!version || !documentVersion) return sendJson(response, 422, { error: "version and documentVersion are required" });
        reportDocuments.getOrCreate(task.id, task.output!);
        try {
          const result = reportEditor.restoreVersion({
            taskId: task.id,
            version,
            expectedVersion: documentVersion,
          });
          return sendJson(response, 201, {
            ...result,
            audit: reportEditor.audit(task.id, reportEditorSources(task)),
          });
        } catch (error) {
          if (error instanceof ReportDocumentConflictError) {
            return sendJson(response, 409, { error: error.message, document: reportDocuments.get(task.id) });
          }
          return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (
        request.method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "conversations" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const blockId = url.searchParams.get("blockId")?.trim() || undefined;
        return sendJson(response, 200, {
          conversations: reportEditor.conversations(task.id, blockId),
          operations: reportEditor.operations(task.id, blockId),
        });
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "search" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const body = await readJsonBody(request);
        const query = requiredEditorString(body.query, "query");
        const scopeKey = requiredEditorString(body.scopeKey, "scopeKey") ?? "document";
        if (!query || query.length > 4_000 || scopeKey.length > 4_000) {
          return sendJson(response, 422, { error: "query and scopeKey are required" });
        }
        const catalog = settings
          ? await loadRetrieverCatalog(settings, researcherServiceUrl(), capabilityProvider)
          : undefined;
        const retrievers = catalog
          ? catalog.retrievers.slice(0, catalog.maxRetrievers).map((item) => item.id)
          : ["duckduckgo"];
        try {
          const results = await searchReportSources(researcherServiceUrl(), {
            query,
            retrievers,
            limit: 8,
          });
          return sendJson(response, 201, reportEditor.recordSearch({
            taskId: task.id,
            scopeKey,
            query,
            retrievers,
            results: results.results,
          }));
        } catch (error) {
          return sendJson(response, 502, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "search" &&
        segments[5] &&
        segments[6] === "select" &&
        segments.length === 7
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const body = await readJsonBody(request);
        const resultIds = Array.isArray(body.resultIds)
          ? body.resultIds.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
          : [];
        return sendJson(response, 200, {
          results: reportEditor.selectSearchResults(task.id, segments[5], resultIds),
        });
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "messages" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const body = await readJsonBody(request);
        const scope: "document" | "text" | "blocks" = body.scope === "document"
          ? "document"
          : body.scope === "text" ? "text" : "blocks";
        const requestedBlockIds = Array.isArray(body.blockIds)
          ? body.blockIds.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
          : [];
        const blockId = requiredEditorString(body.blockId, "blockId");
        const blockIds = scope === "document"
          ? []
          : [...new Set(requestedBlockIds.length ? requestedBlockIds : blockId ? [blockId] : [])];
        const originalFingerprint = requiredEditorString(body.originalFingerprint, "originalFingerprint");
        const instruction = requiredEditorString(body.instruction, "instruction");
        const documentVersion = positiveEditorVersion(body.documentVersion);
        const rangeStart = integerEditorOffset(body.rangeStart);
        const rangeEnd = integerEditorOffset(body.rangeEnd);
        const originalText = typeof body.originalText === "string" ? body.originalText : undefined;
        const sourceIds = Array.isArray(body.sourceIds)
          ? body.sourceIds.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
          : [];
        if (((scope === "blocks" || scope === "text") && !blockIds.length) ||
          (scope === "text" && (rangeStart === undefined || rangeEnd === undefined || !originalText)) ||
          !instruction || !documentVersion) {
          return sendJson(response, 422, {
            error: "scope, documentVersion, and instruction are required; blocks scope needs blockIds",
          });
        }
        const document = reportDocuments.getOrCreate(task.id, task.output!);
        try {
          const commonInput = {
            taskId: task.id,
            scope,
            blockIds,
            documentVersion,
            originalFingerprint,
            ...(scope === "text" ? { rangeStart, rangeEnd, originalText } : {}),
            instruction,
            ...(typeof body.conversationId === "string" && body.conversationId.trim()
              ? { conversationId: body.conversationId.trim() }
              : {}),
          };
          const plan = await reportEditor.planMessage(commonInput);
          const targetedBlockIds = scope === "document"
            ? contiguousTargetBlockIds(document, plan.targetBlockIds)
            : [];
          const editInput = targetedBlockIds.length
            ? {
                ...commonInput,
                scope: "blocks" as const,
                blockIds: targetedBlockIds,
                originalFingerprint: undefined,
              }
            : commonInput;
          if (plan.intent === "chat" || plan.intent === "clarify") {
            const result = await reportEditor.answerMessage({
              ...commonInput,
              ...(plan.intent === "clarify" && plan.reply ? { fixedReply: plan.reply } : {}),
            });
            return sendJson(response, 201, {
              kind: "reply",
              intent: plan.intent,
              ...result,
              audit: reportEditor.audit(task.id, reportEditorSources(task)),
            });
          }

          let automaticSources: ReturnType<ReportEditorService["recordSearch"]> | undefined;
          if (plan.intent === "research" || plan.intent === "edit_with_research") {
            const catalog = settings
              ? await loadRetrieverCatalog(settings, researcherServiceUrl(), capabilityProvider)
              : undefined;
            const retrievers = catalog
              ? catalog.retrievers.slice(0, catalog.maxRetrievers).map((item) => item.id)
              : ["duckduckgo"];
            const researched = await researchReportSources(researcherServiceUrl(), {
              query: plan.query ?? (plan.urls.length ? undefined : instruction),
              urls: plan.urls,
              retrievers,
              limit: 5,
            });
            automaticSources = reportEditor.recordSearch({
              taskId: task.id,
              scopeKey: editInput.scope === "document" ? "document" : editInput.blockIds.join(","),
              query: plan.query ?? instruction,
              retrievers,
              results: researched.sources,
            });
            const readableIds = automaticSources.results
              .filter((source) => source.fetchStatus === "fetched")
              .map((source) => source.id);
            reportEditor.selectSearchResults(task.id, automaticSources.session.id, readableIds);
          }

          if (plan.intent === "research") {
            const result = await reportEditor.answerMessage({
              ...commonInput,
              sources: automaticSources?.results,
            });
            return sendJson(response, 201, {
              kind: "reply",
              intent: plan.intent,
              ...result,
              sources: automaticSources?.results ?? [],
              audit: reportEditor.audit(task.id, reportEditorSources(task)),
            });
          }

          if (
            plan.intent === "edit_with_research" &&
            !automaticSources?.results.some((source) => source.fetchStatus === "fetched")
          ) {
            const result = await reportEditor.answerMessage({
              ...commonInput,
              fixedReply: "我没有成功读取到可用的网页正文，因此没有生成修改，原报告保持不变。你可以提供一个可公开访问的链接，或稍后重试。",
              sources: automaticSources?.results,
            });
            return sendJson(response, 201, {
              kind: "reply",
              intent: "clarify",
              ...result,
              sources: automaticSources?.results ?? [],
              audit: reportEditor.audit(task.id, reportEditorSources(task)),
            });
          }

          const result = await reportEditor.propose({
            ...editInput,
            instruction: plan.editInstruction ?? instruction,
            ...(automaticSources
              ? { sourceIds: automaticSources.results.filter((item) => item.fetchStatus === "fetched").map((item) => item.id) }
              : sourceIds.length ? { sourceIds: [...new Set(sourceIds)] } : {}),
          });
          return sendJson(response, 201, {
            kind: "proposal",
            intent: plan.intent,
            ...result,
            sources: automaticSources?.results ?? [],
            audit: reportEditor.audit(task.id, reportEditorSources(task)),
          });
        } catch (error) {
          if (error instanceof ReportDocumentConflictError) {
            return sendJson(response, 409, { error: error.message, document });
          }
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "manual-save" &&
        segments.length === 5
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        const body = await readJsonBody(request, REPORT_EDITOR_BODY_BYTES);
        const scope = body.scope === "document"
          ? "document"
          : body.scope === "text" ? "text" : "blocks";
        const requestedBlockIds = Array.isArray(body.blockIds)
          ? body.blockIds.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim())
          : [];
        const documentVersion = positiveEditorVersion(body.documentVersion);
        const replacementMarkdown = typeof body.replacementMarkdown === "string"
          ? body.replacementMarkdown
          : undefined;
        const rangeStart = integerEditorOffset(body.rangeStart);
        const rangeEnd = integerEditorOffset(body.rangeEnd);
        const originalText = typeof body.originalText === "string" ? body.originalText : undefined;
        if (((scope === "blocks" || scope === "text") && !requestedBlockIds.length) ||
          (scope === "text" && (rangeStart === undefined || rangeEnd === undefined || !originalText)) ||
          !documentVersion || replacementMarkdown === undefined) {
          return sendJson(response, 422, {
            error: "scope, documentVersion, replacementMarkdown, and blockIds for block scope are required",
          });
        }
        reportDocuments.getOrCreate(task.id, task.output!);
        try {
          const result = reportEditor.saveManual({
            taskId: task.id,
            scope,
            blockIds: scope === "document" ? [] : [...new Set(requestedBlockIds)],
            documentVersion,
            originalFingerprint: requiredEditorString(body.originalFingerprint, "originalFingerprint"),
            ...(scope === "text" ? { rangeStart, rangeEnd, originalText } : {}),
            replacementMarkdown,
          });
          return sendJson(response, 201, {
            ...result,
            audit: reportEditor.audit(task.id, reportEditorSources(task)),
          });
        } catch (error) {
          if (error instanceof ReportDocumentConflictError) {
            return sendJson(response, 409, {
              error: error.message,
              document: reportDocuments.get(task.id),
            });
          }
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "report-editor" &&
        segments[4] === "operations" &&
        segments[5] &&
        ["apply", "reject", "undo"].includes(segments[6] ?? "") &&
        segments.length === 7
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!isCompletedReportTask(task)) {
          return sendJson(response, 409, { error: "report editor is only available after completion" });
        }
        reportDocuments.getOrCreate(task.id, task.output!);
        try {
          if (segments[6] === "apply") {
            const result = reportEditor.apply(task.id, segments[5]);
            return sendJson(response, 200, {
              ...result,
              audit: reportEditor.audit(task.id, reportEditorSources(task)),
            });
          }
          if (segments[6] === "reject") {
            return sendJson(response, 200, {
              operation: reportEditor.reject(task.id, segments[5]),
            });
          }
          const result = reportEditor.undo(task.id, segments[5]);
          return sendJson(response, 200, {
            ...result,
            audit: reportEditor.audit(task.id, reportEditorSources(task)),
          });
        } catch (error) {
          if (error instanceof ReportDocumentConflictError) {
            return sendJson(response, 409, {
              error: error.message,
              document: reportDocuments.get(task.id),
            });
          }
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        request.method === "DELETE" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments.length === 3
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!["completed", "completed_with_warnings", "failed", "canceled"].includes(task.status)) {
          return sendJson(response, 409, {
            error: "only completed, failed, or canceled tasks can be deleted",
          });
        }
        await documents.deleteTask(task.id);
        reportEditor.deleteTask(task.id);
        reportDocuments.delete(task.id);
        const result = manager.delete(task.id);
        if (result !== "deleted") {
          return sendJson(response, 404, { error: "task not found" });
        }
        response.writeHead(204);
        response.end();
        return;
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "documents" &&
        segments.length === 4
      ) {
        const body = await readJsonBody(request, 26 * 1024 * 1024 * 2);
        if (typeof body.name !== "string" || typeof body.contentBase64 !== "string") return sendJson(response, 422, { error: "name and contentBase64 are required" });
        try {
          return sendJson(response, 201, await documents.save(segments[2], body.name, Buffer.from(body.contentBase64, "base64")));
        } catch (error) {
          return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "tasks" && segments[2] &&
        segments[3] === "documents" && segments.length === 4
      ) {
        return sendJson(response, 200, await documents.list(segments[2]));
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "tasks" && segments[2] &&
        segments[3] === "start" && segments.length === 4
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (!manager.start(segments[2])) return sendJson(response, 409, { error: "task is not queued" });
        return sendJson(response, 202, manager.get(segments[2]));
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "retry" &&
        segments.length === 4
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        if (![
          "failed",
          "canceled",
        ].includes(task.status)) {
          return sendJson(response, 409, {
            error: "only failed or canceled tasks can be restarted",
          });
        }

        const retryTaskId = randomUUID();
        try {
          const documentIds = await documents.copyTask(task.id, retryTaskId);
          const researchProfile = task.researchProfile
            ? remapRetryDocumentIds(task.researchProfile, documentIds)
            : undefined;
          const retry = manager.submit(task.topic, {
            taskId: retryTaskId,
            ...(researchProfile === undefined ? {} : { researchProfile }),
            ...(task.researchCapabilities === undefined
              ? {}
              : { researchCapabilities: task.researchCapabilities }),
          });
          return sendJson(response, 202, retry);
        } catch (error) {
          await documents.deleteTask(retryTaskId);
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "resume" && segments.length === 4
      ) {
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        try {
          assertCurrentCheckpointCompatibility(manager, task.id, settings);
        } catch (error) {
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!manager.resume(task.id)) {
          return sendJson(response, 409, {
            error: "task is not recoverable",
          });
        }
        return sendJson(response, 202, manager.get(task.id));
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "rerun" && segments.length === 4
      ) {
        const body = await readJsonBody(request);
        const fromStep = validStepId(body.fromStep);
        if (!fromStep) {
          return sendJson(response, 422, { error: "fromStep is required" });
        }
        const task = manager.get(segments[2]);
        if (!task) return sendJson(response, 404, { error: "task not found" });
        try {
          assertCurrentCheckpointCompatibility(manager, task.id, settings);
        } catch (error) {
          return sendJson(response, 422, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!manager.rerun(task.id, fromStep)) {
          return sendJson(response, 409, {
            error: "task cannot be rerun from this step",
          });
        }
        return sendJson(response, 202, manager.get(task.id));
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "input" &&
        segments.length === 4
      ) {
        const body = await readJsonBody(request);
        const answer = typeof body.answer === "string" ? body.answer : "";
        const requestId = typeof body.requestId === "string"
          ? body.requestId.trim()
          : "";
        if (!answer.trim()) {
          return sendJson(response, 422, {
            error: "answer must be a non-empty string",
          });
        }
        if (!requestId) {
          return sendJson(response, 422, {
            error: "requestId is required",
          });
        }
        const task = manager.get(segments[2]);
        if (!task) {
          return sendJson(response, 404, { error: "task not found" });
        }
        if (task.status !== "needs_input" ||
            task.pendingInput?.requestId !== requestId) {
          return sendJson(response, 409, {
            error: "task is not waiting for input",
          });
        }
        if (task.pendingInput.kind === "approval" &&
            answer.trim() !== "approved" && answer.trim() !== "declined") {
          return sendJson(response, 422, {
            error: "approval answer must be approved or declined",
          });
        }
        if (!manager.answerInput(segments[2], answer, requestId)) {
          return sendJson(response, 409, {
            error: "task is not waiting for input",
          });
        }
        return sendJson(response, 202, manager.get(segments[2]));
      }

      if (
        request.method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "cancel" &&
        segments.length === 4
      ) {
        const task = manager.get(segments[2]);
        if (!task) {
          return sendJson(response, 404, { error: "task not found" });
        }
        if (!manager.cancel(segments[2])) {
          return sendJson(response, 409, {
            error: "task is already in a terminal state",
          });
        }
        return sendJson(response, 202, manager.get(segments[2]));
      }

      if (
        request.method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "tasks" &&
        segments[2]
      ) {
        const taskId = segments[2];
        const task = manager.get(taskId);
        if (!task) {
          return sendJson(response, 404, { error: "task not found" });
        }

        if (segments.length === 3) {
          return sendJson(response, 200, enrichLegacyWorkflowPlan(task));
        }
        if (segments.length === 4 && segments[3] === "events") {
          return streamEvents(
            response,
            manager,
            taskId,
            task.status,
            request.headers["last-event-id"],
          );
        }
        if (segments.length === 4 && segments[3] === "diagnostics") {
          return sendJson(response, 200, {
            diagnostics: manager.diagnostics(taskId).flatMap((diagnostic) => {
              const message = diagnosticMessage(diagnostic.data.message);
              return message ? [{
                id: diagnostic.id,
                timestamp: diagnostic.timestamp,
                stage: diagnostic.rawStage,
                message,
              }] : [];
            }),
          });
        }
        const exportFormat = segments[4];
        if (
          segments.length === 5 &&
          segments[3] === "export" &&
          exportFormat &&
          ["markdown", "docx", "pdf"].includes(exportFormat)
        ) {
          if (
            !task.output ||
            !["completed", "completed_with_warnings"].includes(task.status)
          ) {
            return sendJson(response, 409, {
              error: "report is not ready for export",
            });
          }
          const currentDocument = reportDocuments.get(task.id);
          return proxyReportExport(
            response,
            researcherServiceUrl(),
            exportFormat,
            {
              ...task,
              output: currentDocument?.currentMarkdown ?? task.output,
              reportVersion: currentDocument?.version,
            },
          );
        }
      }

      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(response, 400, { error: message });
    }
  });
}

async function loadRetrieverCatalog(
  settings: RuntimeSettingsStore,
  serviceUrl: string,
  provider: ResearchCapabilityProvider,
): Promise<RetrieverCatalog> {
  const timeoutMs = settings.getRuntimeSettings().gptrHealthTimeoutMs;
  return provider.getCatalog(serviceUrl, timeoutMs);
}

function diagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value
    .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu, "$1: [redacted]")
    .replace(/\bsk-[a-z0-9_-]+/giu, "[redacted]")
    .trim()
    .slice(0, 600);
}

async function searchReportSources(
  serviceUrl: string,
  input: { query: string; retrievers: string[]; limit: number },
): Promise<{ results: Array<{ provider: string; title: string; url: string; snippet?: string }> }> {
  const response = await fetch(new URL("/search", serviceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(35_000),
  });
  const payload = await response.json() as { detail?: unknown; results?: unknown };
  if (!response.ok) {
    throw new Error(typeof payload.detail === "string" ? payload.detail : `search returned ${response.status}`);
  }
  if (!Array.isArray(payload.results)) throw new Error("search returned an invalid result list");
  const results = payload.results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.provider !== "string" || typeof item.title !== "string" || typeof item.url !== "string") return [];
    return [{
      provider: item.provider,
      title: item.title,
      url: item.url,
      ...(typeof item.snippet === "string" ? { snippet: item.snippet } : {}),
    }];
  });
  return { results };
}

async function researchReportSources(
  serviceUrl: string,
  input: { query?: string; urls: string[]; retrievers: string[]; limit: number },
): Promise<{
  sources: Array<{
    provider: string;
    title: string;
    url: string;
    snippet?: string;
    content?: string;
    fetchStatus: "fetched" | "failed";
    fetchError?: string;
  }>;
}> {
  const response = await fetch(new URL("/editor/research", serviceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.json() as { detail?: unknown; sources?: unknown };
  if (!response.ok) {
    throw new Error(typeof payload.detail === "string" ? payload.detail : `source research returned ${response.status}`);
  }
  if (!Array.isArray(payload.sources)) throw new Error("source research returned an invalid source list");
  const sources = payload.sources.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.provider !== "string" ||
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
      (item.fetchStatus !== "fetched" && item.fetchStatus !== "failed")
    ) return [];
    const fetchStatus = item.fetchStatus as "fetched" | "failed";
    return [{
      provider: item.provider,
      title: item.title,
      url: item.url,
      ...(typeof item.snippet === "string" ? { snippet: item.snippet } : {}),
      ...(typeof item.content === "string" ? { content: item.content } : {}),
      fetchStatus,
      ...(typeof item.fetchError === "string" ? { fetchError: item.fetchError } : {}),
    }];
  });
  return { sources };
}

function rebaseResearchProfilePath(path: string): string {
  return path === "$"
    ? "$.researchProfile"
    : `$.researchProfile${path.slice(1)}`;
}

function remapRetryDocumentIds(
  profile: ResearchProfile,
  documentIds: ReadonlyMap<string, string>,
): ResearchProfile {
  const source = profile.source;
  if (source.mode !== "local" && source.mode !== "hybrid") return profile;
  const remappedIds = source.documentIds.map((documentId) => {
    const copiedId = documentIds.get(documentId);
    if (!copiedId) throw new Error("本地文档未能复制，无法重新发起研究。");
    return copiedId;
  });
  return {
    ...profile,
    source: { ...source, documentIds: remappedIds },
  };
}

function enrichLegacyWorkflowPlan<T extends {
  workflowPath?: string;
  workflowPlan?: { steps: Array<{ id: string; task: string }> };
}>(task: T): T {
  if (!task.workflowPlan || task.workflowPlan.steps.every((step) => typeof step.task === "string" && step.task.trim())) return task;
  if (!task.workflowPath) return task;
  const workflowRoot = resolve(".think-tank", "workflows");
  const workflowPath = resolve(task.workflowPath);
  const candidate = relative(workflowRoot, workflowPath);
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) return task;
  try {
    const tasksById = new Map(parseWorkflow(workflowPath).steps.map((step) => [step.id, step.task.trim()]));
    return {
      ...task,
      workflowPlan: {
        ...task.workflowPlan,
        steps: task.workflowPlan.steps.map((step) => ({
          ...step,
          task: step.task || tasksById.get(step.id) || "",
        })),
      },
    };
  } catch {
    return task;
  }
}

function contiguousTargetBlockIds(
  document: { blocks: Array<{ id: string }> },
  requested: string[],
): string[] {
  if (!requested.length) return [];
  const indexes = [...new Set(requested.flatMap((id) => {
    const index = document.blocks.findIndex((block) => block.id === id);
    return index < 0 ? [] : [index];
  }))].sort((left, right) => left - right);
  if (!indexes.length || indexes.some((value, index) => index > 0 && value !== indexes[index - 1]! + 1)) {
    return [];
  }
  return indexes.map((index) => document.blocks[index]!.id);
}

export async function inspectRuntimeReadiness(
  settings?: RuntimeSettingsStore,
  researcherServiceUrl = "http://127.0.0.1:8010",
): Promise<{
  status: "ready" | "not_ready";
  checks: {
    configuration: "ok" | "invalid";
    taskStore: "ok";
    researcher: "ok" | "unavailable";
  };
  error?: string;
}> {
  let timeoutMs = 5_000;
  try {
    timeoutMs = settings?.getRuntimeSettings().gptrHealthTimeoutMs ?? timeoutMs;
  } catch (error) {
    return {
      status: "not_ready",
      checks: {
        configuration: "invalid",
        taskStore: "ok",
        researcher: "unavailable",
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const response = await fetch(
      new URL("/ready", researcherServiceUrl),
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) {
      throw new Error(`GPT Researcher readiness returned ${response.status}`);
    }
    return {
      status: "ready",
      checks: {
        configuration: "ok",
        taskStore: "ok",
        researcher: "ok",
      },
    };
  } catch (error) {
    return {
      status: "not_ready",
      checks: {
        configuration: "ok",
        taskStore: "ok",
        researcher: "unavailable",
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function proxyReportExport(
  response: ServerResponse,
  serviceUrl: string,
  exportFormat: string,
  task: { id: string; topic: string; output?: string; reportVersion?: number },
): Promise<void> {
  const upstream = await fetch(
    `${serviceUrl.replace(/\/+$/u, "")}/export/${exportFormat}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        title: task.topic,
        markdown: task.output,
      }),
    },
  );
  if (!upstream.ok) {
    const detail = await upstream.text();
    return sendJson(response, 502, {
      error: `report export service failed: ${detail}`,
    });
  }

  response.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ??
      "application/octet-stream",
    "Content-Disposition": reportExportContentDisposition(
      task.reportVersion,
      exportFormat,
    ),
    "Cache-Control": "no-store",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

function reportExportContentDisposition(
  version: number | undefined,
  format: string,
): string {
  const documentVersion = version && version > 0 ? version : 1;
  const extension = format === "markdown" ? "md" : format;
  const timestamp = exportFilenameTimestamp();
  const filename = `研究报告_v${documentVersion}_${timestamp}.${extension}`;
  const fallback = `research-report-v${documentVersion}.${extension}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function exportFilenameTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

async function readWebAsset(
  root: string,
  pathname: string,
): Promise<{ file: string; content: Buffer } | undefined> {
  let file: string;
  try {
    file = pathname === "/"
      ? "index.html"
      : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
  if (!file || file.includes("\0")) return undefined;
  const resolved = resolve(root, file);
  const fromRoot = relative(root, resolved);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  try {
    return { file, content: await readFile(resolved) };
  } catch {
    if (!extname(file) && !file.startsWith("api/")) {
      try {
        return { file: "index.html", content: await readFile(resolve(root, "index.html")) };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function contentTypeFor(file: string): string {
  const extension = extname(file).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  }[extension] ?? "application/octet-stream";
}

function streamEvents(
  response: ServerResponse,
  manager: ResearchTaskManager,
  taskId: string,
  initialStatus: string,
  lastEventIdHeader: string | string[] | undefined,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.flushHeaders();

  let terminal = initialStatus === "completed" ||
    initialStatus === "completed_with_warnings" ||
    initialStatus === "failed" ||
    initialStatus === "canceled";
  const lastEventIdValue = Array.isArray(lastEventIdHeader)
    ? lastEventIdHeader.at(-1)
    : lastEventIdHeader;
  const parsedLastEventId = Number(lastEventIdValue ?? "0");
  const lastEventId = Number.isSafeInteger(parsedLastEventId) &&
      parsedLastEventId >= 0
    ? parsedLastEventId
    : 0;
  let unsubscribe: (() => void) | undefined;
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": keepalive\n\n");
    }
  }, 15_000);
  keepAlive.unref();
  const close = () => {
    clearInterval(keepAlive);
    unsubscribe?.();
    if (!response.writableEnded) response.end();
  };
  const write = (event: ResearchTaskEvent) => {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (
      event.type === "task.completed" ||
      event.type === "task.completed_with_warnings" ||
      event.type === "task.failed" ||
      event.type === "task.canceled"
    ) {
      terminal = true;
      queueMicrotask(() => {
        close();
      });
    }
  };
  unsubscribe = manager.subscribe(taskId, write, lastEventId);

  if (terminal) {
    close();
    return;
  }

  response.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe?.();
  });
}

async function readJsonBody(
  request: NodeJS.ReadableStream,
  maximumBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}") as Record<string, unknown>;
}

function optionalApiKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error("API Key must be a string.");
  }
  if (value.length > 8_192) {
    throw new Error("API Key is too long.");
  }
  return value;
}

function requiredEditorString(value: unknown, _field: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function positiveEditorVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function integerEditorOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function reportEditorSources(task: { citations?: Array<{ id?: string | number; title: string; url: string }> }) {
  return (task.citations ?? []).map((citation, index) => ({
    ...citation,
    referenceId: citation.id ?? index + 1,
  }));
}

function isCompletedReportTask(task: { status: string; output?: string }): task is { status: "completed" | "completed_with_warnings"; output: string } {
  return Boolean(task.output) && ["completed", "completed_with_warnings"].includes(task.status);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeSse(response: ServerResponse, event: string, body: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

function validStepId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 120 ? normalized : undefined;
}

function assertCurrentCheckpointCompatibility(
  manager: ResearchTaskManager,
  taskId: string,
  settings: RuntimeSettingsStore | undefined,
): void {
  const checkpoint = manager.checkpoint(taskId);
  if (!checkpoint) {
    throw new Error("此任务没有可用的恢复检查点。");
  }
  const task = manager.get(taskId);
  if (!settings || !task?.researchProfile || !task.researchCapabilities) return;
  const runtime = settings.getRuntimeSettings();
  assertCheckpointCompatible(
    checkpoint,
    checkpointRuntimeFingerprint(runtime),
    checkpointPolicyFingerprint(
      task.researchProfile,
      task.researchCapabilities,
    ),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (!process.stdout.isTTY) {
    process.stdout.write("\uFEFF");
  }
  if (!process.stderr.isTTY) {
    process.stderr.write("\uFEFF");
  }
  const settings = new RuntimeSettingsStore(
    process.env,
    resolve(".think-tank", "settings.json"),
  );
  const initialSettings = settings.getRuntimeSettings();
  const taskStore = new SqliteResearchTaskStore(
    resolve(".think-tank", "data", "think-tank.sqlite"),
  );
  const reportDatabasePath = resolve(".think-tank", "data", "think-tank.sqlite");
  const reportDatabase = new DatabaseSync(reportDatabasePath);
  const reportDocuments = new SqliteReportDocumentStore(reportDatabasePath, reportDatabase);
  const reportEditor = new ReportEditorService(
    reportDocuments,
    new SqliteReportEditorStore(reportDatabasePath, reportDatabase),
    new OpenAIReportEditorModel(settings.getRuntimeSettings().planner),
    new SqliteReportTransactionRunner(reportDatabase),
  );
  const manager = new ResearchTaskManager(
    (topic, onEvent, controls) =>
      runResearchTopic(topic, {
        taskId: controls.taskId,
        onEvent,
        requestInput: controls.requestInput,
        signal: controls.signal,
        settings: settings.getRuntimeSettings(),
        researchProfile: controls.researchProfile,
        researchCapabilities: controls.researchCapabilities,
        execution: controls.execution,
        saveCheckpoint: controls.saveCheckpoint,
      }),
    taskStore,
    {
      executionTimeoutMs: initialSettings.taskExecutionTimeoutMs,
    },
  );
  const port = Number(process.env.API_PORT ?? "3000");
  const host = process.env.API_HOST?.trim() || "127.0.0.1";
  const server = createApiServer(
    manager,
    settings,
    () => settings.getRuntimeSettings().gptrServiceUrl,
    undefined,
    undefined,
    reportDocuments,
    reportEditor,
  );
  server.listen(port, host, async () => {
    process.stdout.write(`Think Tank API 已启动：http://${host}:${port}\n`);
    let readiness = await inspectRuntimeReadiness(
      settings,
      settings.getRuntimeSettings().gptrServiceUrl,
    );
    for (
      let attempt = 1;
      readiness.status !== "ready" && attempt < 5;
      attempt += 1
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      readiness = await inspectRuntimeReadiness(
        settings,
        settings.getRuntimeSettings().gptrServiceUrl,
      );
    }
    if (readiness.status === "ready") {
      process.stdout.write("启动自检通过：任务存储与 GPTR 已就绪。\n");
    } else {
      process.stderr.write(`启动自检未通过：${readiness.error}\n`);
    }
  });
}
