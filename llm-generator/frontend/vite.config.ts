import { defineConfig } from 'vite';

// `npm run dev` proxies the API to the backend published on the host (docker compose: 8111)
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8111' },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
