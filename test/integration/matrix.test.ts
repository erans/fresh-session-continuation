import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { STATE_RECORD_TYPE, NOTICES } from "../../src/notices.js";

const root = mkdtempSync(join(tmpdir(), "fresh-matrix-"));
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

function stateRecords(file: string) {
	return parseJsonl(file).filter((e) => e.type === "custom" && e.customType === STATE_RECORD_TYPE);
}

/**
 * Craft a session file carrying an armed record (the restart-recovery input):
 * user + assistant turn, pointer compaction, then the armed record. The
 * assistant entry gives /tree an earlier target to navigate to.
 */
/** Append one raw entry to a crafted session file, parented to its current last entry. */
function appendEntry(file: string, entry: Record<string, unknown>): void {
	const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
	const last = JSON.parse(lines[lines.length - 1]) as { id: string };
	lines.push(
		JSON.stringify({
			id: "appended-1",
			parentId: last.id,
			timestamp: new Date().toISOString(),
			...entry,
		}),
	);
	writeFileSync(file, lines.join("\n") + "\n");
}

function craftArmedSession(
	dir: string,
	name: string,
	armedAgeMs: number,
	ownerOverride?: string,
): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	const now = new Date().toISOString();
	const content = [
		JSON.stringify({ type: "session", version: 3, id: name, timestamp: now, cwd: dir }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: "the original task", timestamp: Date.now() },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: now,
			message: { role: "assistant", content: [{ type: "text", text: "mid progress" }], timestamp: Date.now() },
		}),
		JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "m2",
			timestamp: now,
			summary: `Previous session (complete, verbatim record): ${file}\nlast user message: the original task`,
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
				owner: ownerOverride ?? file,
				oldSessionPath: file,
				pointerTextStatic: "MATRIX-STATIC",
				armedAt: Date.now() - armedAgeMs,
			},
		}),
	].join("\n");
	writeFileSync(file, content + "\n");
	return file;
}

