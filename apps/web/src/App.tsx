import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Popover, Tooltip } from "antd";
import { Sender } from "@ant-design/x";
import { HistoryOutlined, LinkOutlined, LoginOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import {
  createResearchTask,
  getResearchTask,
  getResearchTopicRecommendations,
  uploadResearchDocument,
  type ResearchTopicRecommendation,
} from "./services/api-client";
import { HistoryDrawer } from "./components/history-drawer/HistoryDrawer";
import { ResearchSourcePopover, sourceLabels, type ResearchSourceConfig } from "./components/research-source/ResearchSourcePopover";
import { ResearchLaunch, type ResearchLaunchStage } from "./components/research-launch/ResearchLaunch";
import { SettingsDrawer } from "./components/settings-drawer/SettingsDrawer";
import { BrandLockup } from "./components/brand/BrandLockup";
import { ReportSessionLoading } from "./components/report-session/ReportSessionLoading";
import { preloadReportSession } from "./services/report-api";
import { AUTH_REQUIRED_EVENT, AuthRequiredError, getAuthStatus, login, logout, type AuthStatus } from "./services/auth-client";
import { LoginModal, type LoginValues } from "./components/auth/LoginModal";

const ResearchWorkspace = lazy(() => import("./components/research-workspace/ResearchWorkspace").then((module) => ({ default: module.ResearchWorkspace })));
const loadReportSessionModule = () => import("./components/report-session/ReportSession");
const ReportSession = lazy(() => loadReportSessionModule().then((module) => ({ default: module.ReportSession })));
const RECOMMENDATIONS_PER_BATCH = 4;

type SessionState =
  | { phase: "idle" }
  | { phase: "starting"; topic: string; stage: Exclude<ResearchLaunchStage, "opening"> }
  | { phase: "start_failed"; topic: string; error: string }
  | { phase: "researching"; topic: string; taskId: string; view: "workspace" | "report" };

const defaultSource: ResearchSourceConfig = {
  kind: "web",
  urls: "",
  files: [],
  includeDomains: "",
  excludeDomains: "",
};

function listValues(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))];
}

function validateUrls(urls: string[]): void {
  if (urls.length < 1) throw new Error("请至少填写一个指定 URL。");
  if (urls.length > 50) throw new Error("指定 URL 最多填写 50 个。");
  for (const value of urls) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`指定 URL 格式无效：${value}`); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`指定 URL 只支持 HTTP(S)：${value}`);
  }
}

