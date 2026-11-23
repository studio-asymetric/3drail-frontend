import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';


/**
 * The public address of the site, used for the canonical link, social cards, structured data,
 * robots.txt and the sitemap. Set VITE_SITE_URL when building for another domain.
 */
const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://mojvlak.sk').replace(/\/+$/, '');

function seoPlugin(): Plugin {
  return {
    name: 'seo-site-url',
    transformIndexHtml: (html) => html.split('%SITE_URL%').join(SITE_URL),
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: [
          'User-agent: *',
          'Allow: /',
          'Disallow: /proxy/',
          'Disallow: /api/',
          '',
          `Sitemap: ${SITE_URL}/sitemap.xml`,
          '',
        ].join('\n'),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/pid</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE_URL}/jmk</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), seoPlugin()],
  build: {
    rollupOptions: {
      output: {
        // Libraries in their own files: cached across deploys and downloaded in parallel.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    // The proxy rewrites these every few seconds; watching them keeps Vite busy.
    watch: {
      ignored: ['**/proxy/*.json', '**/proxy/*.log', '**/proxy/osm-cache/**', '**/region-data/**', '**/dist/**', '**/.claude/**'],
    },
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
        // PROXY_TARGET lets a second dev server talk to a second proxy (testing a new proxy build).
        target: process.env.PROXY_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
