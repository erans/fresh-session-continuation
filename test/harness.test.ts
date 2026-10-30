import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "./harness/session.js";

const root = mkdtempSync(join(tmpdir(), "fresh-harness-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("harness", () => {
  it("prompts the scripted fake model and persists the session", async () => {
    const sessionDir = join(root, "sessions");
    const s = await createTestSession({
      sessionDir,
      turns: [{ text: "hello there" }],
    });
    try {
      await s.session.prompt("start");
      expect(s.session.getLastAssistantText()).toBe("hello there");

      const file = s.sessionFile();
      expect(file).toBeTruthy();
      expect(file.startsWith(sessionDir)).toBe(true);

      const roles = s.readEntries()
        .map((e) => (e.type === "message" ? e.message.role : e.type));
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    } finally {
      await s.dispose();
    }
  });

  it("records every fake model call", async () => {
    const s = await createTestSession({
      sessionDir: join(root, "sessions-2"),
      turns: [{ text: "one" }, { text: "two" }],
    });
    try {
      await s.session.prompt("go");
      expect(s.getCalls().length).toBeGreaterThanOrEqual(1);
      expect(s.getCalls()[0]).toHaveProperty("turn");
    } finally {
      await s.dispose();
    }
  });
});
