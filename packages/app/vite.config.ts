import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // envDir 指到仓库根:.env 只存这里,且已被 .gitignore 排除
  const env = loadEnv(mode, repoRoot, "");
  return {
    envDir: repoRoot,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // LLM:key 只存在于 dev server 进程,经此注入 Authorization;浏览器永远拿不到
        "/llm": {
          target: "https://api.deepseek.com",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/llm/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (env.DEEPSEEK_KEY) proxyReq.setHeader("authorization", `Bearer ${env.DEEPSEEK_KEY}`);
            });
          },
        },
        // TTS:api_v2 无 CORS(P0-① 实测),dev 必走 proxy;SSE/chunked 透传不缓冲
        "/tts": {
          target: "http://127.0.0.1:9880",
          changeOrigin: true,
        },
      },
    },
  };
});
