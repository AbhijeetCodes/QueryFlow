import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at a domain root or under a
  // sub-path such as https://<user>.github.io/QueryFlow/.
  base: './',
  server: { port: 5199, open: false },
  optimizeDeps: { entries: ['index.html'] },
  build: { target: 'es2022' },
});
