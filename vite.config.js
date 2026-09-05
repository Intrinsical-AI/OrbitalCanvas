import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    open: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
