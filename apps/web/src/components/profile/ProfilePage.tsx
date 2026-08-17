import { useEffect, useState } from "react";
import { ArrowLeftOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Spin, Tag } from "antd";
import {
  changeCurrentUserPassword,
  getCurrentUserProfile,
  type AuthStatus,
  type CurrentUserProfile,
} from "../../services/auth-client";

type PasswordValues = {
  currentPassword: string;
  nextPassword: string;
  confirmPassword: string;
};

export function ProfilePage({
  onBack,
  onPasswordChanged,
}: {
  onBack: () => void;
  onPasswordChanged: (status: AuthStatus) => void;
}) {
  const [form] = Form.useForm<PasswordValues>();
  const [profile, setProfile] = useState<CurrentUserProfile>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getCurrentUserProfile()
      .then((value) => { if (active) setProfile(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "账户信息加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const changePassword = async (values: PasswordValues) => {
    setSaving(true);
    setError("");
    try {
      const status = await changeCurrentUserPassword(values.currentPassword, values.nextPassword);
      onPasswordChanged(status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码修改失败");
    } finally {
      setSaving(false);
    }
  };

  return <main className="profile-shell">
    <header className="profile-header">
      <button className="profile-back" onClick={onBack} type="button"><ArrowLeftOutlined />返回首页</button>
      <div><strong>个人中心</strong><span>账户与安全</span></div>
    </header>
    <section className="profile-content" aria-live="polite">
      {loading ? <div className="profile-loading"><Spin size="large" /></div> : profile ? <>
        <section className="profile-section" aria-labelledby="profile-account-heading">
          <div className="profile-section-heading">
            <span><UserOutlined /><strong id="profile-account-heading">账户信息</strong></span>
          </div>
          <dl className="profile-details">
            <div><dt>账号</dt><dd>{profile.username}</dd></div>
            <div><dt>角色</dt><dd><Tag color={profile.role === "admin" ? "blue" : "default"}>{profile.role === "admin" ? "管理员" : "普通用户"}</Tag></dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(profile.createdAt)}</dd></div>
            <div><dt>最近登录</dt><dd>{profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : "尚未记录"}</dd></div>
          </dl>
        </section>
        <section className="profile-section profile-security-section" aria-labelledby="profile-security-heading">
          <div className="profile-section-heading">
            <span><SafetyCertificateOutlined /><strong id="profile-security-heading">账户安全</strong></span>
          </div>
          <p>修改密码后，所有已登录设备都需要使用新密码重新登录。</p>
          {error && <Alert className="profile-error" message={error} showIcon type="error" />}
          <Form form={form} layout="vertical" onFinish={(values) => void changePassword(values)}>
            <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: "请输入当前密码" }]}>
              <Input.Password autoComplete="current-password" prefix={<LockOutlined />} />
            </Form.Item>
            <Form.Item label="新密码" name="nextPassword" rules={[{ required: true, min: 8, message: "新密码至少需要 8 位" }]}>
              <Input.Password autoComplete="new-password" prefix={<LockOutlined />} />
            </Form.Item>
            <Form.Item label="确认新密码" dependencies={["nextPassword"]} name="confirmPassword" rules={[
              { required: true, message: "请再次输入新密码" },
              ({ getFieldValue }) => ({ validator(_, value) { return !value || getFieldValue("nextPassword") === value ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")); } }),
            ]}>
              <Input.Password autoComplete="new-password" prefix={<LockOutlined />} />
            </Form.Item>
            <Button htmlType="submit" loading={saving} type="primary">{saving ? "正在更新密码" : "更新密码并重新登录"}</Button>
          </Form>
        </section>
      </> : <Alert message={error || "账户信息暂不可用"} type="error" />}
    </section>
  </main>;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
