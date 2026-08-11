import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
const unsupportedMermaidDiagram = decodeURIComponent(new URL('./src/lib/markdown/unsupported-mermaid-diagram.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:\/)/, '$1');

export default defineConfig({
  root: webRoot,
  // Public is reserved for governed runtime assets such as large 3D models.
  // Legacy handwritten SPA entry files remain forbidden by the Phase 5 tests.
  publicDir: 'public',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^\.\/mindmap-definition-[^/]+\.js$/, replacement: unsupportedMermaidDiagram },
      { find: /^\.\/flowchart-elk-definition-[^/]+\.js$/, replacement: unsupportedMermaidDiagram }
    ]
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'react-assets',
    // Vite 仅支持全局告警阈值；普通 chunk 仍由 test-web-phase5.js 执行 500 KiB 硬门。
    chunkSizeWarningLimit: 768,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three-core';
          return undefined;
        }
      }
    }
  }
});
