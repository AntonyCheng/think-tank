import { ArrowLeftOutlined, CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { BrandLockup } from "../brand/BrandLockup";

export type ResearchLaunchStage = "preparing" | "creating" | "opening";

interface ResearchLaunchProps {
  topic: string;
  stage?: ResearchLaunchStage;
  error?: string;
  onExit: () => void;
  onRetry?: () => void;
  errorTitle?: string;
  retryLabel?: string;
}

const stageCopy: Record<ResearchLaunchStage, { title: string; description: string; activeStep: number }> = {
  preparing: {
    title: "正在准备研究",
    description: "正在检查研究设置，并准备本次任务需要的资料。",
    activeStep: 1,
  },
  creating: {
    title: "正在创建研究会话",
    description: "研究主题已提交，正在安排任务与后续协作流程。",
    activeStep: 2,
  },
  opening: {
    title: "正在进入研究工作区",
    description: "研究会话已创建，正在同步专家团队和实时进度。",
    activeStep: 3,
  },
};

const steps = ["研究主题已提交", "准备研究会话", "进入研究工作区"];

export function ResearchLaunch({ topic, stage = "opening", error, onExit, onRetry, errorTitle = "暂时无法创建研究会话", retryLabel = "重试创建" }: ResearchLaunchProps) {
  const copy = stageCopy[stage];
  const hasError = Boolean(error);

  return (
    <main className="research-launch-shell">
      <header className="workspace-header research-launch-header">
        <BrandLockup onClick={onExit} />
        <div className="workspace-title"><span>深度研究</span><strong>{topic || "正在加载研究记录"}</strong></div>
        <span className={`launch-header-status ${hasError ? "is-error" : ""}`}>{hasError ? "需要处理" : "正在启动"}</span>
      </header>
      <section aria-live="polite" className="research-launch-stage">
        <div className="research-launch-copy">
          {hasError ? <span className="launch-icon launch-icon-error">!</span> : <LoadingOutlined className="launch-icon" spin />}
          <p className="research-launch-eyebrow">{hasError ? "研究尚未开始" : "研究启动中"}</p>
          <h1>{hasError ? errorTitle : copy.title}</h1>
          <p className="research-launch-description">{hasError ? error : copy.description}</p>
          {!hasError && <ol className="research-launch-steps">
            {steps.map((label, index) => {
              const step = index + 1;
              const complete = step < copy.activeStep;
              const active = step === copy.activeStep;
              return <li className={`${complete ? "is-complete" : ""} ${active ? "is-active" : ""}`} key={label}>
                <span>{complete ? <CheckCircleFilled /> : active ? <LoadingOutlined spin /> : step}</span>{label}
              </li>;
            })}
          </ol>}
          {topic.trim() && <p className="research-launch-topic">{topic}</p>}
          {hasError && <div className="research-launch-actions">
            {onRetry && <Button type="primary" onClick={onRetry}>{retryLabel}</Button>}
            <Button icon={<ArrowLeftOutlined />} onClick={onExit}>返回首页</Button>
          </div>}
        </div>
      </section>
    </main>
  );
}
