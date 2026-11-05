import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Testes das regras de negócio puras (src/app/core) e de equivalência entre o motor
 * e os geradores (tests/equivalence). Rodam em Node, sem Angular, o que permite usar
 * `typescript` e `javac` de verdade. Os specs de componentes rodam com `ng test`.
 */
export default defineConfig({
  plugins: [
    {
      // Equivale ao loader `.txt` configurado no angular.json.
      name: 'mapforge-text-loader',
      enforce: 'pre',
      load(id: string) {
        const file = id.split('?')[0];
        if (!file.endsWith('.txt')) return null;
        return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/app/core/**/*.spec.ts', 'tests/equivalence/**/*.spec.ts'],
    testTimeout: 300_000,
  },
});
