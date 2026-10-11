import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: './compile_inputs',
        include: ['src/**/*.test.ts'],
        globals: true,
        environment: 'node',
        maxWorkers: 1,
        hookTimeout: 30000,
        testTimeout: 30000,
    },
});
