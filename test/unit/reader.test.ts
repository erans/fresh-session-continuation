import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSession } from "../fixtures/builder.js";
import {
	entryImages,
	entryRole,
	entrySearchText,
	firstUserLine,
	isStateRecordEntry,
	parseSessionHeader,
	renderEntry,
	streamEntries,
} from "../../src/reader.js";

const root = mkdtempSync(join(tmpdir(), "fresh-reader-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function collect(file: string) {
	const out = [];
	for await (const entry of streamEntries(file)) out.push(entry);
	return out;
}

describe("reader", () => {
	it("streams entries in file order", async () => {
		const file = buildSession(root, "order.jsonl")
			.user("u1", "first")
			.assistant("a1", "reply")
			.user("u2", "second")
			.write();
		const entries = await collect(file);
		expect(entries.map((e) => (e as { id: string }).id)).toEqual(["u1", "a1", "u2"]);
	});

	it("skips a malformed trailing line but throws on a malformed interior line", async () => {
		const base = buildSession(root, "partial-base.jsonl").user("u1", "hello").write();
		const partial = join(root, "partial.jsonl");
		const content = readFileSync(base, "utf8");
		const truncated = JSON.stringify({ type: "message", id: "x".repeat(40) }).slice(0, 30);
		writeFileSync(partial, content + truncated);
		const entries = await collect(partial);
		expect(entries).toHaveLength(1); // half-written trailing line tolerated

		const interior = join(root, "interior.jsonl");
		writeFileSync(interior, `{broken json here\n${content}`);
		await expect(collect(interior)).rejects.toThrow();
	});

	it("recognizes only its own state-record custom entries", async () => {
		const file = buildSession(root, "custom.jsonl")
			.user("u1", "hi")
			.custom("c1", "fresh-session-switch", { state: "armed" })
			.custom("c2", "some-other-extension", { state: "armed" })
			.write();
		const entries = await collect(file);
		expect(entries.filter(isStateRecordEntry).map((e) => (e as { id: string }).id)).toEqual(["c1"]);
	});

	it("extracts role, search text, rendered text, and first user line", async () => {
		const file = buildSession(root, "text.jsonl")
			.user("u1", "first line of task\nsecond line")
			.assistant("a1", "assistant says")
			.toolResult("t1", "call_1", "bash", "tool output here")
			.write();
		const entries = await collect(file);
		const [user, assistant, toolResult] = entries;

		expect(entryRole(user)).toBe("user");
		expect(entryRole(assistant)).toBe("assistant");
		expect(entryRole(toolResult)).toBe("toolResult");

		expect(entrySearchText(user)).toBe("first line of task\nsecond line");
		expect(entrySearchText(assistant)).toBe("assistant says");
		expect(entrySearchText(toolResult)).toBe("tool output here");

		expect(renderEntry(user)).toContain("first line of task");
		expect(renderEntry(toolResult)).toContain("tool output here");

		expect(firstUserLine(user)).toBe("first line of task");
		expect(firstUserLine(assistant)).toBeNull();
	});

	it("extracts images from user entries only", async () => {
		const file = buildSession(root, "images.jsonl")
			.user("u1", [
				{ type: "text", text: "look" },
				{ type: "image", data: "b64", mimeType: "image/png" },
			])
			.assistant("a1", "reply")
			.write();
		const entries = await collect(file);
		expect(entryImages(entries[0])).toHaveLength(1);
		expect(entryImages(entries[1])).toHaveLength(0);
	});

	it("parses the session header including parentSession", async () => {
		const parent = buildSession(root, "parent.jsonl").user("u1", "x").write();
		const child = buildSession(root, "child.jsonl", { parentSession: parent }).user("u1", "y").write();
		expect(parseSessionHeader(child)?.parentSession).toBe(parent);
		expect(parseSessionHeader(parent)?.parentSession).toBeUndefined();
		expect(parseSessionHeader(join(root, "missing.jsonl"))).toBeNull();
	});

	it("per-file entry ids are local: same id in two files streams independently", async () => {
		const a = buildSession(join(root, "dir-a"), "same.jsonl").user("u1", "in a").write();
		const b = buildSession(join(root, "dir-b"), "same.jsonl").user("u1", "in b").write();
		const [ea, eb] = await Promise.all([collect(a), collect(b)]);
		expect((ea[0] as { message: { content: string } }).message.content).toBe("in a");
		expect((eb[0] as { message: { content: string } }).message.content).toBe("in b");
	});
});