describe("exit and recovery matrix", () => {
	it("in-window resume dispatches exactly one switch; an unrelated session stays silent", async () => {
		const sessionDir = join(root, "in-window");
		const armed = craftArmedSession(sessionDir, "armed.jsonl", 5_000);
		const otherDir = join(root, "unrelated");
		mkdirSync(otherDir, { recursive: true });
		const other = join(otherDir, "other.jsonl");
		writeFileSync(
			other,
			[
				JSON.stringify({ type: "session", version: 3, id: "other", timestamp: new Date().toISOString(), cwd: otherDir }),
				JSON.stringify({
					type: "message",
					id: "o1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "unrelated", timestamp: Date.now() },
				}),
			].join("\n") + "\n",
		);

		// the unrelated session: no record, no dispatch, no notices
		const sOther = await createTestSession({
			sessionDir: otherDir,
			openSessionFile: other,
			contextWindow: 100_000,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			await sOther.session.prompt("hello");
			expect(sOther.notices).toHaveLength(0);
			expect(sessionFiles(otherDir)).toHaveLength(1);
		} finally {
			await sOther.dispose();
		}

		// the armed session: exactly one dispatch, one fresh session, no degraded
		const s = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "recovered" }],
			contextWindow: 100_000,
			extensions: [freshExtension],
		});
		try {
			await waitFor(() => sessionFiles(sessionDir).length >= 2);
			const fresh = sessionFiles(sessionDir).find((f) => f !== armed)!;
			const freshEntries = parseJsonl(fresh);
			expect(freshEntries[0].parentSession).toBe(armed);
			expect(parseJsonl(fresh)[0].type).toBe("session");
			expect(s.notices.filter((n) => n === NOTICES.degraded(undefined))).toHaveLength(0);
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("a past-window record degrades once and clears; a second restart stays silent", async () => {
		const sessionDir = join(root, "past-window");
		const armed = craftArmedSession(sessionDir, "armed.jsonl", 120_000);

		// restart 1: past the window — one degraded notice, cleared record, no switch
		const s1 = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
			contextWindow: 100_000,
		});
		try {
			await s1.session.prompt("continue");
			await waitFor(() => stateRecords(armed).some((r) => r.data.state === "cleared"));
			expect(s1.notices).toContain(NOTICES.degraded(undefined));
			expect(s1.notices.filter((n) => n === NOTICES.degraded(undefined))).toHaveLength(1);
			expect(sessionFiles(sessionDir)).toHaveLength(1); // no switch
		} finally {
			await s1.dispose();
		}

		// restart 2: the cleared record is a silent no-op — no second notice
		const s2 = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
			contextWindow: 100_000,
		});
		try {
			await s2.session.prompt("continue again");
			await new Promise((r) => setTimeout(r, 500));
			expect(s2.notices).toHaveLength(0);
			expect(sessionFiles(sessionDir)).toHaveLength(1);
		} finally {
			await s2.dispose();
		}
	}, 30_000);

	it("a successful switch leaves the fresh session silent on restart", async () => {
		const sessionDir = join(root, "fresh-silent");
		const s = await createTestSession({
			sessionDir,
			turns: [{ text: "q".repeat(9_000) }, { text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			const oldFile = s.sessionFile();
			await s.session.prompt("fill it up");
			await waitFor(() => sessionFiles(sessionDir).length >= 2);
			const fresh = sessionFiles(sessionDir).find((f) => f !== oldFile)!;
			expect(stateRecords(fresh)).toHaveLength(0); // no records leaked into the fresh session
			await s.dispose();

			// restart directly into the fresh session: silent, fully functional
			const s2 = await createTestSession({
				sessionDir,
				openSessionFile: fresh,
				turns: [{ text: "fresh restart reply" }],
				extensions: [freshExtension],
			});
			await s2.session.prompt("keep working");
			expect(s2.notices.filter((n) => n.includes("degraded") || n.includes("tree"))).toHaveLength(0);
			expect(stateRecords(fresh)).toHaveLength(0);
			await s2.dispose();
		} catch (e) {
			await s.dispose();
			throw e;
		}
	}, 30_000);

	it("forks stay silent: a copied record's owner never matches, in-tree fork included", async () => {
		const sessionDir = join(root, "forks");

		// --fork-style: the file copy keeps the custom entry, but its owner names
		// another file, so recovery treats it as a silent no-op
		const copied = craftArmedSession(sessionDir, "fork-copy.jsonl", 5_000, join(sessionDir, "armed.jsonl"));
		// in-tree fork source: same shape, distinct file
		const source = craftArmedSession(sessionDir, "fork-source.jsonl", 5_000, join(sessionDir, "armed.jsonl"));

		// (1) opening the copy: no notice, no switch
		const sCopy = await createTestSession({
			sessionDir,
			openSessionFile: copied,
			contextWindow: 100_000,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			await sCopy.session.prompt("forked continue");
			await new Promise((r) => setTimeout(r, 300));
			expect(sCopy.notices).toHaveLength(0); // owner mismatch: silent no-op
			expect(sessionFiles(sessionDir)).toHaveLength(2); // no fresh session appeared
		} finally {
			await sCopy.dispose();
		}

		// (2) an in-tree fork of that session: the copied record still points at
		// another file, so the fork is silent too
		const sFork = await createTestSession({
			sessionDir,
			openSessionFile: source,
			contextWindow: 100_000,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			const filesBefore = sessionFiles(sessionDir).length;
			await sFork.runtime.fork("m1", { position: "at" });
			const before = sFork.notices.length;
			await sFork.runtime.session.prompt("work in the fork");
			await new Promise((r) => setTimeout(r, 300));
			expect(sFork.notices.slice(before)).toHaveLength(0); // no degraded, no switch notice
			// the fork materialized its own file, and nothing dispatched out of it
			expect(sessionFiles(sessionDir).length).toBe(filesBefore + 1);
		} finally {
			await sFork.dispose();
		}
	}, 30_000);

	it("tree navigation on a re-hydrated armed state: consumerless cancel, cleared on the new leaf, then idle-then-threshold works", async () => {
		const sessionDir = join(root, "tree");
		const armed = craftArmedSession(sessionDir, "armed.jsonl", 5_000);

		// reload re-hydrates armed in-memory without dispatching
		const s = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "ok" }, { text: "after tree" }],
			extensions: [freshExtension],
		});
		try {
			await s.session.reload();
			// consumerless /tree: one notice, cleared record on the new leaf, back to idle
			await (s.session as unknown as { navigateTree: (id: string) => Promise<unknown> }).navigateTree("m2");
			expect(s.notices).toContain(NOTICES.treeCancelled());
			expect(s.notices.filter((n) => n === NOTICES.treeCancelled())).toHaveLength(1);
			await waitFor(() => stateRecords(armed).some((r) => r.data.state === "cleared"));
			// no fresh session ever appeared
			expect(sessionFiles(sessionDir)).toHaveLength(1);

			// idle-then-threshold: after the cancellation the machine dispatches normally
			await s.session.prompt("a".repeat(9_000));
			await waitFor(() => sessionFiles(sessionDir).length >= 2);
		} finally {
			await s.dispose();
		}
	}, 30_000);

	it("residual re-fire pair: an armed record still newest re-fires; a cleared tail stays silent", async () => {
		// (b) cleared tail — what the tree handler leaves behind: restart is silent
		const clearedDir = join(root, "residual-cleared");
		const cleared = craftArmedSession(clearedDir, "armed.jsonl", 5_000);
		appendEntry(cleared, {
			type: "custom",
			customType: STATE_RECORD_TYPE,
			data: {
				state: "cleared",
				owner: cleared,
				oldSessionPath: cleared,
				pointerTextStatic: "MATRIX-STATIC",
				armedAt: Date.now(),
			},
		});
		const s2 = await createTestSession({
			sessionDir: clearedDir,
			openSessionFile: cleared,
			contextWindow: 100_000,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			await s2.session.prompt("plain continue");
			await new Promise((r) => setTimeout(r, 300));
			expect(s2.notices).toHaveLength(0); // the cleared record is the branch's newest
			expect(sessionFiles(clearedDir)).toHaveLength(1); // no switch
		} finally {
			await s2.dispose();
		}

		// (a) documented residual hole: navigate back onto the armed branch, append,
		// restart inside the window → the armed record is newest again, so it re-fires
		const refireDir = join(root, "residual-refire");
		const refire = craftArmedSession(refireDir, "armed.jsonl", 5_000);
		appendEntry(refire, {
			type: "message",
			message: { role: "user", content: "appended on the armed branch", timestamp: Date.now() },
		});
		const s4 = await createTestSession({
			sessionDir: refireDir,
			openSessionFile: refire,
			contextWindow: 100_000,
			turns: [{ text: "re-fired reply" }],
			extensions: [freshExtension],
		});
		try {
			await waitFor(() => sessionFiles(refireDir).length >= 2, 15_000); // it re-fired
			const fresh = sessionFiles(refireDir).find((f) => f !== refire)!;
			expect(parseJsonl(fresh)[0].parentSession).toBe(refire);
		} finally {
			await s4.dispose();
		}
	}, 30_000);
});
