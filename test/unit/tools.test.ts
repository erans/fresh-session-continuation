import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSession } from "../fixtures/builder.js";
import { makeRecallGetTool, makeRecallTool } from "../../src/tools.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const root = mkdtempSync(join(tmpdir(), "fresh-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const parent = buildSession(root, "parent.jsonl")
	.user("u1", "fix the login bug")
	.assistant("a1", "investigating the login bug")
	.compaction("c1", { summary: "pointer text", firstKeptEntryId: "c1", tokensBefore: 1 })
	.custom("x1", "fresh-session-switch", { state: "cleared" })
	.user("u2", "after the pointer")
	.assistant("a2", "error 500 in the gateway")
	.write();

const current = buildSession(root, "current.jsonl", { parentSession: parent })
	.user("u3", "continue the login bug fix")
	.assistant("a3", "ECONNREFUSED error 500 from db")
	.custom("x2", "fresh-session-switch", { state: "armed" })
	.user("u4", "final touches")
	.write();

const plain = buildSession(root, "plain.jsonl")
	.user("p1", "plain session line one")
	.assistant("p2", "plain reply")
	.write();

function deepChain(length: number): string[] {
	const files: string[] = [];
	for (let i = 0; i < length; i++) {
		const b = buildSession(root, `deep${i}.jsonl`, {
			parentSession: i === 0 ? undefined : files[i - 1],
		});
		for (let k = 0; k < 5; k++) b.user(`du${i}_${k}`, `deep hit marker ${i} v${k}`);
		files.push(b.write());
	}
	return files;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ctxFor(file: string): any {
	return { sessionManager: { getSessionFile: () => file, getSessionDir: () => root } };
}

function text(result: AgentToolResult): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

async function runRecall(file: string, args: Record<string, unknown>, opts?: { budget?: any }) {
	const tool = makeRecallTool(opts);
	return tool.execute("t", args as never, undefined, undefined, ctxFor(file));
}

async function runGet(file: string, args: Record<string, unknown>) {
	const tool = makeRecallGetTool();
	return tool.execute("t", args as never, undefined, undefined, ctxFor(file));
}

describe("recall", () => {
	it("literal search across the chain, newest-first interleave", async () => {
		const result = await runRecall(current, { query: "error 500" });
		expect(result.isError).toBeFalsy();
		const out = text(result);
		expect(out).toContain("ECONNREFUSED");
		expect(out).toContain("gateway");
		expect(out.indexOf("ECONNREFUSED")).toBeLessThan(out.indexOf("gateway"));
		expect(out).not.toContain("armed"); // state records are never hits
	});

	it("literal default escapes regex metacharacters; regex is opt-in", async () => {
		const file = buildSession(root, "esc.jsonl")
			.user("e1", "literal a.b here")
			.user("e2", "axb not a match")
			.write();
		const literal = text(await runRecall(file, { query: "a.b" }));
		expect(literal).toContain("literal a.b");
		expect(literal).not.toContain("axb");

		const regex = text(await runRecall(file, { query: "^axb", regex: true }));
		expect(regex).toContain("axb");
	});

	it("rejects query/tail/cursor combinations", async () => {
		const both = await runRecall(current, { query: "x", tail: 3 });
		expect(both.isError).toBe(true);
		const none = await runRecall(current, {});
		expect(none.isError).toBe(true);
		const cursorPlusQuery = await runRecall(current, { cursor: "c", query: "x" });
		expect(cursorPlusQuery.isError).toBe(true);
		const cursorPlusFile = await runRecall(current, { cursor: "c", file: current });
		expect(cursorPlusFile.isError).toBe(true);
	});

	it("global limit with a per-file floor while unspent", async () => {
		const files = deepChain(12);
		const result = await runRecall(files[11], { query: "deep hit marker" });
		const out = text(result);
		const hitCount = (out.match(/du\d/g) ?? []).length;
		expect(hitCount).toBeLessThanOrEqual(25);
		// the floor: the newest files each contribute up to 5 until the limit is spent
		const newest = (out.match(/du11_/g) ?? []).length;
		expect(newest).toBe(5);
		// the limit is spent after five files: older generations absent
		expect(out).not.toContain("du6_");
	});

	it("caps the result at ~32 KB with a truncation marker", async () => {
		const file = buildSession(root, "cap.jsonl");
		for (let i = 0; i < 2000; i++) {
			file.user(`cu${i}`, `needle padding text ${i}`);
		}
		const path = file.write();
		const out = text(await runRecall(path, { query: "needle", limit: 500 }));
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(33_000);
		expect(out).toContain("[truncated]");
	});

	it("budget cut reports unscanned files and a resumable cursor", async () => {
		const files = deepChain(12);
		const result = await runRecall(files[11], { query: "deep hit marker" }, {
			budget: { maxBytes: 1, maxElapsedMs: 10_000, maxDepth: 8 },
		});
		const out = text(result);
		expect(out).toContain("not scanned this call");
		const cursorMatch = out.match(/nextCursor: (\S+)/);
		expect(cursorMatch).toBeTruthy();
		const resumed = text(await runRecall(files[11], { cursor: cursorMatch![1] }));
		expect(resumed).toContain("deep hit marker");
	});

	it("a regex search under a tiny elapsed budget returns bounded with a cut marker", async () => {
		const file = buildSession(root, "slow.jsonl");
		for (let i = 0; i < 600; i++) {
			file.user(`su${i}`, `${"slow padding line ".repeat(300)} ${i}`);
		}
		const path = file.write();
		const t0 = Date.now();
		const out = text(
			await runRecall(
				path,
				{ query: "slow.*399$", regex: true },
				{ budget: { maxBytes: 52_428_800, maxElapsedMs: 1, maxDepth: 8 } },
			),
		);
		expect(Date.now() - t0).toBeLessThan(5_000); // bounded, never a hang
		expect(out).toContain("not scanned this call");
	});

	it("tail precedence: parent target with a compaction boundary yields the pre-compaction tail", async () => {
		const out = text(await runRecall(current, { tail: 3 }));
		expect(out).toContain("fix the login bug");
		expect(out).not.toContain("final touches"); // current file's tail is in context, not the target
		expect(out).not.toContain("pointer text");
		expect(out).not.toContain("after the pointer");
	});

	it("tail on a plain session returns its own last entries", async () => {
		const out = text(await runRecall(plain, { tail: 2 }));
		expect(out).toContain("plain session line one");
		expect(out).toContain("plain reply");
	});

	it("an over-cap tail entry pages with a next line", async () => {
		const file = buildSession(root, "bigtail.jsonl")
			.user("bu1", `${"big entry ".repeat(6000)}`)
			.write();
		const out = text(await runRecall(file, { tail: 1 }));
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(34_000);
		expect(out).toContain("[truncated]");
		const next = out.match(/next: \{ "file": "([^"]+)", "entryId": "([^"]+)", "offset": (\d+) \}/);
		expect(next).toBeTruthy();
	});
});

describe("recall_get", () => {
	it("fetches an entry verbatim from a chain member", async () => {
		const result = await runGet(current, { file: current, entryId: "a3" });
		expect(text(result)).toContain("ECONNREFUSED error 500 from db");
	});

	it("offset replays a truncated fetch", async () => {
		const file = buildSession(root, "big.jsonl")
			.user("gu1", `${"get entry ".repeat(6000)}`)
			.write();
		const first = text(await runGet(file, { file, entryId: "gu1" }));
		expect(first).toContain("[truncated]");
		const m = first.match(/"offset": (\d+) \}/);
		expect(m).toBeTruthy();
		const rest = text(await runGet(file, { file, entryId: "gu1", offset: Number(m![1]) }));
		expect(rest.length).toBeGreaterThan(0);
		expect(rest).not.toContain(first.slice(0, 50));
	});

	it("rejects a file outside the chain with the valid-target list", async () => {
		const outside = mkdtempSync(join(tmpdir(), "fresh-get-outside-"));
		afterAll(() => rmSync(outside, { recursive: true, force: true }));
		const stranger = buildSession(outside, "stranger.jsonl").user("s1", "x").write();
		const result = await runGet(current, { file: stranger, entryId: "s1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(current);
	});

	it("fetches from an ancestor deeper than the walk budget (full-ancestry validation)", async () => {
		const files = deepChain(12);
		const result = await runGet(files[11], { file: files[0], entryId: "du0_0" });
		expect(text(result)).toContain("deep hit marker 0");
	});

	it("around windows page the same way", async () => {
		const result = await runGet(parent, {
			around: { file: parent, entryId: "a1", before: 1, after: 1 },
		});
		const out = text(result);
		expect(out).toContain("investigating the login bug");
		expect(out).toContain("fix the login bug");
	});
});
