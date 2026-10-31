import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession } from "../harness/session.js";
import freshExtension from "../../src/index.js";
import { makeRecallGetTool, makeRecallTool } from "../../src/tools.js";
import { SessionBuilder } from "../fixtures/builder.js";
import { generateFixture } from "../../scripts/fixture-session.js";

const root = mkdtempSync(join(tmpdir(), "fresh-criteria-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function parseJsonl(file: string): Record<string, any>[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function toolCtx(file: string, dir: string) {
	return {
		sessionManager: {
			getSessionFile: () => file,
			getSessionDir: () => dir,
		},
	};
}

describe("chain check (12 generations, deeper than the depth budget)", () => {
	it("recall reaches the oldest file via cursor continuation, then recall_get fetches the exact entry", async () => {
		const dir = join(root, "chain");
		const GENS = 12;
		const files: string[] = [];
		for (let g = 0; g < GENS; g++) {
			const name = `gen-${g}.jsonl`;
			const builder = new SessionBuilder(dir, name, {
				parentSession: g === 0 ? undefined : files[g - 1],
			});
			builder.user(`u${g}`, `task for generation ${g}`);
			builder.assistant(`a${g}`, `progress note: UNIQUE-FACT-GEN-${g} settled`);
			files.push(builder.write());
		}
		const newest = files[GENS - 1];

		const recall = makeRecallTool() as unknown as {
			execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }>;
		};

		// first call: the depth budget (8) stops before the oldest files
		const first = await recall.execute("t1", { query: "UNIQUE-FACT-GEN-0" }, undefined, undefined, toolCtx(newest, dir));
		const firstText = first.content.map((c) => c.text).join("\n");
		expect(firstText).toContain("not scanned this call");
		const cursorMatch = firstText.match(/nextCursor: ([A-Za-z0-9_-]+)/);
		expect(cursorMatch).toBeTruthy();

		// cursor continuation walks the unscanned ancestors to the oldest file
		let text = firstText;
		let cursor = cursorMatch![1];
		for (let i = 0; i < 8 && text.includes("no hits for:"); i++) {
			const next = await recall.execute(`t${i + 2}`, { cursor }, undefined, undefined, toolCtx(newest, dir));
			text = next.content.map((c) => c.text).join("\n");
			const m = text.match(/nextCursor: ([A-Za-z0-9_-]+)/);
			if (text.includes("no hits for:")) {
				expect(m).toBeTruthy();
				cursor = m![1];
			}
		}
		expect(text).not.toContain("no hits for:"); // the oldest session's fact, found
		expect(text).toContain("UNIQUE-FACT-GEN-0 settled"); // verbatim from generation 0

		// recall_get fetches the exact entry verbatim (labels are gen<index>, newest = gen0)
		const hit = text.match(/- \[([a-z0-9]+)@gen11\]/);
		expect(hit).toBeTruthy();
		const get = makeRecallGetTool() as unknown as {
			execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }>;
		};
		const exact = await get.execute("g1", { file: files[0], entryId: hit![1] }, undefined, undefined, toolCtx(newest, dir));
		const exactText = exact.content.map((c) => c.text).join("\n");
		expect(exactText).toContain("UNIQUE-FACT-GEN-0");
	}, 30_000);
});

describe("disable-compatibility", () => {
	it("a pointer-compacted session opened with no extension keeps the self-sufficient pointer text", async () => {
		const dir = join(root, "disabled-ext");
		const oldFile = join(dir, "old.jsonl");
		// a prior generation with real content
		new SessionBuilder(dir, "old.jsonl").user("u1", "the original task").assistant("a1", "did the first part").write();

		// the pointer session: header names old.jsonl as parent, a compaction carries the real pointer text
		const { renderPointerStatic, buildTocFromFiles } = await import("../../src/pointer.js");
		const { toc } = buildTocFromFiles([{ file: oldFile, entries: [] }], { maxTocEntries: 50 });
		const staticText = renderPointerStatic({
			oldSessionPath: oldFile,
			toc,
			readFiles: [join(dir, "src/a.ts")],
			modifiedFiles: [join(dir, "src/b.ts")],
		});
		const file = join(dir, "pointer.jsonl");
		const builder = new SessionBuilder(dir, "pointer.jsonl", { parentSession: oldFile });
		builder.compaction("c1", { summary: staticText, firstKeptEntryId: null, tokensBefore: 500 });
		builder.user("u2", "continue the task");
		builder.write();

		const persisted = parseJsonl(file).find((e) => e.type === "compaction")!;
		expect(persisted.summary).toContain(oldFile); // the old-session path
		expect(persisted.summary).toContain("read the session file directly with the read/bash tools"); // self-sufficiency

		// open it with NO extension: still loads and runs
		const s = await createTestSession({
			sessionDir: dir,
			openSessionFile: file,
			turns: [{ text: "extensionless reply" }],
			extensions: [],
		});
		try {
			await s.session.prompt("continue without the extension");
			const entries = parseJsonl(file);
			expect(entries.some((e) => e.type === "message" && e.message.role === "assistant")).toBe(true);
			// no records, no recall tools, no notices from the missing extension
			expect(s.notices).toHaveLength(0);
		} finally {
			await s.dispose();
		}
	}, 30_000);
});

describe("fixture generator", () => {
	it("produces a session file of the expected size class", () => {
		const dir = join(root, "fixture");
		const file = generateFixture(dir);
		expect(existsSync(file)).toBe(true);
		const bytes = statSync(file).size;
		// ~400k tokens ≈ 1.6 MB of payload text; JSONL overhead adds more
		expect(bytes).toBeGreaterThan(1_500_000);
		const entries = parseJsonl(file);
		expect(entries.length).toBeGreaterThan(100);
		// realistic traffic: reads, edits, bash, at least one error result
		const text = readFileSync(file, "utf8");
		expect(text).toContain("\"name\":\"read\"");
		expect(text).toContain("\"name\":\"edit\"");
		expect(text).toContain("\"name\":\"bash\"");
		expect(text).toContain("Command failed");
		// linear single-branch history with a scripted task in progress:
		// one user task, hundreds of assistant/toolResult traffic turns
		expect(entries.filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(1);
		expect(entries.filter((e) => e.type === "message" && e.message.role === "assistant").length).toBeGreaterThan(300);
		expect(entries.filter((e) => e.type === "message" && e.message.role === "toolResult").length).toBeGreaterThan(900);
	}, 60_000);
});
