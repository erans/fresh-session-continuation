import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { NOTICES, STATE_RECORD_TYPE } from "../../src/notices.js";

const root = mkdtempSync(join(tmpdir(), "fresh-modes-"));
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

describe("notice table audit (spec-exact strings)", () => {
	it("every notice matches the spec's table verbatim", () => {
		expect(NOTICES.switch("<new>", "<old>")).toBe(
			"Context full → fresh session <new> (previous session preserved: <old>)",
		);
		expect(NOTICES.degraded("boom")).toBe(
			"Switch to a fresh session did not land; continuing with recall on pointer context (boom)",
		);
		expect(NOTICES.degraded(undefined)).toBe(
			"Switch to a fresh session did not land; continuing with recall on pointer context (the switch was not dispatched)",
		);
		expect(NOTICES.treeCancelled()).toBe("fresh-session switch cancelled by tree navigation");
		expect(NOTICES.switchCancelled()).toBe("fresh-session switch cancelled by session_before_switch");
		expect(NOTICES.preflight("old session file readable")).toBe(
			"pre-flight failed (old session file readable); staying on pointer context — the run is safe",
		);
		expect(NOTICES.imagesCapped(2)).toBe("last message images capped at 2; use recall { tail } for the rest");
		expect(NOTICES.inProgress()).toBe("a switch is already in progress");
		expect(NOTICES.inputLost()).toBe(
			"input submitted during the switch was not delivered and is not in the record; re-send if needed",
		);
		expect(NOTICES.continuationFailed("boom")).toBe("switched, but continuation failed (boom)");
		expect(NOTICES.newestPrompt()).toBe("newest prompt not yet persisted; re-read it with recall { tail }");
		expect(NOTICES.notPersisted()).toBe(
			"Session is not persisted (--no-session): recall unavailable; default compaction used",
		);
		expect(NOTICES.minimalPointer("bad ancestor")).toBe(
			"Pointer built from partial data (bad ancestor); recall the record for anything missing",
		);
		expect(NOTICES.compactionDisabled()).toBe(
			"automatic fresh-session continuation requires the compaction machinery enabled (the default)",
		);
		expect(STATE_RECORD_TYPE).toBe("fresh-session-switch");
	});
});

describe("entry renderer", () => {
	it("registers the divider renderer for the state records", async () => {
		let registeredType: string | undefined;
		let renderer: ((...a: unknown[]) => unknown) | undefined;
		const pi = {
			registerEntryRenderer: (t: string, r: (...a: unknown[]) => unknown) => {
				registeredType = t;
				renderer = r;
			},
		} as never;
		(await import("../../src/tui.js")).registerTui(pi);
		expect(registeredType).toBe(STATE_RECORD_TYPE);
		const component = (renderer as (...a: unknown[]) => unknown)(
			{ data: { state: "armed", owner: "x", oldSessionPath: "x", pointerTextStatic: "s", armedAt: 1 } },
			{ expanded: false },
			{ fg: (color: string, text: string) => text },
		);
		expect(component).toBeTruthy();
	});
});

describe("modes", () => {
	it.each(["print", "json"] as const)(
		"%s mode: pointer compaction lands, no dispatch, no degraded notice; a later rpc resume dispatches",
		async (mode) => {
			const sessionDir = join(root, mode);
			const s = await createTestSession({
				sessionDir,
				mode,
				turns: [{ text: "p".repeat(9_000) }, { text: "ok" }],
				extensions: [freshExtension],
			});
			try {
				const oldFile = s.sessionFile();
				await s.session.prompt("fill it up");
				await waitFor(() =>
					parseJsonl(oldFile).some((e) => e.type === "compaction"),
				);
				await new Promise((r) => setTimeout(r, 1_500));

				// pointer compaction landed with the pointer summary
				const compaction = parseJsonl(oldFile).find((e) => e.type === "compaction")!;
				expect(compaction.summary.startsWith("Previous session (complete, verbatim record):")).toBe(true);
				// armed record persisted (crash-safety) but nothing dispatched
				const records = parseJsonl(oldFile).filter(
					(e) => e.type === "custom" && e.customType === STATE_RECORD_TYPE,
				);
				expect(records.some((r) => r.data.state === "armed")).toBe(true);
				expect(sessionFiles(sessionDir)).toHaveLength(1); // no fresh session
				// no spurious degraded / never-dispatched notice
				expect(s.notices.join("\n")).not.toContain("did not land");
			} finally {
				await s.dispose();
			}

			// resume the same file in rpc mode inside the window: exactly one dispatch
			const armed = sessionFiles(sessionDir)[0];
			const s2 = await createTestSession({
				sessionDir,
				mode: "rpc",
				openSessionFile: armed,
				turns: [{ text: "rpc resume reply" }],
				extensions: [freshExtension],
			});
			try {
				await waitFor(() => sessionFiles(sessionDir).length >= 2, 15_000);
				const fresh = sessionFiles(sessionDir).find((f) => f !== armed)!;
				expect(parseJsonl(fresh)[0].parentSession).toBe(armed);
				expect(s2.notices.join("\n")).not.toContain("did not land");
			} finally {
				await s2.dispose();
			}
		},
		45_000,
	);

	it("rpc mode works headlessly (no UI): the automatic switch still lands", async () => {
		const sessionDir = join(root, "headless");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "h".repeat(9_000) }, { text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			// the harness UI stub has no hasUI: every notice is a captured no-op
			await s.session.prompt("headless run");
			await waitFor(() => sessionFiles(sessionDir).length >= 2, 15_000);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			expect(parseJsonl(fresh)[0].parentSession).toBe(oldFile);
		} finally {
			await s.dispose();
		}
	}, 30_000);
});
