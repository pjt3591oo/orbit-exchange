import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@orbit/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // HTTP → apps/api
      '/api': 'http://localhost:3000',
      // WebSocket → apps/realtime (split out of api into its own service)
      '/socket.io': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
