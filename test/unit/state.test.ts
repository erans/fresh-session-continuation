import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSession } from "../fixtures/builder.js";
import { appendStateRecord, resolveActiveRecord, shouldClearOnExit } from "../../src/state.js";
import { tailEntries } from "../../src/reader.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "fresh-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Recorded {
	customType: string;
	data: unknown;
}

function makeFakePi() {
	const records: Recorded[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			records.push({ customType, data });
		},
	} as never as Parameters<typeof appendStateRecord>[0];
	return { pi, records };
}

function branchOf(records: Recorded[], ownerMatch: string): SessionEntry[] {
	return records.map((r, i) => ({
		type: "custom",
		id: `r${i}`,
		parentId: i === 0 ? null : `r${i - 1}`,
		timestamp: new Date().toISOString(),
		customType: r.customType,
		data: r.data,
	})) as unknown as SessionEntry[];
}

describe("state records", () => {
	it("records are append-only: armed then cleared, newest wins", () => {
		const { pi, records } = makeFakePi();
		const base = { owner: "/s/a.jsonl", oldSessionPath: "/s/a.jsonl", pointerTextStatic: "S", armedAt: 1 };
		appendStateRecord(pi, { ...base, state: "armed" });
		appendStateRecord(pi, { ...base, state: "cleared", armedAt: 2 });
		expect(records).toHaveLength(2);

		expect(resolveActiveRecord(branchOf(records, base.owner), base.owner)).toBeNull();
	});

	it("resolves the newest armed record on the branch for the current file", () => {
		const { pi, records } = makeFakePi();
		const base = { owner: "/s/a.jsonl", oldSessionPath: "/s/a.jsonl", pointerTextStatic: "S1", armedAt: 1 };
		appendStateRecord(pi, { ...base, state: "armed" });
		const resolved = resolveActiveRecord(branchOf(records, base.owner), "/s/a.jsonl");
		expect(resolved?.pointerTextStatic).toBe("S1");
		expect(resolved?.armedAt).toBe(1);
	});

	it("a fork-copied record (owner mismatch) is a silent no-op", () => {
		const { pi, records } = makeFakePi();
		appendStateRecord(pi, {
			state: "armed",
			owner: "/s/original.jsonl",
			oldSessionPath: "/s/original.jsonl",
			pointerTextStatic: "S",
			armedAt: 1,
		});
		// the fork copies the record into a new file; the current file differs
		expect(resolveActiveRecord(branchOf(records, "/s/original.jsonl"), "/s/forked.jsonl")).toBeNull();
	});

	it("tail skips state records and stops at the newest compaction entry", async () => {
		const file = buildSession(root, "tail.jsonl")
			.user("u1", "before compaction")
			.assistant("a1", "old reply")
			.compaction("c1", { summary: "pointer", firstKeptEntryId: "c1", tokensBefore: 1 })
			.custom("x1", "fresh-session-switch", { state: "cleared" })
			.user("u2", "after compaction")
			.assistant("a2", "new reply")
			.custom("x2", "fresh-session-switch", { state: "armed" })
			.write();

		const tail = await tailEntries(file, 4, () => false);
		expect(tail.map((e) => (e as { id: string }).id)).toEqual(["u1", "a1"]);
	});

	it("clearing rules: which exits append a cleared record", () => {
		expect(shouldClearOnExit("degraded")).toBe(true);
		expect(shouldClearOnExit("preflight")).toBe(true);
		expect(shouldClearOnExit("printjson")).toBe(true);
		expect(shouldClearOnExit("in-flight-refusal")).toBe(false);
		expect(shouldClearOnExit("session-before-switch-post-commit")).toBe(false);
	});
});
