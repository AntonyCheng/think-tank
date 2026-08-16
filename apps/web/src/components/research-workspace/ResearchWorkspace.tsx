import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { Button, Empty, Popover, Tag } from "antd";
import { Bubble, Sender, ThoughtChain, type ThoughtChainItem } from "@ant-design/x";
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DownOutlined,
  LeftOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  RightOutlined,
  SendOutlined,
  TeamOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { activityFromEvent, type TaskEvent } from "../../domain/research-events";
import type { ResearchTaskSnapshot, TaskStatus, WorkflowStep } from "../../domain/task";
import type { AgentCatalogEntry } from "../../domain/agent";
import { answerResearchInput, cancelResearchTask, getAgentCatalog, getTaskDiagnostics, retryResearchTask } from "../../services/api-client";
import { activitiesFromEvents, formatElapsed, formatTime } from "../../services/task-events";
import { useOrderedEvents, useResearchStore } from "../../stores/research-store";
import { ResearchLaunch } from "../research-launch/ResearchLaunch";
import { BrandLockup } from "../brand/BrandLockup";

const taskMarkdown = new MarkdownIt({ html: false, linkify: true, typographer: true });

interface ResearchWorkspaceProps {
  taskId: string;
  initialTopic: string;
  onExit: () => void;
  onOpenTask: (taskId: string, topic: string) => void;
  onOpenReport: (taskId: string, topic: string) => void;
  onPreloadReport: (taskId: string) => void;
}

interface ExpertRuntime {
  status: "waiting" | "working" | "completed" | "failed" | "skipped";
  event?: TaskEvent;
}

interface ResearchFailurePresentation {
  heading: string;
  summary: string;
  detail?: string;
  hint: string;
}

const statusCopy: Record<TaskStatus, string> = {
  queued: "等待研究启动",
  recoverable: "等待恢复",
  running: "研究进行中",
  needs_input: "等待你的输入",
  canceling: "正在停止",
  canceled: "已停止",
  completed: "研究已完成",
  completed_with_warnings: "研究已完成",
  failed: "研究未完成",
};

const researchModeCopy: Record<string, string> = {
  standard: "标准研究",
  deep: "深度研究",
  synthesis: "综合整理",
};

const researchPhaseCopy: Record<string, string> = {
  preparing: "准备中",
  searching: "检索中",
  collecting: "收集中",
  planning: "规划中",
  analyzing: "分析中",
  writing: "撰写中",
  finalizing: "整理中",
};

const expertRuntimeCopy: Record<ExpertRuntime["status"], string> = {
  waiting: "等待执行",
  working: "执行中",
  completed: "已完成",
  failed: "未完成",
  skipped: "因上游失败未执行",
};

function researchModeLabel(mode: string): string {
  return researchModeCopy[mode] ?? "研究中";
}

function researchPhaseLabel(phase: string): string {
  return researchPhaseCopy[phase] ?? "研究处理中";
}

function expertRuntime(events: TaskEvent[]): Map<string, ExpertRuntime> {
  const state = new Map<string, ExpertRuntime>();
  for (const event of events) {
    if (event.type === "step.started" && typeof event.data.stepId === "string") {
      state.set(event.data.stepId, { status: "working", event });
    }
    if (event.type === "step.completed" && typeof event.data.stepId === "string") {
      const outcome = event.data.status === "failed"
        ? "failed"
        : event.data.status === "skipped"
          ? "skipped"
          : "completed";
      state.set(event.data.stepId, { status: outcome, event });
    }
  }
  return state;
}

function StatusIcon({ status }: { status: ExpertRuntime["status"] }) {
  if (status === "working") return <LoadingOutlined spin />;
  if (status === "completed") return <CheckCircleFilled />;
  if (status === "failed") return <CloseCircleFilled />;
  return <ClockCircleOutlined />;
}

