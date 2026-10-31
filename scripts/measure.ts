import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture } from "./fixture-session.js";
import { createTestSession } from "../test/harness/session.js";
import freshExtension from "../src/index.js";

/**
 * Success-criteria measurements on the reference fixture. The harness serves
 * a zero-cost fake provider, so latency here is machinery-only (reader,
 * renderer, switch) and every dollar figure for a real model is a
 * placeholder row for the README — fill those from a real-model run.
 *
 * Run: npx tsx scripts/measure.ts
 */
async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "fresh-measure-"));
	try {
		const fixtureDir = join(root, "fixture");
		const file = generateFixture(fixtureDir);
		const sessionDir = join(root, "sessions");
		const s = await createTestSession({
			sessionDir,
			openSessionFile: file,
			turns: [{ text: "measured reply" }, { text: "measured reply 2" }],
			extensions: [freshExtension],
		});

		const t0 = Date.now();
		await s.session.prompt("continue the refactor");
		// switch lands: a second file (next to the fixture — SessionManager.open
		// derives the session dir from the opened file's parent) carrying the
		// pointer prompt as its first user entry
		let fresh: string | undefined;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !fresh) {
			const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"));
			for (const f of files) {
				const p = join(fixtureDir, f);
				if (p === file) continue;
				const body = readFileSync(p, "utf8");
				if (body.includes("Previous session (complete, verbatim record):")) {
					fresh = p;
					break;
				}
			}
			if (!fresh) await new Promise((r) => setTimeout(r, 100));
		}
		const t1 = Date.now();
		if (!fresh) throw new Error("switch never landed");

		const compaction = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.find((e: Record<string, unknown>) => e.type === "compaction") as Record<string, unknown>;
		const pointerBytes = Buffer.byteLength(String(compaction.summary), "utf8");
		const fixtureBytes = statSync(file).size;

		console.log("| measurement | value |");
		console.log("|---|---|");
		console.log(`| fixture payload | ${(fixtureBytes / 1_000_000).toFixed(1)} MB (~${Math.round(fixtureBytes / 4 / 1000)}k tokens) |`);
		console.log(`| switch latency, trigger → fresh first turn (harness, no queue) | ${t1 - t0} ms |`);
		console.log(`| pointer compaction size | ${pointerBytes} bytes (~${Math.round(pointerBytes / 4)} tokens) |`);
		console.log(`| switch cost (pointer compaction is pure rendering) | $0.00 |`);
		console.log("| fresh first turn + recall calls (real model) | _fill from a real-model run_ |");
		console.log("| one default LLM compaction, same record (comparison) | _fill: model price × summary tokens_ |");
		console.log("| drain case (queued input remainder): N turns, T s, $X | _fill with a fixed queued-input script_ |");
		await s.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
