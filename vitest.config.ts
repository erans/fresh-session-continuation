import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        inline: [
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-ai",
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-codemode",
          "@earendil-works/pi-mcp",
          "@earendil-works/pi-tui",
        ],
      },
    },
  },
});
