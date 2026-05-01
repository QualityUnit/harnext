import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  // Ship the PII masker daemon next to the bundle so masker.ts can resolve
  // it via `import.meta.url` at runtime.
  onSuccess: 'cp src/pii/pii-masker.py dist/pii-masker.py',
});
