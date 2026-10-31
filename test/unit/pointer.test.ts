import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	assemblePrompt,
	buildTocFromFiles,
	capImages,
	minimalPointer,
	POINTER_CAP_BYTES,
	renderPointerStatic,
	renderVolatileBlock,
	VOLATILE_HEADROOM_BYTES,
	type Anchor,
	type StaticInput,
	type VolatileInput,
} from "../../src/pointer.js";

const GOLDEN_DIR = join(import.meta.dirname, "../fixtures/golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function golden(name: string, actual: string): void {
	mkdirSync(GOLDEN_DIR, { recursive: true });
	const path = join(GOLDEN_DIR, name);
	if (UPDATE || !existsSync(path)) {
		writeFileSync(path, actual);
		return;
	}
	expect(actual).toBe(readFileSync(path, "utf8"));
}

const anchor: Anchor = {
	lastAssistantText: "ran the tests, two failing",
	entryRefs: [
		{ file: "/sessions/old.jsonl", entryId: "a9" },
		{ file: "/sessions/old.jsonl", entryId: "a10" },
	],
};

const staticInput: StaticInput = {
	oldSessionPath: "/sessions/old.jsonl",
	toc: [
		{ file: "/sessions/old.jsonl", entryId: "u1", line: "fix the login bug", timestamp: "2026-10-30T10:00:00Z" },
		{ file: "/sessions/old.jsonl", entryId: "u5", line: "now the logout bug", timestamp: "2026-10-30T11:00:00Z" },
	],
	readFiles: ["src/login.ts"],
	modifiedFiles: ["src/login.ts", "src/logout.ts"],
};

const volatileInput: VolatileInput = {
	lastUserMessage: "fix the login bug and keep going",
	images: [],
	anchor,
};

describe("pointer renderers", () => {
	it("golden: hook-time compaction summary assembly", () => {
		golden(
			"compaction-summary.md",
			assemblePrompt(renderPointerStatic(staticInput), renderVolatileBlock(volatileInput)),
		);
	});

	it("golden: armed-payload prompt assembly equals the summary assembly", () => {
		const prompt = assemblePrompt(
			renderPointerStatic(staticInput),
			renderVolatileBlock({ ...volatileInput, lastUserMessage: "fix the login bug and keep going" }),
		);
		golden("armed-prompt.md", prompt);
	});

	it("golden: manual regeneration omits file lists", () => {
		const manual = assemblePrompt(
			renderPointerStatic({ ...staticInput, readFiles: [], modifiedFiles: [] }),
			renderVolatileBlock(volatileInput),
		);
		golden("manual-regeneration.md", manual);
		expect(manual).not.toContain("Files modified");
	});

	it("cap-as-function: a huge TOC truncates, the path and instructions never do", () => {
		const hugeToc = Array.from({ length: 500 }, (_, i) => ({
			file: "/sessions/old.jsonl",
			entryId: `u${i}`,
			line: `task line number ${i} with some padding text to fill space`,
			timestamp: `2026-10-30T10:0${i % 10}:00Z`,
		}));
		const text = renderPointerStatic({ ...staticInput, toc: hugeToc });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
			POINTER_CAP_BYTES - VOLATILE_HEADROOM_BYTES,
		);
		expect(text).toContain("/sessions/old.jsonl");
		expect(text).toContain("search the record with `recall`");
		expect(text).not.toContain("task line number 499");
	});

	it("oversized last user message truncates with a recall pointer", () => {
		const huge = "x".repeat(20_000);
		const text = renderVolatileBlock({ ...volatileInput, lastUserMessage: huge });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(VOLATILE_HEADROOM_BYTES + 512);
		expect(text).toContain("recall { tail }");
	});

	it("image cap: at most ~4 images / ~1 MB, remainder named", () => {
		const images = Array.from({ length: 7 }, () => ({
			type: "image" as const,
			data: "y".repeat(200_000),
			mimeType: "image/png",
		}));
		const { kept, dropped } = capImages(images);
		expect(kept.length).toBe(4);
		expect(dropped).toBe(3);
	});

	it("budget-exhausted TOC ends with the terminal marker", () => {
		const { toc, exhaustedAfter } = buildTocFromFiles(
			[
				{
					file: "/sessions/old.jsonl",
					entries: Array.from({ length: 3 }, (_, i) => ({
						type: "message",
						id: `u${i}`,
						parentId: null,
						timestamp: "2026-10-30T10:00:00Z",
						message: { role: "user", content: `line ${i}`, timestamp: 1 },
					})) as never[],
				},
			],
			{ maxTocEntries: 2 },
		);
		expect(toc).toHaveLength(2);
		expect(exhaustedAfter).toEqual(["/sessions/old.jsonl"]);
	});

	it("minimal pointer carries path, message, and self-sufficiency", () => {
		const text = minimalPointer("/sessions/old.jsonl", "partial last message");
		expect(text).toContain("/sessions/old.jsonl");
		expect(text).toContain("partial last message");
		expect(text).toContain("read/bash tools");
	});
});

describe("review-fix regressions", () => {
	it("H2: huge file lists truncate to keep the pointer under the cap, with a loud marker", () => {
		const out = renderPointerStatic({
			oldSessionPath: "/old/session.jsonl",
			toc: [{ entryId: "u1", file: "/old/session.jsonl", line: "the task", timestamp: "2026-10-30T10:00:00Z" }],
			readFiles: Array.from({ length: 400 }, (_, i) => `/repo/src/module-${i}.ts`),
			modifiedFiles: Array.from({ length: 200 }, (_, i) => `/repo/src/gen-${i}.ts`),
		});
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(16_384);
		expect(out).toContain("/old/session.jsonl"); // path never truncated
		expect(out).toContain("more not listed — recall the record for them");
		// the first entries survive, the deep ones fold into the marker
		expect(out).toContain("module-0.ts");
		expect(out).not.toContain("module-399.ts");
	});

	it("M2: unindexed chain members are named with the spec's loud marker", () => {
		const out = renderPointerStatic({
			oldSessionPath: "/old/session.jsonl",
			toc: [{ entryId: "u1", file: "/old/session.jsonl", line: "the task", timestamp: "2026-10-30T10:00:00Z" }],
			readFiles: [],
			modifiedFiles: [],
			exhaustedAfter: ["/old/gen-9.jsonl"],
		});
		expect(out).toContain(
			"older sessions not indexed here: gen-9.jsonl — search them with recall, which continues past its budget via cursor",
		);
	});
});
