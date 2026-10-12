/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** TTS 参考音频绝对路径(服务端本机可读;非机密,经 dev proxy 使用) */
  readonly VITE_TTS_REF_PATH?: string;
  readonly VITE_TTS_PROMPT_TEXT?: string;
}
