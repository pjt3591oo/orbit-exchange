import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@orbit/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      // Borrow web's design tokens / atoms so admin looks like a sibling app.
      '@orbit/web/design': path.resolve(__dirname, '../web/src/design'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      // Admin REST → apps/api (admin routes live under /api/v1/admin/*)
      '/api': 'http://localhost:3000',
    },
  },
});