function validateSource(source: ResearchSourceConfig): void {
  if (["urls", "urls_web"].includes(source.kind)) validateUrls(listValues(source.urls));
  if (["local", "hybrid"].includes(source.kind) && source.files.length === 0) throw new Error("请至少添加一个本地文档。");
  if (source.files.length > 20) throw new Error("本地文档最多 20 个。");
  for (const file of source.files) if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MiB 限制。`);
}

function createClientTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function buildResearchProfile(source: ResearchSourceConfig, documentIds: string[]): Record<string, unknown> {
  const urls = listValues(source.urls);
  const web = {
    ...(listValues(source.includeDomains).length ? { includeDomains: listValues(source.includeDomains) } : {}),
    ...(listValues(source.excludeDomains).length ? { excludeDomains: listValues(source.excludeDomains) } : {}),
  };
  if (source.kind === "web") return { source: { mode: "web", ...web } };
  if (source.kind === "urls") return { source: { mode: "urls", urls } };
  if (source.kind === "urls_web") return { source: { mode: "urls", urls, web } };
  if (source.kind === "local") return { source: { mode: "local", documentIds } };
  return { source: { mode: "hybrid", documentIds, web } };
}

function ReportRoute({
  taskId,
  initialTopic,
  onBackToResearch,
}: {
  taskId: string;
  initialTopic: string;
  onBackToResearch: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic || "研究报告");
  useEffect(() => {
    let active = true;
    setTopic(initialTopic || "研究报告");
    void getResearchTask(taskId).then((task) => {
      if (active) setTopic(task.topic);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [initialTopic, taskId]);
  return (
    <Suspense fallback={<ReportSessionLoading />}>
      <ReportSession key={taskId} taskId={taskId} topic={topic} onBackToResearch={onBackToResearch} />
    </Suspense>
  );
}

export function App() {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [session, setSession] = useState<SessionState>({ phase: "idle" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<ResearchSourceConfig>(defaultSource);
  const [recommendedTopics, setRecommendedTopics] = useState<ResearchTopicRecommendation[]>([]);
  const [recommendationsRefreshing, setRecommendationsRefreshing] = useState(false);
  const [recommendationBatch, setRecommendationBatch] = useState(0);
  const [auth, setAuth] = useState<AuthStatus>({ enabled: false, authenticated: true });
  const [authLoading, setAuthLoading] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const pendingAction = useRef<(() => void) | undefined>(undefined);
  const welcomeTitleRef = useRef<HTMLSpanElement>(null);
  const welcomeTitleAiRef = useRef<HTMLSpanElement>(null);

  const requireLogin = (action?: () => void) => {
    if (!auth.enabled || auth.authenticated) {
      action?.();
      return;
    }
    if (action) pendingAction.current = action;
    setLoginError("");
    setLoginOpen(true);
  };

  useEffect(() => {
    void getAuthStatus().then((status) => {
      setAuth(status);
      setAuthLoading(false);
      if (status.enabled && !status.authenticated) {
        const match = window.location.hash.match(/^#\/tasks\/([^/]+)(?:\/report)?$/u);
        if (match) {
          window.history.replaceState(null, "", "/");
          setSession({ phase: "idle" });
          setLoginOpen(true);
        }
      }
    }).catch((reason) => {
      setAuthLoading(false);
      setAuth({ enabled: true, authenticated: false });
      setLoginError(reason instanceof Error ? reason.message : "无法检查登录状态");
    });
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      setAuth((current) => ({ ...current, enabled: true, authenticated: false, username: undefined }));
      setHistoryOpen(false);
      setSettingsOpen(false);
      setSession({ phase: "idle" });
      window.history.replaceState(null, "", "/");
      setLoginError("登录状态已失效，请重新登录");
      setLoginOpen(true);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleUnauthorized);
  }, []);

  const handleLogin = async ({ username, password }: LoginValues) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const status = await login(username, password);
      setAuth(status);
      setLoginOpen(false);
      const action = pendingAction.current;
      pendingAction.current = undefined;
      action?.();
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout().then(setAuth).catch(() => undefined);
    setHistoryOpen(false);
    setSettingsOpen(false);
  };

  const syncWelcomeTitleLine = () => {
    const title = welcomeTitleRef.current;
    const ai = welcomeTitleAiRef.current;
    if (!title || !ai) return;
    const titleBounds = title.getBoundingClientRect();
    const aiBounds = ai.getBoundingClientRect();
    title.style.setProperty("--ai-line-left", `${(aiBounds.left - titleBounds.left).toFixed(1)}px`);
    title.style.setProperty("--ai-line-width", `${aiBounds.width.toFixed(1)}px`);
  };

  useEffect(() => {
    if (session.phase !== "idle") return;
    const frame = window.requestAnimationFrame(syncWelcomeTitleLine);
    window.addEventListener("resize", syncWelcomeTitleLine);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncWelcomeTitleLine);
    };
  }, [session.phase]);

  useEffect(() => {
    if (session.phase !== "idle") return;
    let active = true;
    let refreshTimer: number | undefined;
    let attempts = 0;
    const load = async () => {
      try {
        const response = await getResearchTopicRecommendations();
        if (!active) return;
        setRecommendedTopics(response.items);
        setRecommendationBatch(0);
        setRecommendationsRefreshing(response.refreshing);
        attempts += 1;
        if (response.refreshing && attempts < 5) {
          refreshTimer = window.setTimeout(() => void load(), 15_000);
        } else if (response.nextRefreshAt) {
          const delay = Math.max(
            15_000,
            Math.min(Date.parse(response.nextRefreshAt) - Date.now() + 1_000, 2_147_000_000),
          );
          refreshTimer = window.setTimeout(() => {
            attempts = 0;
            void load();
          }, delay);
        }
      } catch {
        if (active) setRecommendationsRefreshing(false);
      }
    };
    void load();
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [session.phase]);

  useEffect(() => {
    const restoreFromHash = () => {
      const match = window.location.hash.match(/^#\/tasks\/([^/]+)(?:\/(report))?$/u);
      if (!match) {
        setSession({ phase: "idle" });
        return;
      }
      setSession({ phase: "researching", topic: "", taskId: decodeURIComponent(match[1]), view: match[2] ? "report" : "workspace" });
    };
    restoreFromHash();
    window.addEventListener("hashchange", restoreFromHash);
    return () => window.removeEventListener("hashchange", restoreFromHash);
  }, []);

  async function startResearch(topic: string) {
    setError("");
    setSession({ phase: "starting", topic, stage: "preparing" });
    try {
      validateSource(source);
      const taskId = createClientTaskId();
      const documentIds = await Promise.all(source.files.map(async (file) => {
        const contentBase64 = await fileToBase64(file);
        const record = await uploadResearchDocument(taskId, file.name, contentBase64);
        return record.documentId;
      }));
      setSession({ phase: "starting", topic, stage: "creating" });
      const task = await createResearchTask({
        topic,
        taskId,
        researchProfile: buildResearchProfile(source, documentIds),
      });
      setSession({ phase: "researching", topic, taskId: task.id, view: "workspace" });
      window.history.replaceState(null, "", `#/tasks/${encodeURIComponent(task.id)}`);
    } catch (reason) {
      if (reason instanceof AuthRequiredError) {
        setInput(topic);
        pendingAction.current = () => {
          setInput("");
          void startResearch(topic);
        };
        return;
      }
      setSession({ phase: "start_failed", topic, error: reason instanceof Error ? reason.message : "研究任务创建失败" });
    }
  }

  function handleSubmit(message: string) {
    const topic = message.trim();
    if (!topic || session.phase !== "idle") return;
    requireLogin(() => {
      setInput("");
      void startResearch(topic);
    });
  }

  const recommendationBatchCount = Math.max(
    1,
    Math.floor(recommendedTopics.length / RECOMMENDATIONS_PER_BATCH),
  );
  const visibleRecommendedTopics = Array.from(
    { length: Math.min(RECOMMENDATIONS_PER_BATCH, recommendedTopics.length) },
    (_, offset) => recommendedTopics[
      recommendationBatch * RECOMMENDATIONS_PER_BATCH + offset
    ],
  ).filter((topic): topic is ResearchTopicRecommendation => Boolean(topic));

  const openTask = (taskId: string, topic: string) => {
    setHistoryOpen(false);
    setSession({ phase: "researching", topic, taskId, view: "workspace" });
    window.history.pushState(null, "", `#/tasks/${encodeURIComponent(taskId)}`);
  };

  if (authLoading) return <div className="auth-loading" aria-busy="true">正在检查登录状态</div>;

  if (session.phase !== "idle") {
    const exitToHome = () => { window.history.pushState(null, "", "/"); setSession({ phase: "idle" }); };
    if (session.phase === "starting") return <ResearchLaunch onExit={exitToHome} stage={session.stage} topic={session.topic} />;
    if (session.phase === "start_failed") return <ResearchLaunch error={session.error} onExit={exitToHome} onRetry={() => void startResearch(session.topic)} topic={session.topic} />;
    const openReport = (taskId: string, topic: string) => {
      void loadReportSessionModule();
      preloadReportSession(taskId);
      setSession({ phase: "researching", topic, taskId, view: "report" });
      window.history.pushState(null, "", `#/tasks/${encodeURIComponent(taskId)}/report`);
    };
    const backToResearch = () => {
      setSession({ phase: "researching", topic: session.topic, taskId: session.taskId, view: "workspace" });
      window.history.pushState(null, "", `#/tasks/${encodeURIComponent(session.taskId)}`);
    };
    if (session.view === "report") {
      return <ReportRoute taskId={session.taskId} initialTopic={session.topic} onBackToResearch={backToResearch} />;
    }
    return <Suspense fallback={<ResearchLaunch onExit={exitToHome} stage="opening" topic={session.topic} />}><ResearchWorkspace taskId={session.taskId} initialTopic={session.topic} onExit={exitToHome} onOpenTask={openTask} onOpenReport={openReport} onPreloadReport={preloadReportSession} /></Suspense>;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <BrandLockup />
        <nav className="header-actions" aria-label="应用导航">
          {auth.authenticated ? <>
            <button type="button" title="历史研究" onClick={() => setHistoryOpen(true)}><HistoryOutlined />历史研究</button>
            <button type="button" title="设置" onClick={() => setSettingsOpen(true)}><SettingOutlined />设置</button>
            <button type="button" title="退出登录" onClick={() => void handleLogout()}><LogoutOutlined />退出</button>
          </> : <button type="button" title="登录" onClick={() => requireLogin()}><LoginOutlined />登录</button>}
        </nav>
      </header>

      <section className="welcome-stage">
        <div
          className="welcome-copy welcome-copy-interactive"
          onPointerLeave={(event) => {
            const style = event.currentTarget.style;
            style.setProperty("--title-x", "0px");
            style.setProperty("--title-y", "0px");
            style.setProperty("--copy-x", "0px");
            style.setProperty("--copy-y", "0px");
          }}
          onPointerMove={(event) => {
            syncWelcomeTitleLine();
            const bounds = event.currentTarget.getBoundingClientRect();
            const pointerX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
            const pointerY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
            const style = event.currentTarget.style;
            style.setProperty("--title-x", `${(pointerX * 3).toFixed(1)}px`);
            style.setProperty("--title-y", `${(pointerY * 3).toFixed(1)}px`);
            style.setProperty("--copy-x", `${(pointerX * 1.5).toFixed(1)}px`);
            style.setProperty("--copy-y", `${(pointerY * 1.5).toFixed(1)}px`);
          }}
        >
          <h1 className="welcome-title"><span className="welcome-title-content" ref={welcomeTitleRef}>把问题交给智研<span className="welcome-title-ai" ref={welcomeTitleAiRef}>AI</span>助手</span></h1>
          <p>从一个问题开始，自动组建专家团队、检索证据并交付研究报告。</p>
        </div>
        <section className={`composer-frame ${auth.enabled && !auth.authenticated ? "requires-login" : ""}`} aria-label="开始研究" onClick={() => requireLogin()}>
          <Sender
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="告诉我你想研究什么..."
            prefix={<Popover content={<ResearchSourcePopover onChange={setSource} value={source} />} onOpenChange={(open) => { if (open && auth.enabled && !auth.authenticated) { setSourceOpen(false); requireLogin(); return; } setSourceOpen(open); }} open={sourceOpen} placement="bottomLeft" trigger="click"><button aria-label="研究来源" className={`composer-tool ${source.kind !== "web" ? "has-source-selection" : ""}`} title="研究来源" type="button"><PlusOutlined /></button></Popover>}
          />
          {error && <p className="composer-error" role="alert">{error}</p>}
          <div className="composer-note">第一条消息将作为本次研究主题 · 当前研究模式：{sourceLabels[source.kind]}</div>
        </section>
        {recommendedTopics.length > 0 && (
          <section className="recommended-topics" aria-label="推荐研究主题">
            <header>
              <div><strong>近期值得研究</strong><span>选一个方向开始，也可以继续修改</span></div>
              <Tooltip title={recommendationBatchCount > 1 ? "换一批研究方向" : recommendationsRefreshing ? "正在准备更多研究方向" : "暂无更多研究方向"}>
                <button
                  aria-label="换一批研究方向"
                  className="recommendation-refresh"
                  disabled={recommendationBatchCount <= 1}
                  onClick={() => setRecommendationBatch((current) => (current + 1) % recommendationBatchCount)}
                  type="button"
                >
                  <ReloadOutlined spin={recommendationsRefreshing} />
                </button>
              </Tooltip>
            </header>
            <div className="recommended-topic-list">
              {visibleRecommendedTopics.map((topic) => (
                <article className="recommended-topic-item" key={topic.id}>
                  <button
                    className="recommended-topic-select"
                    onClick={() => setInput(`${topic.title} - ${topic.summary}`)}
                    type="button"
                  >
                    <span className="recommended-topic-category">{topic.category}</span>
                    <strong>{topic.title}</strong>
                    <small>{topic.summary}</small>
                  </button>
                  {topic.sources.length > 0 && (
                    <Popover
                      content={(
                        <div className="recommended-topic-source-list">
                          {topic.sources.map((source) => (
                            <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                              <span>{source.title}</span>
                              <small>{source.domain}</small>
                            </a>
                          ))}
                        </div>
                      )}
                      overlayClassName="recommended-topic-source-popover"
                      placement="bottomRight"
                      title="选题参考来源"
                      trigger="click"
                    >
                      <button
                        aria-label={`查看“${topic.title}”的 ${topic.sources.length} 个参考来源`}
                        className="recommended-topic-sources-trigger"
                        type="button"
                      >
                        <LinkOutlined aria-hidden="true" />
                        {topic.sources.length}
                      </button>
                    </Popover>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
      <HistoryDrawer onClose={() => setHistoryOpen(false)} onOpenTask={openTask} open={historyOpen} />
      <SettingsDrawer onClose={() => setSettingsOpen(false)} open={settingsOpen} />
      <LoginModal error={loginError} loading={loginLoading} onCancel={() => {
        if (loginLoading) return;
        pendingAction.current = undefined;
        setLoginOpen(false);
      }} onFinish={(values) => void handleLogin(values)} open={loginOpen} />
    </main>
  );
}
