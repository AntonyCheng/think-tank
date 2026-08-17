import { useEffect, useState, type ReactNode } from "react";
import {
  ApiOutlined,
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  CloseCircleFilled,
  DatabaseOutlined,
  GlobalOutlined,
  ReloadOutlined,
  SaveOutlined,
  TeamOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { Alert, Button, Collapse, Divider, Form, Input, InputNumber, List, Menu, Modal, Popconfirm, Select, Spin, Switch, Tag, type FormInstance } from "antd";
import type {
  RuntimeSettings,
  RuntimeSettingsUpdate,
  SettingsPreflightCheck,
} from "../../domain/settings";
import {
  createManagedUser,
  deleteManagedUser,
  getRuntimeSettings,
  listManagedUsers,
  preflightRuntimeSettings,
  type ManagedUser,
  updateManagedUser,
  updateRuntimeSettings,
} from "../../services/api-client";

type SettingsFormValues = RuntimeSettingsUpdate & { apiKey?: string };
type CheckScope = "models" | "fallbackModels" | "embedding" | "retrievers";
type SettingsSection = "overview" | "models" | "embedding" | "search" | "scheduling" | "users";
type RuntimeSettingsSection = "models" | "embedding" | "search" | "scheduling";
type UserFormValues = { username: string; password: string; role: "admin" | "member" };

const sectionFields: Record<RuntimeSettingsSection, string[]> = {
  models: ["openaiBaseUrl", "apiKey", "aoPlannerModel", "aoVerifierModel", "gptrFastLlm", "gptrSmartLlm"],
  embedding: ["gptrEmbedding", "gptrEmbeddingBaseUrl", "embeddingApiKey"],
  search: ["retrievers", "retrieverApiKeys"],
  scheduling: ["concurrency"],
};

const fallbackModelFields = [
  "fallbackEnabled",
  "fallbackOpenaiBaseUrl",
  "fallbackApiKey",
  "fallbackAoPlannerModel",
  "fallbackAoVerifierModel",
  "fallbackGptrFastLlm",
  "fallbackGptrSmartLlm",
];

const preflightScopeForSection: Record<RuntimeSettingsSection, "models" | "embedding" | "retrievers" | "scheduling"> = {
  models: "models",
  embedding: "embedding",
  search: "retrievers",
  scheduling: "scheduling",
};

const sections: Array<{ key: SettingsSection; label: string; icon: ReactNode }> = [
  { key: "overview", label: "运行概览", icon: <CloudServerOutlined /> },
  { key: "models", label: "模型与 API", icon: <ApiOutlined /> },
  { key: "embedding", label: "向量服务", icon: <DatabaseOutlined /> },
  { key: "search", label: "搜索与推荐", icon: <GlobalOutlined /> },
  { key: "scheduling", label: "研究调度", icon: <ReloadOutlined /> },
  { key: "users", label: "用户与访问", icon: <TeamOutlined /> },
];

const chatRequestExample = `POST {接口地址}/chat/completions
Authorization: Bearer {API Key}
Content-Type: application/json

{
  "model": "gpt-5.6-terra",
  "messages": [{ "role": "user", "content": "ping" }]
}`;

const embeddingRequestExample = `POST {接口地址}/embeddings
Authorization: Bearer {Embedding API Key}
Content-Type: application/json

{
  "model": "m3e",
  "input": ["健康检查"]
}`;

export function SystemSettingsPage({ onBack }: { onBack: () => void }) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [section, setSection] = useState<SettingsSection>("overview");
  const [settings, setSettings] = useState<RuntimeSettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [checks, setChecks] = useState<SettingsPreflightCheck[]>([]);
  const [checkingScope, setCheckingScope] = useState<CheckScope>();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userSaving, setUserSaving] = useState(false);

  const applySettings = (value: RuntimeSettings) => {
    setSettings(value);
    form.setFieldsValue({ ...value, apiKey: "", fallbackApiKey: "", embeddingApiKey: "", retrieverApiKeys: {} });
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([getRuntimeSettings(), listManagedUsers()])
      .then(([value, userResponse]) => {
        if (!active) return;
        applySettings(value);
        setUsers(userResponse.users);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "设置加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [form]);

  const save = async (currentSection: RuntimeSettingsSection) => {
    setSaving(true);
    setError("");
    setSaved(false);
    setChecks([]);
    try {
      const values = await form.validateFields(sectionFields[currentSection]);
      const scope = preflightScopeForSection[currentSection];
      const updated = await updateRuntimeSettings(values, scope);
      setSettings(updated);
      clearSectionSecrets(form, currentSection);
      setChecks(updated.checks);
      setSaved(true);
    } catch (reason) {
      const failure = reason as Error & { checks?: SettingsPreflightCheck[] };
      setChecks(failure.checks ?? []);
      setError(reason instanceof Error ? reason.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const check = async (scope: CheckScope) => {
    try {
      const fields = scope === "fallbackModels"
        ? fallbackModelFields
        : sectionFields[scope === "models" ? "models" : scope === "embedding" ? "embedding" : "search"];
      const values = await form.validateFields(fields);
      setCheckingScope(scope);
      setError("");
      setSaved(false);
      const result = await preflightRuntimeSettings(values, scope);
      setChecks((current) => replaceChecks(current, result, scope));
    } catch (reason) {
      const failure = reason as Error & { checks?: SettingsPreflightCheck[] };
      if (failure.checks) setChecks((current) => replaceChecks(current, failure.checks!, scope));
      else setError(reason instanceof Error ? reason.message : "连接检测失败");
    } finally {
      setCheckingScope(undefined);
    }
  };

  const saveFallback = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    setChecks([]);
    try {
      const values = await form.validateFields(fallbackModelFields);
      const updated = await updateRuntimeSettings(values, "fallbackModels");
      setSettings(updated);
      form.setFieldsValue({ fallbackApiKey: "" });
      setChecks(updated.checks);
      setSaved(true);
    } catch (reason) {
      const failure = reason as Error & { checks?: SettingsPreflightCheck[] };
      setChecks(failure.checks ?? []);
      setError(reason instanceof Error ? reason.message : "备用模型设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const checkButton = (scope: CheckScope, label: string) => (
    <Button icon={<ReloadOutlined />} loading={checkingScope === scope} onClick={() => void check(scope)} size="small">
      {checkingScope === scope ? "检测中" : label}
    </Button>
  );

  const checkFor = (label: string) => checks.find((check) => check.label === label);
  const groupSummary = (scope: CheckScope) => summarizeChecks(checks.filter((check) => check.id === scopeCheckId(scope)));
  const modelProviderSummary = (prefix: "主模型" | "备用模型") => summarizeChecks(
    checks.filter((check) => check.id === "model" && check.label.startsWith(prefix)),
  );
  const selectedRetrievers = Form.useWatch("retrievers", form) ?? settings?.retrievers ?? [];
  const fallbackEnabled = Form.useWatch("fallbackEnabled", form) ?? settings?.fallbackEnabled ?? false;
  const credentialRetrievers = settings?.retrieverCapabilities.filter(
    (item) => item.credentialRequired && selectedRetrievers.includes(item.id),
  ) ?? [];
  const hasRuntimeSettings = isRuntimeSettingsSection(section);
  const hasCredentialFields = section === "models" || section === "embedding" || section === "search";

  return <main className="system-settings-shell">
    <header className="system-settings-header">
      <button className="system-settings-back" onClick={onBack} type="button"><ArrowLeftOutlined />返回首页</button>
      <div><strong>系统设置</strong><span>管理员配置中心</span></div>
    </header>
    <div className="system-settings-layout">
      <aside className="system-settings-nav" aria-label="设置分类">
        <Menu
          items={sections.map((item) => ({ key: item.key, label: item.label, icon: item.icon }))}
          onClick={({ key }) => {
            setSection(key as SettingsSection);
            setError("");
            setSaved(false);
          }}
          selectedKeys={[section]}
        />
      </aside>
      <section className="system-settings-content" aria-live="polite">
        {loading ? <div className="system-settings-loading"><Spin size="large" /></div> : settings ? <Form component={false} form={form} layout="vertical">
          <div className="system-settings-content-header">
            <div>
              <h1>{sections.find((item) => item.key === section)?.label}</h1>
              <p>{section === "overview" ? "查看当前运行配置与访问状态。" : section === "users" ? "管理平台账号与访问状态。" : section === "scheduling" ? "保存后立即作用于排队和后续研究；已开始的研究不会被中断。" : "修改后将在下一次研究任务开始时生效。"}</p>
            </div>
          </div>
          {hasCredentialFields && <Alert className="settings-hint" message="API Key 不会返回浏览器；对应字段留空时，服务端将保留现有值。" showIcon type="info" />}
          {error && <Alert className="settings-hint" message={hasRuntimeSettings && checks.length ? "连接检测未通过，设置未保存" : error} showIcon type="error" />}
          {hasRuntimeSettings && saved && <Alert className="settings-hint" message="设置已验证并保存" showIcon type="success" />}
          {section === "overview" && <Overview settings={settings} userCount={users.length} />}
          <section className="settings-panel" hidden={section !== "models"}>
            <div className="settings-panel-heading"><strong>主模型提供商</strong><span>{modelProviderSummary("主模型")}{checkButton("models", "检测主模型")}</span></div>
            <ProtocolExample endpoint="/chat/completions" example={chatRequestExample} />
            <Form.Item label="OpenAI 兼容接口地址" name="openaiBaseUrl" rules={[{ required: true, message: "请输入接口地址" }]}><Input /></Form.Item>
            <Form.Item label="API Key" name="apiKey"><Input.Password placeholder={settings.apiKeyConfigured ? "已配置，留空则保持不变" : "请输入 API Key"} /></Form.Item>
            <Form.Item label="AO 编排模型" name="aoPlannerModel" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
            <FieldCheck check={checkFor("主模型·AO 编排模型")} />
            <Form.Item label="AO 验证模型" name="aoVerifierModel"><Input placeholder="可选，留空则不单独配置" /></Form.Item>
            <FieldCheck check={checkFor("主模型·AO 验证模型")} />
            <Form.Item label="GPTR 快速模型" name="gptrFastLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input placeholder="例如 gpt-5.6-terra" /></Form.Item>
            <FieldCheck check={checkFor("主模型·GPTR 快速模型")} />
            <Form.Item label="GPTR 深度模型" name="gptrSmartLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input placeholder="例如 gpt-5.6-terra" /></Form.Item>
            <FieldCheck check={checkFor("主模型·GPTR 深度模型")} />
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => void save("models")} type="primary">{saving ? "正在检测并保存" : "保存主模型提供商"}</Button>
          </section>
          <section className="settings-panel" hidden={section !== "models"}>
            <div className="settings-panel-heading"><strong>备用模型提供商</strong><span>{modelProviderSummary("备用模型")}{checkButton("fallbackModels", "检测备用模型")}</span></div>
            <p className="settings-panel-copy">主模型服务发生网络异常、超时、限流或服务端错误时，研究任务将自动切换到这里配置的 OpenAI 兼容服务。</p>
            <Form.Item label="启用备用模型提供商" name="fallbackEnabled" valuePropName="checked"><Switch /></Form.Item>
            {fallbackEnabled && <>
              <ProtocolExample endpoint="/chat/completions" example={chatRequestExample} />
              <Form.Item label="OpenAI 兼容接口地址" name="fallbackOpenaiBaseUrl" rules={[{ required: true, message: "请输入备用接口地址" }]}><Input /></Form.Item>
              <Form.Item label="API Key" name="fallbackApiKey" rules={settings.fallbackApiKeyConfigured ? [] : [{ required: true, message: "请输入备用 API Key" }]}><Input.Password placeholder={settings.fallbackApiKeyConfigured ? "已配置，留空则保持不变" : "请输入备用 API Key"} /></Form.Item>
              <Form.Item label="AO 编排模型" name="fallbackAoPlannerModel" rules={[{ required: true, message: "请输入备用 AO 编排模型" }]}><Input /></Form.Item>
              <FieldCheck check={checkFor("备用模型·AO 编排模型")} />
              <Form.Item label="AO 验证模型" name="fallbackAoVerifierModel" rules={[{ required: true, message: "请输入备用 AO 验证模型" }]}><Input /></Form.Item>
              <FieldCheck check={checkFor("备用模型·AO 验证模型")} />
              <Form.Item label="GPTR 快速模型" name="fallbackGptrFastLlm" rules={[{ required: true, message: "请输入备用 GPTR 快速模型" }]}><Input /></Form.Item>
              <FieldCheck check={checkFor("备用模型·GPTR 快速模型")} />
              <Form.Item label="GPTR 深度模型" name="fallbackGptrSmartLlm" rules={[{ required: true, message: "请输入备用 GPTR 深度模型" }]}><Input /></Form.Item>
              <FieldCheck check={checkFor("备用模型·GPTR 深度模型")} />
            </>}
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => void saveFallback()} type="primary">{saving ? "正在检测并保存" : "保存备用模型提供商"}</Button>
          </section>
          <section className="settings-panel" hidden={section !== "embedding"}>
            <div className="settings-panel-heading"><strong>Embedding 服务</strong><span>{groupSummary("embedding")}{checkButton("embedding", "检测向量")}</span></div>
            <ProtocolExample endpoint="/embeddings" example={embeddingRequestExample} />
            <Form.Item label="Embedding 模型" name="gptrEmbedding" rules={[{ required: true, message: "请输入模型名称" }]}><Input placeholder="例如 m3e" /></Form.Item>
            <FieldCheck check={checkFor("Embedding 模型")} />
            <Form.Item label="Embedding 接口地址" name="gptrEmbeddingBaseUrl"><Input placeholder="留空时复用主接口地址" /></Form.Item>
            <Form.Item label="Embedding API Key" name="embeddingApiKey"><Input.Password placeholder={settings.embeddingApiKeyConfigured ? "已配置，留空则保持不变" : "请输入 Embedding API Key"} /></Form.Item>
          </section>
          <section className="settings-panel" hidden={section !== "search"}>
            <div className="settings-panel-heading"><strong>网页搜索</strong><span>{groupSummary("retrievers")}{checkButton("retrievers", "检测搜索")}</span></div>
            <Form.Item label="默认检索器" name="retrievers" rules={[{ required: true, message: "至少选择一个检索器" }]}><Select maxCount={settings.maxRetrievers} mode="multiple" options={settings.retrieverCapabilities.filter((item) => item.selectable).map((item) => ({ label: item.label, value: item.id }))} /></Form.Item>
            {credentialRetrievers.map((item) => <Form.Item key={item.id} label={`${item.label} API Key`} name={["retrieverApiKeys", item.id]}><Input.Password placeholder={settings.configuredRetrieverCredentials.includes(item.id) ? "已配置，留空则保持不变" : `请输入 ${item.label} API Key`} /></Form.Item>)}
            {checks.filter((check) => check.id === "retriever").map((check) => <FieldCheck check={check} key={`${check.id}:${check.label}`} showLabel />)}
          </section>
          <section className="settings-panel" hidden={section !== "scheduling"}>
            <div className="settings-panel-heading"><strong>研究执行调度</strong></div>
            <Form.Item extra="统一限制专家步骤调度、单任务研究提交与 GPTR 实际执行进程。" label="最大研究并发数" name="concurrency" rules={[{ required: true, message: "请输入并发数" }]}><InputNumber min={1} max={16} style={{ width: "100%" }} /></Form.Item>
          </section>
          {section === "users" && <UserManagement
            saving={userSaving}
            users={users}
            onCreate={async (input) => {
              setUserSaving(true);
              setError("");
              try {
                const result = await createManagedUser(input);
                setUsers((current) => [...current, result.user]);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "创建用户失败");
                throw reason;
              } finally {
                setUserSaving(false);
              }
            }}
            onToggle={async (user) => {
              setUserSaving(true);
              setError("");
              try {
                const result = await updateManagedUser(user.id, { active: !user.active });
                setUsers((current) => current.map((item) => item.id === result.user.id ? result.user : item));
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "更新用户失败");
              } finally {
                setUserSaving(false);
              }
            }}
            onDelete={async (user) => {
              setUserSaving(true);
              setError("");
              try {
                await deleteManagedUser(user.id);
                setUsers((current) => current.filter((item) => item.id !== user.id));
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : "删除用户失败");
                throw reason;
              } finally {
                setUserSaving(false);
              }
            }}
          />}
          {hasRuntimeSettings && section !== "models" && <footer className="system-settings-actions">
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => void save(section)} type="primary">{saving ? "正在检测并保存" : "保存并应用"}</Button>
          </footer>}
        </Form> : <Alert message={error || "设置暂不可用"} type="error" />}
      </section>
    </div>
  </main>;
}