function researchFailurePresentation(
  snapshot: ResearchTaskSnapshot,
  events: TaskEvent[],
): ResearchFailurePresentation {
  const startedStepIds = new Set(
    events
      .filter((event) => event.type === "step.started" && typeof event.data.stepId === "string")
      .map((event) => event.data.stepId as string),
  );
  if (!startedStepIds.size) {
    return {
      heading: "专家团队未能创建",
      summary: "系统未能完成研究工作流编排，因此没有开始后续检索与分析。",
      hint: "请检查模型服务设置与网络连接后，重新发起研究。",
    };
  }

  const stepNames = new Map(
    (snapshot.workflowPlan?.steps ?? []).map((step) => [step.id, step.name]),
  );
  const finalOutcomes = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "step.completed" || typeof event.data.stepId !== "string") continue;
    finalOutcomes.set(event.data.stepId, typeof event.data.status === "string" ? event.data.status : "completed");
  }
  const failedSteps = [...finalOutcomes]
    .filter(([, status]) => status === "failed")
    .map(([stepId]) => stepNames.get(stepId) ?? stepId);
  const skippedSteps = [...finalOutcomes]
    .filter(([, status]) => status === "skipped")
    .map(([stepId]) => stepNames.get(stepId) ?? stepId);
  const retrieverUnavailable = events
    .map(activityFromEvent)
    .find((activity) => activity?.message.includes("暂时不可用"));
  const noUsableSources = snapshot.researchTelemetry?.summary.uniqueSourceCount === 0;
  const summaryParts = ["专家团队已创建并开始执行。"];
  if (failedSteps.length) summaryParts.push(`${failedSteps.length} 位专家未能完成研究。`);
  if (skippedSteps.length) summaryParts.push(`${skippedSteps.length} 个汇总步骤因依赖失败未执行。`);

  return {
    heading: "专家研究未完成",
    summary: summaryParts.join(""),
    detail: retrieverUnavailable
      ? `${retrieverUnavailable.message} 未获取到可用于专家研究的网页资料。`
      : noUsableSources
        ? "网页搜索未返回可用资料，无法为专家研究提供所需上下文。"
        : failedSteps.length
          ? `未完成的专家步骤：${failedSteps.join("、")}。`
          : undefined,
    hint: "请检查已选搜索引擎与网络连接后，重新发起研究。",
  };
}

