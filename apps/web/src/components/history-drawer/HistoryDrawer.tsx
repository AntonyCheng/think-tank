import { useEffect, useState } from "react";
import { Button, Drawer, Empty, Input, List, Popconfirm, Segmented, Spin, Tag, Tooltip } from "antd";
import { DeleteOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from "@ant-design/icons";
import type { ResearchHistoryFilter, ResearchHistoryItem } from "../../domain/task";
import { deleteResearchTask, listResearchHistory } from "../../services/api-client";
import { BrandLockup } from "../brand/BrandLockup";

const filterOptions: Array<{ label: string; value: ResearchHistoryFilter }> = [
  { label: "全部", value: "all" },
  { label: "已完成", value: "completed" },
  { label: "未完成", value: "unfinished" },
];

const statusLabels: Record<ResearchHistoryItem["status"], string> = {
  queued: "等待执行",
  recoverable: "可恢复",
  running: "研究中",
  needs_input: "等待输入",
  canceling: "正在停止",
  canceled: "已停止",
  completed: "已完成",
  completed_with_warnings: "已完成",
  failed: "未完成",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryDrawer({
  open,
  onClose,
  onOpenTask,
}: {
  open: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string, topic: string) => void;
}) {
  return (
    <Drawer className="history-drawer" open={open} onClose={onClose} title="历史研究" width={420} destroyOnClose>
      <HistoryPanel active={open} onOpenTask={onOpenTask} />
    </Drawer>
  );
}

export function HistorySidebar({
  collapsed,
  onOpenTask,
  onToggle,
}: {
  collapsed: boolean;
  onOpenTask: (taskId: string, topic: string) => void;
  onToggle: () => void;
}) {
  return <aside className={`history-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="历史研究">
    <div className="history-sidebar-brand"><BrandLockup /></div>
    <div className="history-sidebar-heading">
      {!collapsed && <strong>历史研究</strong>}
      <Tooltip title={collapsed ? "展开历史研究" : "收起历史研究"}>
        <button aria-label={collapsed ? "展开历史研究" : "收起历史研究"} className="history-sidebar-toggle" onClick={onToggle} type="button">
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
      </Tooltip>
    </div>
    <HistoryPanel active={!collapsed} className="history-sidebar-panel" onOpenTask={onOpenTask} />
  </aside>;
}

function HistoryPanel({
  active,
  className = "",
  onOpenTask,
}: {
  active: boolean;
  className?: string;
  onOpenTask: (taskId: string, topic: string) => void;
}) {
  const [filter, setFilter] = useState<ResearchHistoryFilter>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ResearchHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      listResearchHistory({ filter, query, limit: 50 })
        .then((page) => {
          if (mounted) {
            setItems(page.items);
            setError("");
          }
        })
        .catch((reason) => {
          if (mounted) setError(reason instanceof Error ? reason.message : "历史记录加载失败");
        })
        .finally(() => { if (mounted) setLoading(false); });
    }, query ? 220 : 0);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [active, filter, query]);

  const remove = async (item: ResearchHistoryItem) => {
    setDeletingId(item.id);
    setError("");
    try {
      await deleteResearchTask(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除研究记录失败");
    } finally {
      setDeletingId("");
    }
  };

  return (
    <section className={`history-panel ${className}`}>
      <div className="drawer-toolbar">
        <Input allowClear onChange={(event) => setQuery(event.target.value)} placeholder="搜索研究话题" prefix={<SearchOutlined />} value={query} />
        <Segmented block options={filterOptions} value={filter} onChange={(value) => setFilter(value as ResearchHistoryFilter)} />
      </div>
      {loading ? <div className="drawer-loading"><Spin /></div> : error ? <div className="drawer-error">{error}</div> : items.length ? (
        <List
          className="history-list"
          dataSource={items}
          renderItem={(item) => {
            const canDelete = ["completed", "completed_with_warnings", "failed", "canceled"].includes(item.status);
            return <List.Item key={item.id}>
              <div
                className={`history-item ${canDelete ? "has-delete-control" : "has-inline-status"}`}
                onClick={() => onOpenTask(item.id, item.topic)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenTask(item.id, item.topic);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div>
                  <Tooltip placement="right" title={item.topic}><strong>{item.topic}</strong></Tooltip>
                  <span>{formatDate(item.updatedAt)} · {item.expertCount} 位专家 · {item.sourceCount} 个来源</span>
                </div>
                <div className="history-item-meta">
                  <Tag color={isCompletedHistoryItem(item) ? "green" : item.status === "failed" ? "red" : "blue"}>{statusLabels[item.status]}</Tag>
                  {canDelete && <span className="history-delete-control" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}><Popconfirm cancelText="取消" description="关联的报告版本和编辑对话也会被清除。" okButtonProps={{ danger: true }} okText="删除" onCancel={(event) => event?.stopPropagation()} onConfirm={(event) => { event?.stopPropagation(); void remove(item); }} title="删除这条研究记录？"><Button aria-label={`删除研究：${item.topic}`} danger icon={<DeleteOutlined />} loading={deletingId === item.id} onClick={(event) => event.stopPropagation()} size="small" type="text" /></Popconfirm></span>}
                </div>
              </div>
            </List.Item>
          }}
        />
      ) : <Empty className="drawer-empty" description="没有符合条件的研究记录" />}
    </section>
  );
}

function isCompletedHistoryItem(item: ResearchHistoryItem): boolean {
  return item.status === "completed" || item.status === "completed_with_warnings";
}
