import { defineConfig } from 'vite';

// `npm run dev` proxies the API to a backend running on the host (docker compose publishes it on 8081)
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8081' },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
