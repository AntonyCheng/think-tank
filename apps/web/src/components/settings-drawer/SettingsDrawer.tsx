import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Spin } from "antd";
import type { RuntimeSettings, RuntimeSettingsUpdate } from "../../domain/settings";
import { getRuntimeSettings, updateRuntimeSettings } from "../../services/api-client";

type SettingsFormValues = RuntimeSettingsUpdate & { apiKey?: string };

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [settings, setSettings] = useState<RuntimeSettings>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    getRuntimeSettings()
      .then((value) => {
        setSettings(value);
        form.setFieldsValue({ ...value, apiKey: "" });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "设置加载失败"))
      .finally(() => setLoading(false));
  }, [form, open]);

  const save = async (values: SettingsFormValues) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateRuntimeSettings(values);
      setSettings(updated);
      form.setFieldsValue({ ...updated, apiKey: "" });
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer className="settings-drawer" open={open} onClose={onClose} title="运行设置" width={480} destroyOnClose>
      {loading ? <div className="drawer-loading"><Spin /></div> : settings ? <Form form={form} layout="vertical" onFinish={save}>
        <Alert className="settings-hint" message="设置在下一次研究任务开始时生效。现有 API Key 不会返回浏览器。" showIcon type="info" />
        {error && <Alert className="settings-hint" message={error} showIcon type="error" />}
        {saved && <Alert className="settings-hint" message="设置已保存" showIcon type="success" />}
        <Form.Item label="OpenAI 兼容接口地址" name="openaiBaseUrl" rules={[{ required: true, message: "请输入接口地址" }]}><Input /></Form.Item>
        <Form.Item label="API Key" name="apiKey"><Input.Password placeholder={settings.apiKeyConfigured ? "已配置，留空则保持不变" : "请输入 API Key"} /></Form.Item>
        <Form.Item label="AO 编排模型" name="aoPlannerModel" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
        <Form.Item label="AO 验证模型" name="aoVerifierModel"><Input placeholder="可选，留空则不单独配置" /></Form.Item>
        <Form.Item label="GPTR 快速模型" name="gptrFastLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
        <Form.Item label="GPTR 深度模型" name="gptrSmartLlm" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
        <Form.Item label="Embedding 模型" name="gptrEmbedding" rules={[{ required: true, message: "请输入模型名称" }]}><Input /></Form.Item>
        <Form.Item label="Embedding 接口地址" name="gptrEmbeddingBaseUrl"><Input placeholder="留空时复用主接口地址" /></Form.Item>
        <Form.Item label="默认检索器" name="retrievers" rules={[{ required: true, message: "至少选择一个检索器" }]}><Select maxCount={settings.maxRetrievers} mode="multiple" options={settings.retrieverCapabilities.filter((item) => item.selectable).map((item) => ({ label: item.credentialRequired ? `${item.label}（需服务端密钥）` : item.label, value: item.id }))} /></Form.Item>
        <Form.Item label="最大并发任务数" name="concurrency" rules={[{ required: true, message: "请输入并发数" }]}><InputNumber min={1} max={16} style={{ width: "100%" }} /></Form.Item>
        <Button block htmlType="submit" loading={saving} type="primary">保存设置</Button>
      </Form> : <Alert message={error || "设置暂不可用"} type="error" />}
    </Drawer>
  );
}
