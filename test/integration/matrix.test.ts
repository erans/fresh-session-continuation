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
function craftArmedSession(dir: string, name: string, armedAgeMs: number): string {
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
				owner: file,
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

	it("forks stay silent: --fork-style file copy and in-tree fork", async () => {
		const sessionDir = join(root, "forks");
		const armed = craftArmedSession(sessionDir, "armed.jsonl", 5_000);

		// --fork-style: a copied file keeps the custom entries, but the owner mismatches
		const copied = join(sessionDir, "fork-copy.jsonl");
		const copy = parseJsonl(armed).map((e) => ({ ...e, id: `f-${e.id}` }));
		(copy[0] as Record<string, any>).id = "fork-session";
		writeFileSync(
			copied,
			copy.map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		const sCopy = await createTestSession({
			sessionDir,
			openSessionFile: copied,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			await sCopy.session.prompt("forked continue");
			await new Promise((r) => setTimeout(r, 500));
			expect(sCopy.notices).toHaveLength(0); // owner mismatch: silent no-op
			expect(sessionFiles(sessionDir).filter((f) => f !== armed && f !== copied)).toHaveLength(0);
		} finally {
			await sCopy.dispose();
		}

		// in-tree fork: fork at the assistant entry; the armed record is not on the new leaf
		const sFork = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			// the recovery dispatch may fire for the armed file; fork BEFORE it lands
			const result = await sFork.runtime.fork("m1", { position: "at" });
			expect(result).toBeTruthy();
			// the forked leaf's record (if any copied) never dispatches from the fork
			const before = sFork.notices.length;
			await sFork.runtime.session.prompt("work in the fork");
			const forkFiles = sessionFiles(sessionDir).filter((f) => f !== armed && f !== copied);
			expect(forkFiles.length).toBeGreaterThanOrEqual(1);
			const forkFile = forkFiles[forkFiles.length - 1];
			// the fork copies entries up to m1 only: the armed record (after m2) is not on it
			expect(stateRecords(forkFile)).toHaveLength(0);
			expect(sFork.notices.slice(before)).toHaveLength(0);
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

	it("residual re-fire pair: append-on-armed-branch restart re-fires; no-append restart is silent", async () => {
		// case (b): after the cleared record, restarting re-derives the cleared leaf — silent
		const sessionDir = join(root, "residual");
		const armed = craftArmedSession(sessionDir, "armed.jsonl", 5_000);

		const s = await createTestSession({
			sessionDir,
			openSessionFile: armed,
			turns: [{ text: "ok" }],
			extensions: [freshExtension],
		});
		try {
			await s.session.reload();
			await (s.session as unknown as { navigateTree: (id: string) => Promise<unknown> }).navigateTree("m2");
			await waitFor(() => stateRecords(armed).some((r) => r.data.state === "cleared"));
			await s.dispose();

			// (b) restart with no append: the file's last entry is the cleared record — silent
			const s2 = await createTestSession({
				sessionDir,
				openSessionFile: armed,
				turns: [{ text: "ok" }],
				extensions: [freshExtension],
			});
			await s2.session.prompt("plain continue");
			await new Promise((r) => setTimeout(r, 500));
			expect(s2.notices).toHaveLength(0);
			expect(sessionFiles(sessionDir)).toHaveLength(1);
			await s2.dispose();

			// (a) navigate back onto the armed branch, append, restart in window: re-fires
			// (documented residual hole: the armed record is still the branch's newest)
			const s3 = await createTestSession({
				sessionDir,
				openSessionFile: armed,
				turns: [{ text: "ok" }, { text: "re-fired reply" }],
				extensions: [freshExtension],
			});
			await (s3.session as unknown as { navigateTree: (id: string) => Promise<unknown> }).navigateTree("r1");
			await s3.session.prompt("append on the armed branch");
			await s3.dispose();

			const s4 = await createTestSession({
				sessionDir,
				openSessionFile: armed,
				turns: [{ text: "re-fired reply" }],
				extensions: [freshExtension],
			});
			try {
				await waitFor(() => sessionFiles(sessionDir).length >= 2, 15_000); // it re-fired
				const fresh = sessionFiles(sessionDir).find((f) => f !== armed)!;
				expect(parseJsonl(fresh)[0].parentSession).toBe(armed);
			} finally {
				await s4.dispose();
			}
		} catch (e) {
			await s.dispose();
			throw e;
		}
	}, 45_000);
});
