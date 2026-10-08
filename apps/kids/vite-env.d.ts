/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_CHILD?: string;
  /** "1" = the home-network build: the device's IP decides the child (no pairing). */
  readonly VITE_LOCAL_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
