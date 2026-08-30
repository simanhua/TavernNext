import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const apiProxyTarget = process.env.TAVERNNEXT_API_PROXY_TARGET ?? 'http://127.0.0.1:4312';
const webHost = process.env.TAVERNNEXT_WEB_HOST ?? '127.0.0.1';
const webPort = Number(process.env.TAVERNNEXT_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
