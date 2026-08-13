import { useEffect, useState } from "react";
import { CheckCircleFilled, CloseCircleFilled, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Spin } from "antd";
import type {
  RuntimeSettings,
  RuntimeSettingsUpdate,
  SettingsPreflightCheck,
} from "../../domain/settings";
import {
  getRuntimeSettings,
  preflightRuntimeSettings,
  updateRuntimeSettings,
} from "../../services/api-client";

type SettingsFormValues = RuntimeSettingsUpdate & { apiKey?: string };
type CheckScope = "models" | "embedding" | "retrievers";

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [settings, setSettings] = useState<RuntimeSettings>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [checks, setChecks] = useState<SettingsPreflightCheck[]>([]);
  const [checkingScope, setCheckingScope] = useState<CheckScope>();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setChecks([]);
    setCheckingScope(undefined);
    getRuntimeSettings()
      .then((value) => {
        setSettings(value);
        form.setFieldsValue({ ...value, apiKey: "", embeddingApiKey: "" });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "设置加载失败"))
      .finally(() => setLoading(false));
  }, [form, open]);

  const save = async (values: SettingsFormValues) => {
    setSaving(true);
    setError("");
    setSaved(false);
    setChecks([]);
    try {
      const updated = await updateRuntimeSettings(values);
      setSettings(updated);
      form.setFieldsValue({ ...updated, apiKey: "", embeddingApiKey: "" });
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
      const values = await form.validateFields();
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

  const checkButton = (scope: CheckScope, label: string) => (
    <Button
      icon={<ReloadOutlined />}
      loading={checkingScope === scope}
      onClick={() => void check(scope)}
      size="small"
      type="text"
    >
      {checkingScope === scope ? "检测中" : label}
    </Button>
  );

  const checkFor = (label: string) => checks.find((check) => check.label === label);
  const groupSummary = (scope: CheckScope) => summarizeChecks(checks.filter((check) => check.id === scopeCheckId(scope)));

  return (
    <Drawer className="settings-drawer" open={open} onClose={onClose} title="运行设置" width={480} destroyOnClose>
      {loading ? <div className="drawer-loading"><Spin /></div> : settings ? <Form form={form} layout="vertical" onFinish={save}>
        <Alert className="settings-hint" message="设置在下一次研究任务开始时生效。现有 API Key 不会返回浏览器。" showIcon type="info" />
        {error && <Alert className="settings-hint" message={checks.length ? "连接检测未通过，设置未保存" : error} showIcon type="error" />}
        {saved && <Alert className="settings-hint" message="设置已验证并保存" showIcon type="success" />}
        <Form.Item label="OpenAI 兼容接口地址" name="openaiBaseUrl" rules={[{ required: true, message: "请输入接口地址" }]}><Input /></Form.Item>
        <Form.Item label="API Key" name="apiKey"><Input.Password placeholder={settings.apiKeyConfigured ? "已配置，留空则保持不变" : "请输入 API Key"} /></Form.Item>

        <div className="settings-test-group">
          <div className="settings-test-group-heading">
            <strong>模型服务</strong>
            <span className="settings-test-group-actions">{groupSummary("models")}{checkButton("models", "检测模型")}</span>
          </div>
          <Form.Item label="AO 编排模型" name="aoPlannerModel" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
          <FieldCheck check={checkFor("AO 编排模型")} />
          <Form.Item label="AO 验证模型" name="aoVerifierModel"><Input placeholder="可选，留空则不单独配置" /></Form.Item>
          <FieldCheck check={checkFor("AO 验证模型")} />
          <Form.Item label="GPTR 快速模型" name="gptrFastLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
          <FieldCheck check={checkFor("GPTR 快速模型")} />
          <Form.Item label="GPTR 深度模型" name="gptrSmartLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
          <FieldCheck check={checkFor("GPTR 深度模型")} />
        </div>

        <div className="settings-test-group">
          <div className="settings-test-group-heading">
            <strong>Embedding 服务</strong>
            <span className="settings-test-group-actions">{groupSummary("embedding")}{checkButton("embedding", "检测向量")}</span>
          </div>
          <Form.Item label="Embedding 模型" name="gptrEmbedding" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
          <FieldCheck check={checkFor("Embedding 模型")} />
          <Form.Item label="Embedding 接口地址" name="gptrEmbeddingBaseUrl"><Input placeholder="留空时复用主接口地址" /></Form.Item>
          <Form.Item label="Embedding API Key" name="embeddingApiKey"><Input.Password placeholder={settings.embeddingApiKeyConfigured ? "已配置，留空则保持不变" : "请输入 Embedding API Key"} /></Form.Item>
        </div>

        <div className="settings-test-group">
          <div className="settings-test-group-heading">
            <strong>网页搜索</strong>
            <span className="settings-test-group-actions">{groupSummary("retrievers")}{checkButton("retrievers", "检测搜索")}</span>
          </div>
          <Form.Item label="默认检索器" name="retrievers" rules={[{ required: true, message: "至少选择一个检索器" }]}><Select maxCount={settings.maxRetrievers} mode="multiple" options={settings.retrieverCapabilities.filter((item) => item.selectable).map((item) => ({ label: item.credentialRequired ? `${item.label}（需服务端密钥）` : item.label, value: item.id }))} /></Form.Item>
          {checks.filter((check) => check.id === "retriever").map((check) => <FieldCheck check={check} key={`${check.id}:${check.label}`} showLabel />)}
        </div>

        <Form.Item label="最大并发任务数" name="concurrency" rules={[{ required: true, message: "请输入并发数" }]}><InputNumber min={1} max={16} style={{ width: "100%" }} /></Form.Item>
        <Button block htmlType="submit" loading={saving} type="primary">{saving ? "正在检测并保存" : "保存设置"}</Button>
      </Form> : <Alert message={error || "设置暂不可用"} type="error" />}
    </Drawer>
  );
}

function FieldCheck({ check, showLabel = false }: { check?: SettingsPreflightCheck; showLabel?: boolean }) {
  if (!check) return null;
  const passed = check.status === "passed";
  return <div className={`settings-field-check is-${check.status}`} role="status">
    {passed ? <CheckCircleFilled /> : <CloseCircleFilled />}
    <span>{showLabel ? `${check.label}：` : ""}{passed ? "连接正常" : "检测失败"}</span>
    {!passed && check.detail && <details>
      <summary>查看响应详情</summary>
      <pre>{check.detail}</pre>
    </details>}
  </div>;
}

function summarizeChecks(checks: SettingsPreflightCheck[]) {
  if (!checks.length) return null;
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.length - failed;
  return <span className={`settings-test-summary ${failed ? "is-failed" : "is-passed"}`}>
    {failed ? `${passed} 项通过，${failed} 项失败` : `${passed} 项通过`}
  </span>;
}

function scopeCheckId(scope: CheckScope): SettingsPreflightCheck["id"] {
  return scope === "models"
    ? "model"
    : scope === "embedding"
    ? "embedding"
    : "retriever";
}

function replaceChecks(
  current: SettingsPreflightCheck[],
  next: SettingsPreflightCheck[],
  scope: CheckScope,
): SettingsPreflightCheck[] {
  const id = scopeCheckId(scope);
  const retained = current.filter((check) => check.id !== id);
  return [...retained, ...next];
}
