import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// У проді SPA роздає сам blackgate з admin-слухача (порт 3001, dist/ → /app/web
// в образі). Проксі — лише для `npm run dev` поруч із живим процесом.
//
// Tailwind 4 — плагіном Vite, без postcss і tailwind.config: тема живе в
// @exo/kit-ui/tokens.css, його імпортує src/styles.css (канон filebrowser).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/admin/api': 'http://localhost:3001' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Мапи вихідного коду в образ не їдуть: панель — не бібліотека, а
    // зайві мегабайти в рантаймі нікому не допомагають.
    sourcemap: false,
  },
});
