import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Several unit files build the whole app or open real sockets; under a full parallel
        // `pnpm check` the 5 s default has timed out on a busy machine.
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 20_000 },
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
