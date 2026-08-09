import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
import { TaskDocumentStore } from "./document-store.js";

const MAX_BODY_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const markdownItRoot = resolve(
  dirname(require.resolve("markdown-it/package.json")),
  "dist",
);
const webRoots = process.env.WEB_ROOT
  ? [resolve(process.env.WEB_ROOT)]
  : [
      resolve(moduleDirectory, "../../web/public"),
      resolve(moduleDirectory, "../../../web/public"),
    ];
const staticAssets = new Map([
  [
    "/",
    {
      file: "index.html",
      type: "text/html; charset=utf-8",
      roots: webRoots,
    },
  ],
  [
    "/styles.css",
    {
      file: "styles.css",
      type: "text/css; charset=utf-8",
      roots: webRoots,
    },
  ],
  [
    "/app.js",
    {
      file: "app.js",
      type: "text/javascript; charset=utf-8",
      roots: webRoots,
    },
  ],
  [
    "/assets/ai-think-tank-logo.png",
    {
      file: "assets/ai-think-tank-logo.png",
      type: "image/png",
      roots: webRoots,
    },
  ],
  [
    "/favicon.ico",
    {
      file: "assets/favicon.ico",
      type: "image/x-icon",
      roots: webRoots,
    },
  ],
  [
    "/assets/favicon-16x16.png",
    {
      file: "assets/favicon-16x16.png",
      type: "image/png",
      roots: webRoots,
    },
  ],
  [
    "/assets/favicon-32x32.png",
    {
      file: "assets/favicon-32x32.png",
      type: "image/png",
      roots: webRoots,
    },
  ],
  [
    "/assets/apple-touch-icon.png",
    {
      file: "assets/apple-touch-icon.png",
      type: "image/png",
      roots: webRoots,
    },
  ],
  [
    "/vendor/markdown-it.min.js",
    {
      file: "markdown-it.min.js",
      type: "text/javascript; charset=utf-8",
      roots: [markdownItRoot],
    },
  ],
]);

export function createApiServer(
  manager: ResearchTaskManager,
  settings?: RuntimeSettingsStore,
  researcherServiceUrl: () => string = () => "http://127.0.0.1:8010",
  capabilityProvider: ResearchCapabilityProvider =
    new CachedResearchCapabilityProvider(
      new HttpResearchCapabilityProvider(),
    ),
  environmentFilePath = resolve(moduleDirectory, "../../../.env"),
) {
  const documents = new TaskDocumentStore();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);

      const asset = staticAssets.get(url.pathname);
      if (request.method === "GET" && asset) {
        const content = await readStaticAsset(asset.file, asset.roots);
        response.writeHead(200, {
          "Content-Type": asset.type,
          "Cache-Control": "no-cache",
        });
        response.end(content);
        return;
      }

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
          return sendJson(response, 200, task);
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
          return proxyReportExport(
            response,
            researcherServiceUrl(),
            exportFormat,
            task,
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

function rebaseResearchProfilePath(path: string): string {
  return path === "$"
    ? "$.researchProfile"
    : `$.researchProfile${path.slice(1)}`;
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
  task: { id: string; topic: string; output?: string },
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
    "Content-Disposition": upstream.headers.get("content-disposition") ??
      `attachment; filename="think-tank-report.${exportFormat}"`,
    "Cache-Control": "no-store",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function readStaticAsset(
  file: string,
  roots: readonly string[],
): Promise<Buffer> {
  let lastError: unknown;
  for (const root of roots) {
    try {
      return await readFile(resolve(root, file));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
