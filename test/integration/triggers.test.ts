import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { registerCompactionHook } from "../../src/hook.js";
import { createSwitchState } from "../../src/state.js";
import { NOTICES } from "../../src/notices.js";
import { SessionBuilder } from "../fixtures/builder.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "fresh-triggers-"));
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

const OVERFLOW_ERROR = "maximum context length is 2000 tokens, however you requested 2500 tokens";
const STATIC_HEADER = "Previous session (complete, verbatim record):";

describe("automatic triggers", () => {
	it("crosses the threshold at the run boundary and switches", async () => {
		const sessionDir = join(root, "run-boundary");
		const s = await createTestSession({
			sessionDir,
			// one huge turn: the run ends over-threshold, so the post-run check compacts
			turns: [{ text: "z".repeat(9_000) }],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("one big turn");
			await waitFor(() => sessionFiles(sessionDir).length >= 2, 15_000);
			const entries = parseJsonl(oldFile);
			expect(entries.some((e) => e.type === "compaction")).toBe(true);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			expect(parseJsonl(fresh)[0].parentSession).toBe(oldFile);
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("recovers from a context overflow with the pointer compaction and switches", async () => {
		const sessionDir = join(root, "overflow");
		const s = await createTestSession({
			sessionDir,
			turns: [
				{ error: OVERFLOW_ERROR },
				{ text: "recovered after overflow" },
			],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("overflow me");
			await waitFor(() => sessionFiles(sessionDir).length >= 2, 15_000);
			const entries = parseJsonl(oldFile);
			const compaction = entries.find((e) => e.type === "compaction");
			expect(compaction).toBeTruthy();
			expect(compaction!.summary.startsWith(STATIC_HEADER)).toBe(true);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			expect(parseJsonl(fresh)[0].parentSession).toBe(oldFile);
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("deep mid-run: fresh session anchors progress, recall is registered and verbatim, no tool call repeated", async () => {
		const sessionDir = join(root, "deep-mid-run");
		// ~12 turns of medium tool traffic: the threshold crosses mid-run
		const turns: import("../harness/model.js").TurnScript[] = Array.from({ length: 12 }, (_, i) => ({
			text: `step ${i} done `.repeat(200),
			toolCalls: [{ name: "bash", args: { command: `echo step-${i}` } }],
		}));
		// the fresh session's first turn proves recall is registered by calling it
		turns.push({ toolCalls: [{ name: "recall", args: { tail: 40 } }] });
		turns.push({ text: "all recalled" });
		const s = await createTestSession({
			sessionDir,
			// big enough that the fresh session (pointer prompt + system) never re-crosses
			contextWindow: 8_000,
			turns: turns as never,
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("do all the steps");
			await waitFor(() => sessionFiles(sessionDir).length >= 2, 20_000);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			// the fresh session's scripted turns end with "all recalled": wait for run completion
			await waitFor(
				() =>
					parseJsonl(fresh).some(
						(e: Record<string, any>) =>
							e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes("all recalled"),
					),
				20_000,
			);

			// every step ran exactly once in the old session, none in the fresh one
			const oldText = parseJsonl(oldFile)
				.filter((e) => e.type === "message" && e.message.role === "assistant")
				.map((e) => JSON.stringify(e.message.content))
				.join("");
			const freshText = parseJsonl(fresh)
				.filter((e) => e.type === "message" && e.message.role === "assistant")
				.map((e) => JSON.stringify(e.message.content))
				.join("");
			const stepsRun = [...oldText.matchAll(/echo step-(\d+)/g)].map((m) => Number(m[1]));
			const distinct = [...new Set(stepsRun)];
			expect(distinct.length).toBeGreaterThanOrEqual(2); // real progress before the switch
			expect(stepsRun).toHaveLength(distinct.length); // each exactly once

			// the fresh session's continuation model call received the pointer prompt
			const pointerCall = s.getCalls().find((c) => (c.firstUser ?? "").includes(STATIC_HEADER));
			expect(pointerCall).toBeTruthy();
			expect(pointerCall!.firstUser).toMatch(/Last assistant progress: step \d+ done/);

			// the fresh prompt carries the progress anchor: the last pre-switch assistant text
			const firstUser = parseJsonl(fresh).find(
				(e: Record<string, any>) => e.type === "message" && e.message.role === "user",
			);
			const prompt = JSON.stringify(firstUser?.message.content);
			expect(prompt).toContain(STATIC_HEADER);
			expect(prompt).toMatch(/Last assistant progress: step \d+ done/);

			// recall really executed after the compaction: some toolResult in the chain
			// holds the old session's tail verbatim (which file it ran in is timing)
			const allFiles = sessionFiles(sessionDir);
			const recallResults = allFiles
				.flatMap((f) =>
					parseJsonl(f).filter(
						(e: Record<string, any>) => e.type === "message" && e.message.role === "toolResult",
					),
				)
				.map((e) => JSON.stringify(e.message.content));
			const text = recallResults.find((t) => t.includes("do all the steps"));
			expect(text).toBeTruthy();
			expect(text).toContain("step 0 done"); // the old record's verbatim step text
		} finally {
			await s.dispose();
		}
	}, 45_000);
});

describe("manual compaction contracts", () => {
	it("bare manual compaction keeps pi's cut and never switches", async () => {
		const sessionDir = join(root, "manual-bare");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "first reply" }, { text: "second reply" }],
			extensions: [freshExtension],
			contextWindow: 100_000,
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("a task worth keeping tail of");
			await s.session.prompt("second turn to keep"); // two turns: the cut keeps the last, summarizes the first
			await s.session.compact();
			await new Promise((r) => setTimeout(r, 500));
			const entries = parseJsonl(oldFile);
			const compaction = entries.find((e: Record<string, any>) => e.type === "compaction");
			expect(compaction).toBeTruthy();
			expect(compaction!.summary.startsWith(STATIC_HEADER)).toBe(true);
			expect(compaction!.firstKeptEntryId).toBeTruthy();
			expect(compaction!.firstKeptEntryId).not.toBe(compaction!.id); // a real cut, not retain-none
			// retained tail visible after the compaction
			expect(s.session.sessionManager.getBranch().length).toBeGreaterThan(0);
			// no switch, no state records
			expect(sessionFiles(sessionDir)).toHaveLength(1);
			expect(entries.some((e) => e.type === "custom" && e.customType === "fresh-session-switch")).toBe(false);
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("manual compaction with instructions uses the default LLM summary and never switches", async () => {
		const sessionDir = join(root, "manual-instr");
		const s = await createTestSession({
			sessionDir,
			turns: [
				{ text: "first reply ".repeat(20) },
				{ text: "second reply ".repeat(20) },
				{ text: "a crisp default summary" },
			],
			extensions: [freshExtension],
			contextWindow: 100_000,
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("some work worth summarizing");
			await s.session.prompt("more work also worth summarizing");
			await s.session.compact("focus on the API work");
			await new Promise((r) => setTimeout(r, 500));
			const entries = parseJsonl(oldFile);
			const compaction = entries.find((e: Record<string, any>) => e.type === "compaction");
			expect(compaction).toBeTruthy();
			expect(compaction!.summary).toContain("a crisp default summary"); // the model's summary, not the pointer
			expect(compaction!.summary.startsWith(STATIC_HEADER)).toBe(false);
			expect(sessionFiles(sessionDir)).toHaveLength(1);
			expect(entries.some((e) => e.type === "custom" && e.customType === "fresh-session-switch")).toBe(false);
		} finally {
			await s.dispose();
		}
	}, 30_000);
});

describe("compaction-disabled and in-flight contracts", () => {
	it("warns once when compaction is disabled and keeps working", async () => {
		const sessionDir = join(root, "disabled");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
			compactionEnabled: false,
		});
		try {
			await s.session.prompt("hello");
			await s.session.reload(); // second session_start: the notice must not repeat
			await s.session.prompt("again");
			const disabledNotices = s.notices.filter((n) => n === NOTICES.compactionDisabled());
			expect(disabledNotices.length).toBe(1); // once, not per prompt
			expect(s.notices.join("\n")).not.toContain("degraded"); // no dead-end noise
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("refreshes an in-flight payload on a second confirming compaction, without a second dispatch", async () => {
		const handlers: Record<string, ((...a: any[]) => any)[]> = {};
		const appendCalls: unknown[] = [];
		const pi = {
			on: (name: string, h: (...a: any[]) => any) => {
				(handlers[name] ??= []).push(h);
			},
			sendUserMessage: vi.fn(),
			appendEntry: (...a: unknown[]) => {
				appendCalls.push(a);
			},
		} as unknown as ExtensionAPI;
		const st = createSwitchState();
		registerCompactionHook(pi, st);

		// a real session file: the hook's renderer must reach its non-minimal path
		const sessionDir = join(root, "in-flight-unit");
		const file = new SessionBuilder(sessionDir, "unit.jsonl").user("u1", "hello task").write();
		const sessionManager = SessionManager.open(file, undefined, sessionDir);
		const ctx = {
			sessionManager: {
				getSessionFile: () => file,
				getSessionDir: () => sessionDir,
				getBranch: () => sessionManager.getBranch(),
			},
			ui: { notify: () => {} },
			mode: "rpc",
		};
		const before = handlers["session_before_compact"];
		expect(before).toBeTruthy();

		// first compaction: arms and queues one dispatch
		await before![0](
			{
				reason: "threshold",
				preparation: { firstKeptEntryId: "kept", tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			},
			ctx,
		);
		await handlers["session_compact"][0](
			{ fromExtension: true, reason: "threshold", compactionEntry: { summary: "does-not-match" } },
			ctx,
		);
		expect(st.getState()).toBe("idle"); // summary mismatch: no arming

		// make the hook's summary observable, then confirm
		const result = await before![0](
			{
				reason: "threshold",
				preparation: { firstKeptEntryId: "kept", tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			},
			ctx,
		);
		const summary = result!.compaction!.summary;
		await handlers["session_compact"][0](
			{ fromExtension: true, reason: "threshold", compactionEntry: { summary } },
			ctx,
		);
		expect(st.getState()).toBe("armed");

		// in-flight: a second confirming compaction refreshes, never re-arms —
		// and appends no second armed record: the recovery window never slides
		const armedRecordsBefore = appendCalls.length;
		st.toInFlight();
		const second = await before![0](
			{
				reason: "threshold",
				preparation: { firstKeptEntryId: "kept", tokensBefore: 100, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			},
			ctx,
		);
		await handlers["session_compact"][0](
			{ fromExtension: true, reason: "threshold", compactionEntry: { summary: second!.compaction!.summary } },
			ctx,
		);
		expect(st.getState()).toBe("in-flight"); // still the same switch
		expect(st.getPayload()?.pointerTextStatic).toContain(second!.compaction!.summary.split("\n")[0]);
		expect(appendCalls).toHaveLength(armedRecordsBefore); // process-local refresh only (M1)
		expect((pi as any).sendUserMessage).not.toHaveBeenCalled(); // dispatch goes through the queue, not directly

		// session_compact_failed disarms an armed (not in-flight) switch
		st.toIdle();
		st.arm({ oldSessionPath: "/old/session.jsonl", pointerTextStatic: "s" });
		await handlers["session_compact_failed"][0]({}, ctx);
		expect(st.getState()).toBe("idle");
	});
});
