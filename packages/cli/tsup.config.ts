import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  noExternal: [/@harnext\/core/],
  external: ['@modelcontextprotocol/sdk', 'cross-spawn'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
