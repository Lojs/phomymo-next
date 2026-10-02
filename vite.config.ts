import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  // The About dialog shows the running version, so bumping package.json is the only
  // step a release needs. It stays in English even in the Arabic UI: "v1.0.2" is a
  // version number, not a word, and needs no RTL marker to read correctly.
  envPrefix: ['VITE_', 'APP_'],
  define: { 'import.meta.env.APP_VERSION': JSON.stringify(pkg.version) },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});