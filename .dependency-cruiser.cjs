/**
 * 依赖方向强制(architecture.html 依赖矩阵):
 *   app → { engine, director, tts-bridge, shared }
 *   engine / director / tts-bridge 互不依赖,各自只准向下到 shared(+同包内部互引)
 *   shared → 无内部依赖;任何包不得 import app
 * 违规即 `pnpm depcruise` 退出非零(CI 门禁)。
 * 注:TS7 下 dependency-cruiser 不能用 tsConfig/目录扫描,pattern 一律传 glob
 * (packages 星号斜杠 src 双星 ts 的形式,见根 package.json 的 depcruise script)。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-不得依赖任何-gal-包",
      severity: "error",
      comment: "shared 是最底层:只依赖外部库(zod)",
      from: { path: "^packages/shared" },
      to: { dependencyTypes: ["local"], path: "^packages/(engine|director|tts-bridge|app)" },
    },
    {
      name: "engine-不得依赖同级包或 app",
      severity: "error",
      comment: "engine 只准向下到 shared(端口解耦);同包内部互引合法",
      from: { path: "^packages/engine" },
      to: { dependencyTypes: ["local"], path: "^packages/(director|tts-bridge|app)" },
    },
    {
      name: "director-不得依赖同级包或 app",
      severity: "error",
      comment: "director 只准向下到 shared;LLM 具体实现经 LlmClient 端口注入",
      from: { path: "^packages/director" },
      to: { dependencyTypes: ["local"], path: "^packages/(engine|tts-bridge|app)" },
    },
    {
      name: "tts-bridge-不得依赖同级包或 app",
      severity: "error",
      comment: "tts-bridge 只准向下到 shared;TTS 实现经 TtsProvider 端口注入",
      from: { path: "^packages/tts-bridge" },
      to: { dependencyTypes: ["local"], path: "^packages/(engine|director|app)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js", ".mjs"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
