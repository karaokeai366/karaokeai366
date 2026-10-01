/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_MEDIA_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
