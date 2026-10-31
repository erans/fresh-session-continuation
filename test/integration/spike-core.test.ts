import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { STATE_RECORD_TYPE } from "../../src/notices.js";

const STATIC_HEADER = "Previous session (complete, verbatim record):";

const root = mkdtempSync(join(tmpdir(), "fresh-spike-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function parseJsonl(file: string): Record<string, any>[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 50): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

function sessionFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => join(dir, f));
}

describe("spike: core mechanism", () => {
	it("threshold → pointer compaction → automatic switch to a fresh session", async () => {
		const sessionDir = join(root, "core");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "work done ".repeat(600) }, { text: "fresh reply" }],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("do the thing").catch(() => {});
			// The post-run check may fire immediately; if it does not, the next
			// prompt's pre-prompt check does. Tolerate either ordering.
			await new Promise((r) => setTimeout(r, 1_500));
			if (sessionFiles(sessionDir).length < 2) {
				await s.session.prompt("do the thing again").catch(() => {});
			}

			await waitFor(() => sessionFiles(sessionDir).length >= 2);

			// The old session holds a retain-none pointer compaction whose summary is
			// our static text plus the task — never an LLM summary.
			const compaction = parseJsonl(oldFile).find((e) => e.type === "compaction");
			expect(compaction).toBeTruthy();
			expect(compaction!.summary.startsWith(STATIC_HEADER)).toBe(true);
			expect(compaction!.summary).toContain(oldFile);
			expect(compaction!.summary).toContain("do the thing");
			expect(compaction!.firstKeptEntryId).toBe(compaction!.id);

			// Exactly one fresh session, parented at the old one.
			const fresh = sessionFiles(sessionDir).filter((f) => f !== oldFile);
			expect(fresh.length).toBe(1);
			const freshEntries = parseJsonl(fresh[0]);
			expect(freshEntries[0].type).toBe("session");
			expect(freshEntries[0].parentSession).toBe(oldFile);

			// The pointer prompt is the fresh session's first user message.
			const firstUser = freshEntries.find(
				(e) => e.type === "message" && e.message.role === "user",
			);
			expect(JSON.stringify(firstUser?.message.content)).toContain(STATIC_HEADER);
			expect(JSON.stringify(firstUser?.message.content)).toContain("do the thing");

			// The fresh session's first turn runs by itself.
			await waitFor(() =>
				parseJsonl(fresh[0]).some(
					(e) => e.type === "message" && e.message.role === "assistant",
				),
			);
			const freshAssistant = parseJsonl(fresh[0]).find(
				(e) => e.type === "message" && e.message.role === "assistant",
			);
			expect(JSON.stringify(freshAssistant?.message.content)).toContain("fresh reply");
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("restart recovery: an armed record re-arms and dispatches exactly one /fresh", async () => {
		const sessionDir = join(root, "recovery");
		const crafted = join(sessionDir, "crafted.jsonl");
		const now = new Date().toISOString();
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "spike-recovery-1", timestamp: now, cwd: sessionDir }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: now,
				message: { role: "user", content: "hello task", timestamp: Date.now() },
			}),
			JSON.stringify({
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: now,
				summary: `Previous session (complete, verbatim record): ${crafted}\nlast user message: hello task`,
				firstKeptEntryId: "c1",
				tokensBefore: 1,
			}),
			JSON.stringify({
				type: "custom",
				id: "r1",
				parentId: "c1",
				timestamp: now,
				customType: STATE_RECORD_TYPE,
				data: {
					state: "armed",
					owner: crafted,
					oldSessionPath: crafted,
					pointerTextStatic: "RECOVERY-STATIC-XYZ",
					armedAt: Date.now(),
				},
			}),
		].join("\n");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(sessionDir, { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(crafted, content + "\n");

		const s = await createTestSession({
			sessionDir,
			openSessionFile: crafted,
			turns: [{ text: "recovered reply" }],
			extensions: [freshExtension],
		});
		try {
			await waitFor(() => sessionFiles(sessionDir).length >= 2);

			const fresh = sessionFiles(sessionDir).filter((f) => f !== crafted);
			expect(fresh.length).toBe(1);
			const freshEntries = parseJsonl(fresh[0]);
			expect(freshEntries[0].parentSession).toBe(crafted);

			const firstUser = freshEntries.find(
				(e) => e.type === "message" && e.message.role === "user",
			);
			const prompt = JSON.stringify(firstUser?.message.content);
			// persisted static text, unchanged, plus exactly one rebuilt volatile block
			expect(prompt).toContain("RECOVERY-STATIC-XYZ");
			expect(prompt).toContain("hello task");
		} finally {
			await s.dispose();
		}
	}, 30_000);
});
