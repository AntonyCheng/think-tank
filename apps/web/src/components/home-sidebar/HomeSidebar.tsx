import { useEffect, useState } from "react";
import { Dropdown, Popconfirm } from "antd";
import {
  DeleteOutlined,
  LoginOutlined,
  LogoutOutlined,
  MoreOutlined,
  PlusOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { AuthStatus } from "../../services/auth-client";
import { deleteResearchTask, listResearchHistory } from "../../services/api-client";
import type { ResearchHistoryItem, TaskStatus } from "../../domain/task";
import { BrandLockup } from "../brand/BrandLockup";

interface HomeSidebarProps {
  auth: AuthStatus;
  onNewResearch: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onOpenTask: (taskId: string, topic: string) => void;
  onLogin: () => void;
  onLogout: () => void;
}

const RECORD_LIMIT = 60;
const runningStatuses: TaskStatus[] = ["queued", "recoverable", "running", "needs_input", "canceling"];
const doneStatuses: TaskStatus[] = ["completed", "completed_with_warnings"];
const deletableStatuses: TaskStatus[] = ["completed", "completed_with_warnings", "failed", "canceled"];

const statusText: Record<TaskStatus, string> = {
  queued: "排队中",
  recoverable: "可恢复",
  running: "研究中",
  needs_input: "待输入",
  canceling: "停止中",
  canceled: "已停止",
  completed: "已完成",
  completed_with_warnings: "已完成",
  failed: "未完成",
};

function dotClass(status: TaskStatus): string {
  if (runningStatuses.includes(status)) return "running";
  if (doneStatuses.includes(status)) return "completed";
  return "";
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function HomeSidebar({
  auth,
  onNewResearch,
  onOpenSettings,
  onOpenProfile,
  onOpenTask,
  onLogin,
  onLogout,
}: HomeSidebarProps) {
  const [records, setRecords] = useState<ResearchHistoryItem[]>();
  const [failed, setFailed] = useState(false);
  const [deletingId, setDeletingId] = useState("");

  useEffect(() => {
    if (!auth.authenticated) {
      setRecords([]);
      return;
    }
    let active = true;
    listResearchHistory({ filter: "all", limit: RECORD_LIMIT })
      .then((page) => { if (active) { setRecords(page.items); setFailed(false); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [auth.authenticated]);

  const removeRecord = async (item: ResearchHistoryItem) => {
    setDeletingId(item.id);
    try {
      await deleteResearchTask(item.id);
      setRecords((current) => current?.filter((entry) => entry.id !== item.id));
    } catch {
      // Keep the item; the list stays usable and the user can retry.
    } finally {
      setDeletingId("");
    }
  };

  const roleLabel = auth.role === "admin" ? "管理员" : auth.role === "member" ? "普通用户" : "研究员";
  const accountItems = [
    ...(auth.role !== "member" ? [{ key: "settings", icon: <SettingOutlined />, label: "系统设置" }] : []),
    ...(auth.profileAvailable ? [{ key: "profile", icon: <UserOutlined />, label: "个人中心" }] : []),
    { type: "divider" as const },
    { key: "logout", danger: true, icon: <LogoutOutlined />, label: "退出登录" },
  ];

  return (
    <aside className="sidebar">
      <BrandLockup variant="sidebar" onClick={onNewResearch} label="新建研究" />
      <button className="new-research" type="button" onClick={onNewResearch} title="新建研究">
        <PlusOutlined />
        <span className="new-research-label">新建研究</span>
      </button>

      <div className="sidebar-recent">
        <div className="sidebar-recent-head">
          <span>研究记录</span>
        </div>
        <div className="recent-research">
          {!auth.authenticated ? (
            <p className="recent-empty">登录后查看你的研究记录。</p>
          ) : failed ? (
            <p className="recent-empty">研究记录暂时无法加载。</p>
          ) : records === undefined ? (
            [0, 1, 2, 3, 4].map((row) => <div className="recent-skeleton" key={row}><i /><i /></div>)
          ) : records.length === 0 ? (
            <p className="recent-empty">还没有研究记录，从上方开始第一次研究。</p>
          ) : (
            records.map((item) => (
              <div className="recent-item" key={item.id}>
                <button type="button" onClick={() => onOpenTask(item.id, item.topic)}>
                  <span aria-hidden="true" className={`recent-dot ${dotClass(item.status)}`} />
                  <span>
                    {item.topic}
                    <small>{formatWhen(item.updatedAt)} · {statusText[item.status]}</small>
                  </span>
                </button>
                {deletableStatuses.includes(item.status) && (
                  <Popconfirm
                    cancelText="取消"
                    description="关联的报告版本和编辑对话也会被清除。"
                    okButtonProps={{ danger: true }}
                    okText="删除"
                    onConfirm={() => void removeRecord(item)}
                    placement="right"
                    title="删除这条研究记录？"
                  >
                    <button
                      aria-label={`删除研究：${item.topic}`}
                      className="recent-del"
                      disabled={deletingId === item.id}
                      type="button"
                    >
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {auth.authenticated ? (
        <Dropdown
          menu={{
            items: accountItems,
            onClick: ({ key }) => {
              if (key === "settings") onOpenSettings();
              else if (key === "profile") onOpenProfile();
              else if (key === "logout") onLogout();
            },
          }}
          placement="topLeft"
          trigger={["click"]}
        >
          <button aria-label="账号菜单" className="profile-card" type="button">
            <span className="avatar">{(auth.username ?? "U").slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{auth.username ?? "当前账号"}</strong>
              <small>{roleLabel}</small>
            </span>
            <MoreOutlined className="profile-more" />
          </button>
        </Dropdown>
      ) : (
        <button aria-label="登录" className="profile-card" type="button" onClick={onLogin}>
          <span className="avatar"><LoginOutlined /></span>
          <span>
            <strong>未登录</strong>
            <small>点击登录</small>
          </span>
        </button>
      )}
    </aside>
  );
}
