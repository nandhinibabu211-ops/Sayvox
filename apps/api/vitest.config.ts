import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] },
      },
      {
        // Needs Docker (testcontainers starts Postgres 16 + Redis 7).
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
