import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSession } from "../fixtures/builder.js";
import {
	mintCursor,
	parseCursor,
	RECALL_BUDGET,
	resolveChain,
	shaDigest,
	verifyCursor,
	type ChainTarget,
} from "../../src/chain.js";

const root = mkdtempSync(join(tmpdir(), "fresh-chain-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function buildChain(length: number): string[] {
	const files: string[] = [];
	for (let i = 0; i < length; i++) {
		const parent = i === 0 ? undefined : files[i - 1];
		files.push(
			buildSession(root, `gen${i}.jsonl`, { parentSession: parent })
				.user(`u${i}`, `message in generation ${i}`)
				.write(),
		);
	}
	return files;
}

describe("chain", () => {
	it("resolves newest→oldest up to the depth budget, reporting the cut", async () => {
		const files = buildChain(12);
		const result = await resolveChain(files[11], root, RECALL_BUDGET);
		expect(result.targets.map((t: ChainTarget) => t.label)).toEqual([
			"gen0",
			"gen1",
			"gen2",
			"gen3",
			"gen4",
			"gen5",
			"gen6",
			"gen7",
		]);
		expect(result.targets[0].file).toBe(files[11]);
		expect(result.stoppedAt).toBe(files[3]);
		expect(result.reason).toBe("budget");
	});

	it("a shorter chain simply ends, no stop reason", async () => {
		const files = buildChain(3);
		const result = await resolveChain(files[2], root, RECALL_BUDGET);
		expect(result.targets).toHaveLength(3);
		expect(result.stoppedAt).toBeUndefined();
		expect(result.reason).toBeUndefined();
	});

	it("rejects a parent outside the session dir and a non-session file", async () => {
		const outside = mkdtempSync(join(tmpdir(), "fresh-outside-"));
		afterAll(() => rmSync(outside, { recursive: true, force: true }));
		const outsideFile = buildSession(outside, "o.jsonl").user("u", "x").write();
		const badRoot = buildSession(root, "outside.jsonl", { parentSession: outsideFile })
			.user("u", "x")
			.write();
		const r1 = await resolveChain(badRoot, root, RECALL_BUDGET);
		expect(r1.reason).toBe("invalid");
		expect(r1.stoppedAt).toBe(outsideFile);
		expect(r1.targets).toHaveLength(1);

		const notSession = join(root, "not-a-session.txt");
		writeFileSync(notSession, "hello");
		const badFile = buildSession(root, "notsession.jsonl", { parentSession: notSession })
			.user("u", "x")
			.write();
		const r2 = await resolveChain(badFile, root, RECALL_BUDGET);
		expect(r2.reason).toBe("invalid");
		expect(r2.targets).toHaveLength(1);
	});

	it("stops on a self-referencing parent and on a repeated file", async () => {
		const selfFile = join(root, "self.jsonl");
		buildSession(root, "self.jsonl", { cwd: root, parentSession: selfFile })
			.user("u", "x")
			.write();
		const r1 = await resolveChain(selfFile, root, RECALL_BUDGET);
		expect(r1.reason).toBe("cycle");
		expect(r1.targets).toHaveLength(1);

		const a = buildSession(root, "rep-a.jsonl").user("u", "a").write();
		const b = buildSession(root, "rep-b.jsonl", { parentSession: a }).user("u", "b").write();
		// rewrite a's header to point at b: a → b → a
		buildSession(root, "rep-a.jsonl", { parentSession: b }).user("u", "a").write();
		const r2 = await resolveChain(b, root, RECALL_BUDGET);
		expect(r2.reason).toBe("cycle");
		expect(r2.targets.map((t) => t.file)).toEqual([b, a]);
	});

	it("cursors round-trip and reject a mismatched visited digest", async () => {
		const files = buildChain(3);
		const digest = shaDigest(files);
		const cursor = mintCursor({ visitedDigest: digest, chainIndex: 1, byteOffset: 500, query: "error 500" });
		const parsed = parseCursor(cursor);
		expect(parsed).toEqual({ visitedDigest: digest, chainIndex: 1, byteOffset: 500, query: "error 500" });
		expect(verifyCursor(parsed!, digest)).toBe(true);
		expect(verifyCursor(parsed!, shaDigest([join(root, "other")]))).toBe(false);
		expect(parseCursor("not-a-cursor")).toBeNull();
	});
});
