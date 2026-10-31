import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reference-fixture generator: a ~400k-token persisted session of realistic
 * tool traffic (reads, edits, bash output, errors) with a scripted task in
 * progress. Drives the success-criteria measurements in scripts/measure.ts.
 *
 * Run: npx tsx scripts/fixture-session.ts [outdir]
 */

const TASK = "Refactor the auth module to use rotating refresh tokens.";
const FILES = [
	"src/auth/session.ts",
	"src/auth/tokens.ts",
	"src/auth/middleware.ts",
	"src/api/routes.ts",
	"src/db/users.ts",
	"test/auth.test.ts",
];

function fileContent(i: number): string {
	return [
		`// module ${i}: token handling`,
		...Array.from(
			{ length: 24 },
			(_, k) =>
				`export function handler${k}(req: Request, res: Response) {\n\tconst token = req.headers.authorization?.slice(7);\n\tif (!verify${i}(token)) return res.status(401).send("unauthorized");\n\t// session rotation point ${k}: legacy path kept for compatibility\n\treturn res.json({ ok: true, rotation: ${i} + ${k} });\n}`,
		),
	].join("\n");
}

function bashOutput(i: number): string {
	return [
		`$ npx vitest run test/auth.test.ts --reporter=verbose`,
		...Array.from({ length: 18 }, (_, k) => `  ✓ src/auth/__tests__/case-${i}-${k}.spec.ts (${20 + ((i + k) % 40)}ms)`),
		"",
		`  Test Files  ${1 + (i % 3)} passed (${1 + (i % 3)})`,
		`       Tests  ${18 + (i % 7)} passed (${18 + (i % 7)})`,
	].join("\n");
}

/** Generate the fixture into `dir`; returns the session file path. */
export function generateFixture(dir: string, cycles = 340): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "fixture-400k.jsonl");
	const lines: string[] = [];
	let tick = 1_700_000_000_000;
	const stamp = () => new Date((tick += 3)).toISOString();
	const push = (entry: Record<string, unknown>) => lines.push(JSON.stringify(entry));
	let parentId: string | null = null;
	let n = 0;
	const id = () => `e${(n += 1).toString(36)}`;

	push({ type: "session", version: 3, id: "fixture-400k", timestamp: stamp(), cwd: dir });

	const msg = (role: "user" | "assistant", content: unknown) => {
		const entryId = id();
		push({
			type: "message",
			id: entryId,
			parentId,
			timestamp: stamp(),
			message: { role, content, timestamp: tick },
		});
		parentId = entryId;
		return entryId;
	};
	const toolCallBlock = (name: string, args: Record<string, unknown>) => ({
		type: "toolCall",
		id: `call_${n}`,
		name,
		arguments: args,
	});
	const toolResult = (callId: string, output: string, isError = false) => {
		const entryId = id();
		push({
			type: "message",
			id: entryId,
			parentId,
			timestamp: stamp(),
			message: {
				role: "toolResult",
				content: [{ type: "toolResult", id: callId, output, isError }],
				timestamp: tick,
			},
		});
		parentId = entryId;
	};

	msg("user", TASK);
	for (let i = 0; i < cycles; i++) {
		const file = FILES[i % FILES.length];

		// read the module
		msg("assistant", [
			{ type: "text", text: `Reading ${file} before the rotation refactor (pass ${i}).` },
			toolCallBlock("read", { path: file }),
		]);
		toolResult(`call_${n}`, fileContent(i));

		// edit it
		msg("assistant", [
			{
				type: "text",
				text: `Rotating the verify path in ${file}: replacing the legacy bearer check with the refresh rotation (pass ${i}).`,
			},
			toolCallBlock("edit", { path: file, oldText: "legacy path kept for compatibility", newText: `rotating refresh path ${i}` }),
		]);
		toolResult(`call_${n}`, `Edited ${file}: 1 insertion, 1 deletion.`);

		// run the tests; every 7th pass fails like real life
		const failed = i % 7 === 3;
		msg("assistant", [
			{ type: "text", text: `Running the auth suite after pass ${i}.` },
			toolCallBlock("bash", { command: "npx vitest run test/auth.test.ts --reporter=verbose" }),
		]);
		toolResult(
			`call_${n}`,
			failed
				? `${bashOutput(i)}\n\nCommand failed with exit code 1:\n  ✗ src/auth/__tests__/rotation.spec.ts > refresh token rotation\n    AssertionError: expected token lifetime 3600 to be 900\n      at test/auth.test.ts:${40 + i}:${12}`
				: bashOutput(i),
			failed,
		);
		if (failed) {
			msg("assistant", [{ type: "text", text: `The rotation lifetime assertion failed; shortening the refresh window and re-checking (pass ${i}).` }]);
		}
	}
	msg("assistant", [{ type: "text", text: "All modules rotated; final suite pass pending." }]);

	writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

// CLI entry: npx tsx scripts/fixture-session.ts [outdir]
if (process.argv[1] && process.argv[1].endsWith("fixture-session.ts")) {
	import("node:fs").then((fs) => {
		const dir = process.argv[2] ?? "./.fixture";
		const file = generateFixture(dir);
		console.log(`fixture: ${file} (${(fs.statSync(file).size / 1_000_000).toFixed(1)} MB)`);
	});
}
