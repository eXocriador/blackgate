import { defineConfig } from 'vitest/config';

// Окремо від vite.config.ts: vitest 2 несе власний vite 5, і плагіни vite 6 з
// ним не сумісні за типами. Тестам Tailwind не потрібен, а JSX esbuild збирає сам.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
