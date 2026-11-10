import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://mapa.zsr.sk',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path, // Keep the path as-is (/api/action.html -> https://mapa.zsr.sk/api/action.html)
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.error('❌ Proxy error:', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            const forwardedCookie = req.headers['x-mapa-cookies'];
            if (forwardedCookie) {
              proxyReq.setHeader('Cookie', forwardedCookie as string);
            }
          });
        },
      },
      '/action.html': {
        target: 'https://mapa.zsr.sk',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path,
      },
      '/action': {
        target: 'https://mapa.zsr.sk',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path,
      },
      '/proxy': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0,
        rewrite: (path) => path.replace(/^\/proxy\/?/, '/') || '/',
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
