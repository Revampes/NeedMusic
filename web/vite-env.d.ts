/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Your Google Cloud OAuth Web CLIENT_ID (see docs/google-drive-sync.md). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
