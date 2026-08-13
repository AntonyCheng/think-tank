import { useEffect } from "react";
import { Alert, Button, Form, Input, Modal } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";

export interface LoginValues {
  username: string;
  password: string;
}

export function LoginModal({
  error,
  loading,
  onCancel,
  onFinish,
  open,
}: {
  error: string;
  loading: boolean;
  onCancel: () => void;
  onFinish: (values: LoginValues) => void;
  open: boolean;
}) {
  const [form] = Form.useForm<LoginValues>();
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ username: "", password: "" });
    }
  }, [form, open]);
  return (
    <Modal
      centered
      className="login-modal"
      closable={!loading}
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      open={open}
      rootClassName="login-modal-root"
      width={760}
    >
      <div className="login-modal-layout">
        <div className="login-modal-visual" aria-hidden="true">
          <img alt="" src="/login-tech-cover.jpg" />
        </div>
        <div className="login-modal-form-pane">
          <div className="login-modal-heading">
            <h2>登录智研AI助手</h2>
            <p>登录后开始研究并访问你的研究记录。</p>
          </div>
          {error && <Alert className="login-modal-error" message={error} showIcon type="error" />}
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item label="账号" name="username" rules={[{ required: true, message: "请输入账号" }]}>
              <Input autoComplete="username" prefix={<UserOutlined />} placeholder="请输入账号" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password autoComplete="current-password" prefix={<LockOutlined />} placeholder="请输入密码" />
            </Form.Item>
            <Button block htmlType="submit" loading={loading} type="primary">登录</Button>
          </Form>
        </div>
      </div>
    </Modal>
  );
}
