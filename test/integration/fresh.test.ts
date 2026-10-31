import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { captureBranchSnapshot } from "../../src/fresh.js";
import { NOTICES } from "../../src/notices.js";

const root = mkdtempSync(join(tmpdir(), "fresh-fresh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function parseJsonl(file: string): Record<string, any>[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

function sessionFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => join(dir, f));
}

const STATIC_HEADER = "Previous session (complete, verbatim record):";

describe("/fresh full path", () => {
	it("manual /fresh regenerates the static part without file lists", async () => {
		const sessionDir = join(root, "manual");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "ok" }, { text: "ok2" }],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("small task");
			await s.session.prompt("/fresh");
			await waitFor(() => sessionFiles(sessionDir).length >= 2);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			const entries = parseJsonl(fresh);
			expect(entries[0].parentSession).toBe(oldFile);
			const firstUser = entries.find((e: Record<string, any>) => e.type === "message" && e.message.role === "user");
			const prompt = JSON.stringify(firstUser?.message.content);
			expect(prompt).toContain(STATIC_HEADER);
			expect(prompt).toContain("small task"); // volatile: last user message
			expect(prompt).not.toMatch(/Files (read|modified):\n- /); // manual regeneration omits the file lists
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("drains queued input before the switch", async () => {
		const sessionDir = join(root, "drain");
		const s = await createTestSession({
			sessionDir,
			turns: [
				{
					text: `${"working on it ".repeat(800)}`,
					toolCalls: [{ name: "bash", args: { command: "echo hi" } }],
				},
				{ text: "drained reply" },
			],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			// queue a follow-up while the run is streaming: /fresh must drain it first
			const runDone = s.session
				.prompt("do the big task", { streamingBehavior: "followUp" } as never)
				.catch(() => {});
			await new Promise((r) => setTimeout(r, 150));
			await s.session.prompt("queued question", { streamingBehavior: "followUp" } as never).catch(() => {});
			await runDone;
			await waitFor(() => sessionFiles(sessionDir).length >= 2, 20_000);

			const entries = parseJsonl(oldFile);
			const texts = JSON.stringify(entries);
			expect(texts).toContain("queued question"); // delivered and persisted before the switch
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			expect(parseJsonl(fresh)[0].parentSession).toBe(oldFile);
		} finally {
			await s.dispose();
		}
	}, 45_000);

	it("a session_before_switch cancellation stays on pointer mode with exactly one cleared record", async () => {
		const sessionDir = join(root, "cancelled");
		const canceller = (pi: any) => {
			pi.on("session_before_switch", () => ({ cancel: true }));
		};
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "x".repeat(4000) }, { text: "ok" }],
			extensions: [freshExtension, canceller],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("fill it up").catch(() => {});
			await new Promise((r) => setTimeout(r, 1_500));
			if (sessionFiles(sessionDir).length < 2) {
				await s.session.prompt("again").catch(() => {});
			}
			await waitFor(() => {
				const recs = parseJsonl(oldFile).filter(
					(e: Record<string, any>) => e.type === "custom" && e.customType === "fresh-session-switch",
				);
				return recs.some((r) => r.data?.state === "cleared");
			}, 15_000);
			// no fresh session ever appeared
			await new Promise((r) => setTimeout(r, 800));
			expect(sessionFiles(sessionDir).filter((f) => f !== oldFile)).toHaveLength(0);
			expect(s.notices).toContain(NOTICES.switchCancelled());
		} finally {
			await s.dispose();
		}
	}, 45_000);

	it("a fresh first-turn failure reports switched-but-continuation-failed", async () => {
		const sessionDir = join(root, "failed-turn");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "y".repeat(12_000) }, { error: "boom: provider down" }],
			extensions: [freshExtension],
		});
		try {
			await s.session.prompt("fill it").catch(() => {});
			await waitFor(
				() => s.notices.some((n) => n.includes("switched, but continuation failed")),
				20_000,
			);
			expect(s.notices.join("\n")).toContain("boom: provider down");
		} finally {
			await s.dispose();
		}
	}, 45_000);

	it("poll expiry falls back to the pre-trigger message with the newestPrompt notice", async () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "message", id: "u1", parentId: null, timestamp: "2026-10-30T10:00:00Z", message: { role: "user", content: "old prompt", timestamp: 1 } },
					{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-30T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "mid" }], timestamp: 2 } },
				],
			},
			signal: new AbortController().signal, // streaming: a newest prompt is expected
			ui: { notify: () => {} },
		} as never;
		const { volatile, notice } = await captureBranchSnapshot(ctx as never, 60);
		expect(volatile.lastUserMessage).toBe("old prompt");
		expect(notice).toBe(NOTICES.newestPrompt());
	});

	it("a quiet branch captures without polling or notice", async () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "message", id: "u1", parentId: null, timestamp: "2026-10-30T10:00:00Z", message: { role: "user", content: "the task", timestamp: 1 } },
					{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-30T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "step done" }], timestamp: 2 } },
				],
			},
			signal: undefined,
		} as never;
		const { volatile, notice } = await captureBranchSnapshot(ctx as never);
		expect(volatile.lastUserMessage).toBe("the task");
		expect(volatile.anchor.lastAssistantText).toBe("step done");
		expect(notice).toBeUndefined();
	});
});
