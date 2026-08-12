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
          colorPrimary: "#2167d5",
          colorText: "#20252b",
          colorTextSecondary: "#66717e",
          colorBgBase: "#ffffff",
          borderRadius: 10,
          fontFamily: "Inter, system-ui, -apple-system, Microsoft YaHei, sans-serif",
        },
      }}
    >
      <XProvider>
        <App />
      </XProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
