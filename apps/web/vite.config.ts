import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The legacy static frontend remains outside the build while migration is
  // being verified. React owns every production asset from src/.
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
      "/ready": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "antd-core": ["antd", "@ant-design/icons"],
          "ai-ui": ["@ant-design/x"],
        },
      },
    },
  },
});