function ResearchWarningMarker({ warnings }: { warnings?: string[] }) {
  const messages = warnings?.filter((warning) => warning.trim()) ?? [];
  if (!messages.length) return null;
  const content = <section className="research-warning-popover">
    <strong>研究提示</strong>
    <ol>
      {messages.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
    </ol>
  </section>;
  return <Popover content={content} placement="bottomRight" trigger="click">
    <button aria-label={`查看 ${messages.length} 条研究提示`} className="research-warning-marker" type="button">
      <span aria-hidden="true">!</span><b>{messages.length}</b>
    </button>
  </Popover>;
}

function ExpertRosterItem({
  agent,
  index,
  mode,
  name,
  onSelect,
  runtime,
  selected,
  stepId,
}: {
  agent?: AgentCatalogEntry;
  index: number;
  mode: string;
  name: string;
  onSelect: (id: string) => void;
  runtime: ExpertRuntime;
  selected: boolean;
  stepId: string;
}) {
  const titleRef = useRef<HTMLElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return undefined;
    const updateTruncation = () => setIsTruncated(title.scrollWidth > title.clientWidth + 1);
    const observer = new ResizeObserver(updateTruncation);
    observer.observe(title);
    updateTruncation();
    return () => observer.disconnect();
  }, [name, mode]);

  return <Popover
    content={<div className="expert-name-popover"><span>专家角色</span><strong>{name}</strong><small>{mode}</small></div>}
    mouseEnterDelay={0.25}
    overlayClassName="expert-name-popover-overlay"
    placement="topLeft"
    trigger={isTruncated ? "hover" : []}
  >
    <button
      className={`expert-row ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(stepId)}
      type="button"
    >
      <span className="expert-avatar" aria-hidden="true">{agent?.emoji ?? index + 1}</span>
      <span className="expert-copy">
        <strong ref={titleRef}>{name}</strong>
        <small>{mode}</small>
      </span>
      <span className={`expert-status status-${runtime.status}`} title={expertRuntimeCopy[runtime.status]}>
        <StatusIcon status={runtime.status} />
      </span>
    </button>
  </Popover>;
}

function randomSeed(seed: string): () => number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value = Math.imul(value ^ seed.charCodeAt(index), 16777619);
  }
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function selectedCandidates(catalog: AgentCatalogEntry[], taskId: string): AgentCatalogEntry[][] {
  const shuffled = [...catalog];
  const random = randomSeed(taskId);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const selected = shuffled.slice(0, 60);
  return [0, 1, 2].map((row) => selected.slice(row * 20, row * 20 + 20));
}

function CandidateExpertMatcher({ taskId }: { taskId: string }) {
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    getAgentCatalog()
      .then((agents) => { if (active) setCatalog(agents); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  const rows = useMemo(() => catalog?.length ? selectedCandidates(catalog, taskId) : [], [catalog, taskId]);
  if (failed) {
    return <div className="team-pending">
      <TeamOutlined />
      <h1>正在组建专家团队</h1>
      <p>专家目录暂不可用，系统仍在继续编排研究流程。</p>
    </div>;
  }

  const loading = !rows.length;
  return (
    <section className="team-matcher" aria-label="正在匹配候选专家">
      <div className="team-matcher-copy">
        <h1>匹配专家能力</h1>
        <p>{loading ? "正在准备本次研究需要的专业角色。" : `正在从 ${catalog?.length ?? 0} 位专业角色中筛选本次研究需要的协作团队。`}</p>
      </div>
      <div aria-hidden="true" className={`candidate-rails ${loading ? "candidate-skeleton-rails" : ""}`}>
        {loading
          ? [0, 1, 2].map((rowIndex) => <div className={`candidate-rail candidate-skeleton-rail candidate-rail-${rowIndex + 1}`} key={rowIndex}>
            <div className="candidate-skeleton-track">
              {Array.from({ length: rowIndex === 1 ? 5 : 6 }, (_, cardIndex) => <span className="candidate-skeleton-card" key={cardIndex}><i /><b /></span>)}
            </div>
          </div>)
          : rows.map((row, rowIndex) => <div className={`candidate-rail candidate-rail-${rowIndex + 1}`} key={rowIndex}>
            <div className="candidate-track">
              {[0, 1].map((copy) => <div className="candidate-track-copy" key={copy}>
                {row.map((agent) => <div className="candidate-card" key={`${copy}-${agent.id}`}>
                  <span className="candidate-emoji">{agent.emoji}</span><span>{agent.name}</span>
                </div>)}
              </div>)}
            </div>
          </div>)}
      </div>
    </section>
  );
}

function ResearchFailure({
  snapshot,
  events,
  onRetry,
}: {
  snapshot: ResearchTaskSnapshot;
  events: TaskEvent[];
  onRetry: (task: ResearchTaskSnapshot) => void;
}) {
  const [detail, setDetail] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const presentation = researchFailurePresentation(snapshot, events);
  useEffect(() => {
    let active = true;
    getTaskDiagnostics(snapshot.id)
      .then((diagnostics) => { if (active) setDetail(diagnostics.at(-1)?.message ?? ""); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [snapshot.id]);
  const visibleError = presentation.detail || detail || snapshot.error || "研究任务在启动阶段遇到问题，尚未开始资料检索。";
  const retry = async () => {
    setRetrying(true);
    setRetryError("");
    try {
      onRetry(await retryResearchTask(snapshot.id));
    } catch (reason) {
      setRetryError(reason instanceof Error ? reason.message : "重新发起研究失败，请稍后再试。");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <section className="research-failure" role="alert">
      <CloseCircleFilled />
      <p className="research-failure-kicker">研究已停止</p>
      <h1>{presentation.heading}</h1>
      <p className="research-failure-summary">{presentation.summary}</p>
      <div className="research-failure-detail">
        <span>错误详情</span>
        <p>{visibleError}</p>
      </div>
      <p className="research-failure-hint">{presentation.hint}</p>
      <div className="research-failure-actions">
        <Button type="primary" loading={retrying} onClick={retry}>重新研究</Button>
      </div>
      {retryError && <p className="research-failure-retry-error" role="alert">{retryError}</p>}
    </section>
  );
}

function ExpertRoster({
  steps,
  runtimes,
  agentsByRole,
  selectedId,
  onSelect,
}: {
  steps: WorkflowStep[];
  runtimes: Map<string, ExpertRuntime>;
  agentsByRole: ReadonlyMap<string, AgentCatalogEntry>;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const expertSteps = useMemo(() => steps.filter((step) => step.type === "expert"), [steps]);
  const pageSize = 6;
  const pages = useMemo(() => Array.from(
    { length: Math.ceil(expertSteps.length / pageSize) },
    (_, pageIndex) => expertSteps.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
  ), [expertSteps]);
  const [pageIndex, setPageIndex] = useState(0);
  const activeStepId = selectedId
    ?? expertSteps.find((step) => runtimes.get(step.id)?.status === "working")?.id
    ?? expertSteps[0]?.id;

  useEffect(() => {
    setPageIndex((current) => Math.min(current, Math.max(pages.length - 1, 0)));
  }, [pages.length]);
  useEffect(() => {
    const activeIndex = expertSteps.findIndex((step) => step.id === activeStepId);
    if (activeIndex >= 0) setPageIndex(Math.floor(activeIndex / pageSize));
  }, [activeStepId]);

  return (
    <section className="expert-roster" aria-label="专家组">
      <div className="section-heading">
        <span>专家组</span>
        <div className="expert-roster-meta">
          <small>{expertSteps.length} 位专家</small>
          <span>第{pageIndex + 1}页/共{Math.max(pages.length, 1)}页</span>
        </div>
      </div>
      <div className="expert-carousel">
        {pageIndex > 0
          ? <button aria-label="查看上一组专家" className="expert-carousel-control" onClick={() => setPageIndex((current) => current - 1)} type="button"><LeftOutlined /></button>
          : <span aria-hidden="true" className="expert-carousel-gutter" />}
        <div className="expert-carousel-viewport">
          <div className="expert-carousel-track" style={{ transform: `translateX(-${pageIndex * 100}%)` }}>
            {pages.map((page, currentPageIndex) => <div className="expert-carousel-page" key={currentPageIndex}>
              {page.map((step, index) => {
                const runtime = runtimes.get(step.id) ?? { status: "waiting" as const };
                const agent = agentsByRole.get(step.role);
                const stepIndex = currentPageIndex * pageSize + index;
                return <ExpertRosterItem
                  agent={agent}
                  index={stepIndex}
                  key={step.id}
                  mode={step.mode ? researchModeLabel(step.mode) : "研究专家"}
                  name={step.name}
                  onSelect={onSelect}
                  runtime={runtime}
                  selected={activeStepId === step.id}
                  stepId={step.id}
                />;
              })}
            </div>)}
          </div>
        </div>
        {pageIndex < pages.length - 1
          ? <button aria-label="查看下一组专家" className="expert-carousel-control" onClick={() => setPageIndex((current) => current + 1)} type="button"><RightOutlined /></button>
          : <span aria-hidden="true" className="expert-carousel-gutter" />}
      </div>
    </section>
  );
}

function CurrentExpert({
  snapshot,
  steps,
  runtimes,
  agentsByRole,
  selectedId,
  events,
}: {
  snapshot: ResearchTaskSnapshot;
  steps: WorkflowStep[];
  runtimes: Map<string, ExpertRuntime>;
  agentsByRole: ReadonlyMap<string, AgentCatalogEntry>;
  selectedId?: string;
  events: TaskEvent[];
}) {
  const activeId = selectedId ?? steps.find((step) => runtimes.get(step.id)?.status === "working")?.id;
  const expert = steps.find((step) => step.id === activeId) ?? steps[0];
  const runtime = expert ? runtimes.get(expert.id) ?? { status: "waiting" as const } : undefined;
  const agent = expert ? agentsByRole.get(expert.role) : undefined;
  const taskHtml = useMemo(() => taskMarkdown.render(expert?.task || "系统正在为该专家准备研究任务。"), [expert?.task]);
  const isTerminal = ["completed", "completed_with_warnings", "failed", "canceled"].includes(snapshot.status);
  const taskContentRef = useRef<HTMLDivElement>(null);
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [taskCollapsible, setTaskCollapsible] = useState(false);
  const activities = activitiesFromEvents(events).filter((activity) => !expert || activity.aoStepId === expert.id);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const followLatestActivity = useRef(true);
  const chainItems = activities.map<ThoughtChainItem>((activity) => ({
    key: `${activity.researchRunId}-${activity.sequence}`,
    title: activity.message,
    description: `${researchPhaseLabel(activity.phase)} · ${formatTime(activity.timestamp)}`,
    status: "success",
  }));
  useEffect(() => {
    followLatestActivity.current = true;
  }, [expert?.id]);
  useEffect(() => {
    const content = taskContentRef.current;
    setTaskExpanded(false);
    if (!content) return undefined;

    const updateCollapsible = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(content).lineHeight);
      setTaskCollapsible(content.scrollHeight > lineHeight * 3 + 1);
    };
    const observer = new ResizeObserver(updateCollapsible);
    observer.observe(content);
    updateCollapsible();
    return () => observer.disconnect();
  }, [taskHtml]);
  useEffect(() => {
    const container = activityScrollRef.current;
    if (container && followLatestActivity.current) container.scrollTop = container.scrollHeight;
  }, [expert?.id, activities.length]);
  const handleActivityScroll = () => {
    const container = activityScrollRef.current;
    if (!container) return;
    followLatestActivity.current = container.scrollHeight - container.scrollTop - container.clientHeight < 32;
  };

  return (
    <section className="expert-stage">
      {!isTerminal && <div className="stage-status-line">
        <span className={`connection-dot ${snapshot.status === "running" ? "is-live" : ""}`} />
        <span>{statusCopy[snapshot.status]}</span>
      </div>}
      {expert ? (
        <>
          <div className="current-expert-header">
            <span className="expert-avatar expert-avatar-large">{agent?.emoji ?? expert.name.slice(0, 1)}</span>
            <div>
              <p>当前研究节点</p>
              <h1>{expert.name}</h1>
              <span>{expert.mode ? researchModeLabel(expert.mode) : "研究专家"}</span>
            </div>
            <Tag className={`runtime-tag status-${runtime?.status ?? "waiting"}`} icon={<StatusIcon status={runtime?.status ?? "waiting"} />}>
              {runtime?.status === "working" ? "正在执行" : runtime?.status === "completed" ? "已完成" : runtime?.status === "failed" ? "未完成" : "等待执行"}
            </Tag>
            <ResearchWarningMarker warnings={snapshot.warnings} />
          </div>
          <div className="expert-task-card">
            <span>任务说明</span>
            <div
              className={`expert-task-content ${taskCollapsible && !taskExpanded ? "is-collapsed" : ""}`}
              dangerouslySetInnerHTML={{ __html: taskHtml }}
              ref={taskContentRef}
            />
            <div className="expert-task-meta">
              {expert.mode && <small>研究模式：{researchModeLabel(expert.mode)}</small>}
              {taskCollapsible && <Button
                className="expert-task-toggle"
                icon={taskExpanded ? <UpOutlined /> : <DownOutlined />}
                onClick={() => setTaskExpanded((expanded) => !expanded)}
                size="small"
                type="link"
              >
                {taskExpanded ? "收起" : "展开"}
              </Button>}
            </div>
          </div>
          <section className="activity-chain" aria-label="当前专家研究过程">
            <div className="section-heading"><span>研究过程</span><small>{activities.length} 条活动</small></div>
            {chainItems.length
              ? <div className="activity-chain-scroll" onScroll={handleActivityScroll} ref={activityScrollRef}><ThoughtChain size="small" items={chainItems} collapsible /></div>
              : <p className="empty-copy">正在等待公开研究活动。</p>}
          </section>
        </>
      ) : (
        <CandidateExpertMatcher taskId={snapshot.id} />
      )}
    </section>
  );
}

function ResearchTimeline({ events, steps }: { events: TaskEvent[]; steps: WorkflowStep[] }) {
  const timelineScrollRef = useRef<HTMLOListElement>(null);
  const followLatestEvent = useRef(true);
  const latestEventId = events.at(-1)?.id;
  useEffect(() => {
    const timeline = timelineScrollRef.current;
    if (timeline && followLatestEvent.current) timeline.scrollTop = timeline.scrollHeight;
  }, [latestEventId]);
  const handleTimelineScroll = () => {
    const timeline = timelineScrollRef.current;
    if (!timeline) return;
    followLatestEvent.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 32;
  };
  return (
    <section className="research-timeline" aria-label="研究活动">
      <div className="section-heading"><span>研究动态</span><small>{events.length} 条事件</small></div>
      {events.length ? (
        <ol onScroll={handleTimelineScroll} ref={timelineScrollRef}>
          {events.map((event) => <li key={event.id}><span className="timeline-point" /><div><strong>{timelineEventTitle(event, steps)}</strong><small>{formatTime(event.timestamp)}</small></div></li>)}
        </ol>
      ) : <p className="empty-copy">正在连接研究进度。</p>}
    </section>
  );
}

function timelineEventTitle(event: TaskEvent, steps: WorkflowStep[]): string {
  const activity = activityFromEvent(event);
  const stepId = activity?.aoStepId ?? (typeof event.data.stepId === "string" ? event.data.stepId : undefined);
  const expert = steps.find((step) => step.id === stepId)?.name
    ?? (typeof event.data.agentName === "string" ? event.data.agentName : undefined)
    ?? (typeof event.data.stepName === "string" && event.type.startsWith("step.") ? event.data.stepName : undefined);
  const title = eventTitle(event);
  return expert ? `${expert} - ${title}` : title;
}

function eventTitle(event: TaskEvent): string {
  const activity = activityFromEvent(event);
  if (activity) return activity.message;
  if (typeof event.data.message === "string") return event.data.message;
  if (event.type === "task.needs_input") return "等待补充研究信息";
  if (event.type === "task.input_received") return "已收到补充信息";
  if (event.type === "task.recoverable") return "研究任务可恢复";
  if (event.type === "task.resumed") return "研究任务已恢复";
  if (event.type === "task.rerun_requested") return "正在重新执行研究";
  if (event.type === "task.checkpoint_saved") return "已保存研究进度";
  if (event.type === "task.canceling") return "正在停止研究";
  if (event.type === "task.canceled") return "研究已停止";
  if (event.type === "workflow.composed") return "已完成专家编组";
  if (event.type === "workflow.repairing") return "正在修复专家工作流";
  if (event.type === "step.started") return "开始执行专家任务";
  if (event.type === "step.completed") return "已完成专家任务";
  if (event.type === "task.queued") return "研究任务已进入队列";
  if (event.type === "task.running") return "研究已启动";
  if (event.type === "research.completed") return "专家研究已完成";
  if (event.type === "research.failed") return "专家研究未完成";
  if (event.type === "research.progress") return "研究进度已更新";
  if (event.type === "gptr.progress") return "研究服务正在处理";
  if (event.type === "gptr.completed") return "研究服务处理完成";
  if (event.type === "evidence.bundle.recorded") return "已记录研究证据";
  if (event.type === "task.completed" || event.type === "task.completed_with_warnings") return "研究报告已交付";
  if (event.type === "task.failed") return "研究任务未完成";
  return event.type;
}

function PendingInput({ snapshot, onUpdate }: { snapshot: ResearchTaskSnapshot; onUpdate: (snapshot: ResearchTaskSnapshot) => void }) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const pending = snapshot.pendingInput;
  if (!pending) return null;
  const submit = async (value: string) => {
    if (!value.trim()) return;
    setSubmitting(true); setError("");
    try { onUpdate(await answerResearchInput(snapshot.id, pending.requestId, value)); setAnswer(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提交失败"); }
    finally { setSubmitting(false); }
  };
  return (
    <section className="pending-input-card">
      <PauseCircleOutlined />
      <div><strong>{pending.kind === "approval" ? "需要你的确认" : "需要补充信息"}</strong><p>{pending.prompt}</p></div>
      {pending.kind === "approval" ? <div className="approval-actions"><Button onClick={() => submit("declined")}>暂不批准</Button><Button type="primary" loading={submitting} onClick={() => submit("approved")}>批准继续</Button></div> : <><Sender value={answer} onChange={setAnswer} onSubmit={submit} loading={submitting} placeholder="输入你的补充信息" /><p className="input-error">{error}</p></>}
    </section>
  );
}

function connectionCopy(status: TaskStatus, connection: "loading" | "open" | "closed" | "error"): { label: string; className: string } {
  if (["failed", "canceled", "completed", "completed_with_warnings"].includes(status)) {
    return { label: statusCopy[status], className: "is-terminal" };
  }
  if (connection === "open") return { label: "实时同步", className: "is-open" };
  if (connection === "loading") return { label: "正在连接", className: "" };
  return { label: "正在重连", className: "" };
}

function liveElapsed(snapshot: ResearchTaskSnapshot, now: number): number | undefined {
  const elapsed = snapshot.researchTelemetry?.summary.totalElapsedMs ?? 0;
  if (!["queued", "running", "needs_input", "recoverable", "canceling"].includes(snapshot.status)) {
    return elapsed || undefined;
  }
  const updatedAt = Date.parse(snapshot.updatedAt);
  return elapsed + (Number.isNaN(updatedAt) ? 0 : Math.max(0, now - updatedAt));
}

export function ResearchWorkspace({ taskId, initialTopic, onExit, onOpenTask, onOpenReport, onPreloadReport }: ResearchWorkspaceProps) {
  const store = useResearchStore(taskId);
  const events = useOrderedEvents(store.events);
  const snapshot = store.snapshot;
  const [selectedExpertId, setSelectedExpertId] = useState<string>();
  const [canceling, setCanceling] = useState(false);
  const [agents, setAgents] = useState<AgentCatalogEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const reportHandoff = useRef({ taskId, initialReportAvailable: undefined as boolean | undefined, opened: false });
  if (reportHandoff.current.taskId !== taskId) {
    reportHandoff.current = { taskId, initialReportAvailable: undefined, opened: false };
  }
  const hasLiveDuration = snapshot && ["queued", "running", "needs_input", "recoverable", "canceling"].includes(snapshot.status);
  useEffect(() => {
    if (!hasLiveDuration) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveDuration]);
  const runtimes = useMemo(() => expertRuntime(events), [events]);
  const agentsByRole = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const steps = snapshot?.workflowPlan?.steps ?? [];
  const expertSteps = useMemo(() => steps.filter((step) => step.type === "expert"), [steps]);
  const activeExpertId = expertSteps.some((step) => step.id === selectedExpertId)
    ? selectedExpertId
    : expertSteps.find((step) => runtimes.get(step.id)?.status === "working")?.id ?? expertSteps[0]?.id;
  const canCancel = snapshot && ["queued", "running", "needs_input", "recoverable"].includes(snapshot.status);
  const connection = snapshot ? connectionCopy(snapshot.status, store.connection) : undefined;
  const cancel = async () => {
    if (!snapshot) return;
    setCanceling(true);
    try { store.updateSnapshot(await cancelResearchTask(snapshot.id)); }
    finally { setCanceling(false); }
  };
  useEffect(() => {
    let active = true;
    getAgentCatalog().then((catalog) => { if (active) setAgents(catalog); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    const handoff = reportHandoff.current;
    if (handoff.initialReportAvailable === undefined) {
      handoff.initialReportAvailable = Boolean(snapshot.output);
      return;
    }
    if (
      !handoff.opened
      && !handoff.initialReportAvailable
      && Boolean(snapshot.output)
      && ["completed", "completed_with_warnings"].includes(snapshot.status)
    ) {
      handoff.opened = true;
      onPreloadReport(snapshot.id);
      onOpenReport(snapshot.id, snapshot.topic);
    }
  }, [onOpenReport, onPreloadReport, snapshot]);
  if (!snapshot) {
    if (store.error) {
      const missing = /task not found/i.test(store.error);
      return (
        <main className="workspace-shell">
          <header className="workspace-header">
            <BrandLockup onClick={onExit} />
            <div aria-hidden="true" className="workspace-header-spacer" />
            <span className="connection-label">{missing ? "研究记录不可用" : "连接失败"}</span>
          </header>
          <section className="workspace-unavailable">
            <Empty
              description={missing ? "这条研究记录已被删除或不再可用" : "暂时无法加载研究会话"}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <p>{missing ? "请从历史研究中选择其他记录，或开始新的研究。" : store.error}</p>
              <Button type="primary" onClick={onExit}>返回首页</Button>
            </Empty>
          </section>
        </main>
      );
    }
    return <ResearchLaunch onExit={onExit} stage="opening" topic={initialTopic} />;
  }
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <BrandLockup onClick={onExit} />
        <div className="workspace-title"><span>深度研究</span><strong>{snapshot.topic}</strong></div>
        <div className="workspace-actions"><span className={`connection-label ${connection?.className ?? ""}`}>{connection?.label}</span><Button onClick={onExit}>返回首页</Button>{snapshot.output && <Button className="report-open-button" onClick={() => onOpenReport(snapshot.id, snapshot.topic)} onFocus={() => onPreloadReport(snapshot.id)} onMouseEnter={() => onPreloadReport(snapshot.id)}>查看报告</Button>}{canCancel && <Button className="stop-research-button" loading={canceling} onClick={cancel}>停止研究</Button>}</div>
      </header>
      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <Bubble placement="end" content={snapshot.topic} />
          <ResearchTimeline events={events} steps={steps} />
        </aside>
        <section className="workspace-main">
          <PendingInput snapshot={snapshot} onUpdate={store.updateSnapshot} />
          {snapshot.status === "failed"
            ? <ResearchFailure snapshot={snapshot} events={events} onRetry={(task) => onOpenTask(task.id, task.topic)} />
            : <CurrentExpert agentsByRole={agentsByRole} snapshot={snapshot} steps={steps} runtimes={runtimes} selectedId={activeExpertId} events={events} />}
          <footer className="workspace-summary">
            <span>研究耗时 {formatElapsed(liveElapsed(snapshot, now))}</span>
            <span>已收集 {snapshot.researchTelemetry?.summary.uniqueSourceCount ?? 0} 个来源</span>
            <span>专家步骤 {steps.length}</span>
          </footer>
          {expertSteps.length > 0 && <ExpertRoster agentsByRole={agentsByRole} steps={steps} runtimes={runtimes} selectedId={activeExpertId} onSelect={setSelectedExpertId} />}
        </section>
      </div>
      {snapshot.error && snapshot.status !== "failed" && <div className="workspace-error"><CloseCircleFilled />{snapshot.error}</div>}
    </main>
  );
}
