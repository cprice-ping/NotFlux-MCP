/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PINGONE_ENV_ID?: string;
  readonly VITE_PINGONE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
