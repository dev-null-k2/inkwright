import { defineConfig } from 'vitest/config';

// One test run for the whole monorepo. Each package declares its own project so failures are
// reported per package; `npm test` runs everything, `npx vitest --project core` one package.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'ai', include: ['packages/ai/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'sync', include: ['packages/sync/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'mcp', include: ['apps/mcp-server/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'web', include: ['apps/web/src/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['apps/web/src/test/setup.ts'] } },
      { test: { name: 'platform', include: ['packages/plugin-api/test/**/*.test.ts', 'packages/sdk/test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'evals', include: ['packages/*/evals/**/*.eval.ts'], environment: 'node', testTimeout: 120000 } },
    ],
  },
});
