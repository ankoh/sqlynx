import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.smoke.ts"],
        testTimeout: 600000,
        hookTimeout: 600000,
    },
});
