import { LoadingOutlined } from "@ant-design/icons";
import { Spin } from "antd";

export function ReportSessionLoading() {
  return (
    <main className="report-session-loading">
      <Spin indicator={<LoadingOutlined spin />} />
      <p>正在准备报告</p>
    </main>
  );
}
