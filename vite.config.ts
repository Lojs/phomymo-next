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
  test: {
    // Pure-logic tests run in plain node (fast, no DOM). Component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, and use the .dom.test.tsx suffix so the include
    // pattern picks them up.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/main.tsx',          // entry point
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        'src/transport/webapis.d.ts',
      ],
      // A single global figure hides which layer is thin, so per-file numbers matter here.
      reporter: ['text-summary', 'text'],
      thresholds: {
        // The suite is at 80% statements today; hold the line rather than let it slide.
        statements: 80,
        branches: 70,
        functions: 75,
        lines: 80,
      },
    },
  },
});