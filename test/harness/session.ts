import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createFakeProvider, FAKE_MODEL, type FakeCall, type TurnScript } from "./model.js";

export interface TestSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionFile(): string;
	readEntries(): SessionEntry[];
	getCalls(): FakeCall[];
	dispose(): Promise<void>;
}

export interface CreateTestSessionOptions {
	/** Directory for the file-backed session store; also used as the isolated cwd/agentDir. */
	sessionDir: string;
	/** Scripted fake-model responses, consumed in order. */
	turns?: TurnScript[];
	/** Inline extension factories loaded after the fake provider (the extension under test goes here). */
	extensions?: ((pi: ExtensionAPI) => void | Promise<void>)[];
	/** compaction.reserveTokens; small default forces the threshold on the first turn. */
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export async function createTestSession(opts: CreateTestSessionOptions): Promise<TestSession> {
	const cwd = opts.sessionDir;
	const agentDir = join(opts.sessionDir, "agentdir");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const calls: FakeCall[] = [];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [createFakeProvider(opts.turns ?? [], calls), ...(opts.extensions ?? [])],
	});
	await loader.reload();

	const sessionManager = SessionManager.create(cwd, opts.sessionDir);
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: opts.reserveTokens ?? 100,
			...(opts.keepRecentTokens !== undefined ? { keepRecentTokens: opts.keepRecentTokens } : {}),
		},
	});

	const { session } = await createAgentSession({
		cwd,
		model: FAKE_MODEL,
		settingsManager,
		resourceLoader: loader,
		sessionManager,
	});

	const readEntries = (): SessionEntry[] => {
		const file = session.sessionManager.getSessionFile();
		if (!file) return [];
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionEntry);
	};

	return {
		session,
		sessionFile: () => session.sessionManager.getSessionFile() ?? "",
		readEntries,
		getCalls: () => calls,
		dispose: async () => {
			session.dispose();
		},
	};
}
