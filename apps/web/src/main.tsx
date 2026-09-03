import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import { XProvider } from "@ant-design/x";
import "antd/dist/reset.css";
import "./styles.css";
import { App } from "./App";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("React root element is missing");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#e60012",
          colorInfo: "#e60012",
          colorText: "#19191c",
          colorTextSecondary: "#717178",
          colorBgBase: "#ffffff",
          colorBorder: "#e7e7e9",
          borderRadius: 10,
          fontFamily: "Geist, Inter, system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif",
        },
      }}
    >
      <XProvider>
        <App />
      </XProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
