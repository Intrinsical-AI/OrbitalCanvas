import { defineConfig } from 'vitest/config';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'third-party-notices',
      apply: 'build',
      writeBundle({ dir }) {
        const licenses = join(dir, 'licenses');
        mkdirSync(licenses, { recursive: true });
        for (const [name, dependency] of [
          ['inter-tight', '@fontsource-variable/inter-tight'],
          ['jetbrains-mono', '@fontsource-variable/jetbrains-mono'],
          ['mediabunny', 'mediabunny'],
        ]) {
          copyFileSync(
            new URL(`./node_modules/${dependency}/LICENSE`, import.meta.url),
            join(licenses, `${name}.txt`)
          );
        }
        cpSync(
          new URL('./node_modules/mediabunny/src/', import.meta.url),
          join(licenses, 'mediabunny-src'),
          {
            recursive: true,
          }
        );
      },
    },
  ],
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
