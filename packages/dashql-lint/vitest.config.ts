import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        maxWorkers: 1,
        hookTimeout: 30000,
        testTimeout: 30000,
    },
});