function Overview({ settings, userCount }: { settings: RuntimeSettings; userCount: number }) {
  return <section className="settings-overview-grid">
    <article><span>模型服务</span><strong>{settings.aoPlannerModel}</strong><small>{settings.openaiBaseUrl}</small></article>
    <article><span>向量模型</span><strong>{settings.gptrEmbedding}</strong><small>{settings.gptrEmbeddingBaseUrl || "复用主接口"}</small></article>
    <article><span>默认搜索</span><strong>{settings.retrievers.join("、") || "未选择"}</strong><small>最多 {settings.maxRetrievers} 个检索器</small></article>
    <article><span>运行与访问</span><strong>{settings.concurrency} 个并发任务</strong><small>{userCount} 个已创建用户</small></article>
  </section>;
}

function UserManagement({ users, saving, onCreate, onToggle, onDelete }: {
  users: ManagedUser[];
  saving: boolean;
  onCreate: (input: UserFormValues) => Promise<void>;
  onToggle: (user: ManagedUser) => Promise<void>;
  onDelete: (user: ManagedUser) => Promise<void>;
}) {
  const [form] = Form.useForm<UserFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  return <section className="settings-panel settings-user-management" aria-label="用户管理">
    <div className="settings-panel-heading"><strong>用户管理</strong><Button icon={<UserAddOutlined />} onClick={() => setCreateOpen(true)} type="primary">新增用户</Button></div>
    <List className="settings-user-list" dataSource={users} locale={{ emptyText: "暂无用户" }} renderItem={(user) => <List.Item actions={[
      <Button disabled={saving} key="toggle" onClick={() => void onToggle(user)} size="small" type="text">{user.active ? "停用" : "启用"}</Button>,
      <Popconfirm cancelText="取消" description="删除后无法恢复；用户仍有研究记录时，系统会拒绝删除。" key="delete" okButtonProps={{ danger: true }} okText="删除用户" onConfirm={() => onDelete(user)} title={`删除账号“${user.username}”？`}>
        <Button danger disabled={saving} size="small" type="text">删除</Button>
      </Popconfirm>,
    ]}>
      <List.Item.Meta description={<span className="settings-user-dates">创建：{formatDateTime(user.createdAt)}<span>最近登录：{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "尚未登录"}</span></span>} title={<><span>{user.username}</span> <Tag>{user.role === "admin" ? "管理员" : "普通用户"}</Tag>{!user.active && <Tag color="default">已停用</Tag>}</>} />
    </List.Item>} />
    <Modal afterClose={() => form.resetFields()} cancelText="取消" confirmLoading={saving} destroyOnHidden okText="创建用户" onCancel={() => setCreateOpen(false)} onOk={() => void form.validateFields().then(async (values) => { await onCreate(values); setCreateOpen(false); }).catch(() => undefined)} open={createOpen} title="新增用户">
      <Form form={form} layout="vertical">
        <Form.Item label="账号" name="username" rules={[{ required: true, message: "请输入账号" }]}><Input autoComplete="off" placeholder="3 至 64 位账号" /></Form.Item>
        <Form.Item label="初始密码" name="password" rules={[{ required: true, min: 8, message: "密码至少需要 8 位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item initialValue="member" label="角色" name="role"><Select options={[{ value: "member", label: "普通用户" }, { value: "admin", label: "管理员" }]} /></Form.Item>
      </Form>
    </Modal>
  </section>;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function ProtocolExample({ endpoint, example }: { endpoint: string; example: string }) {
  return <div className="settings-protocol-example">
    <p>仅支持 OpenAI 兼容协议，接口地址填写至 <code>/v1</code>，服务需提供 <code>POST {endpoint}</code>。</p>
    <Collapse ghost items={[{ key: "request-example", label: "查看请求样例", children: <pre>{example}</pre> }]} size="small" />
  </div>;
}

function isRuntimeSettingsSection(section: SettingsSection): section is RuntimeSettingsSection {
  return section === "models" || section === "embedding" || section === "search" || section === "scheduling";
}

function clearSectionSecrets(form: FormInstance<SettingsFormValues>, section: RuntimeSettingsSection): void {
  if (section === "models") form.setFieldsValue({ apiKey: "" });
  if (section === "embedding") form.setFieldsValue({ embeddingApiKey: "" });
  if (section === "search") form.setFieldsValue({ retrieverApiKeys: {} });
}

function FieldCheck({ check, showLabel = false }: { check?: SettingsPreflightCheck; showLabel?: boolean }) {
  if (!check) return null;
  const passed = check.status === "passed";
  return <div className={`settings-field-check is-${check.status}`} role="status">
    {passed ? <CheckCircleFilled /> : <CloseCircleFilled />}
    <span>{showLabel ? `${check.label}：` : ""}{passed ? "连接正常" : "检测失败"}</span>
    {!passed && check.detail && <details><summary>查看响应详情</summary><pre>{check.detail}</pre></details>}
  </div>;
}

function summarizeChecks(checks: SettingsPreflightCheck[]) {
  if (!checks.length) return null;
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.length - failed;
  return <span className={`settings-test-summary ${failed ? "is-failed" : "is-passed"}`}>{failed ? `${passed} 项通过，${failed} 项失败` : `${passed} 项通过`}</span>;
}

function scopeCheckId(scope: CheckScope): SettingsPreflightCheck["id"] {
  return scope === "models" || scope === "fallbackModels"
    ? "model"
    : scope === "embedding"
    ? "embedding"
    : "retriever";
}

function replaceChecks(current: SettingsPreflightCheck[], next: SettingsPreflightCheck[], scope: CheckScope): SettingsPreflightCheck[] {
  const id = scopeCheckId(scope);
  return [...current.filter((check) => check.id !== id), ...next];
}
