/// <reference types="vite/client" />

/**
 * Injected at build time from package.json (see vite.config.ts) — bumping
 * package.json is the only step a release needs.
 */
interface ImportMetaEnv {
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}