import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
	ExtensionAPI,
	ExtensionUIContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createFakeProvider, FAKE_MODEL, type FakeCall, type TurnScript } from "./model.js";
import type { Model } from "@earendil-works/pi-ai";

export interface TestSession {
	session: AgentSession;
	runtime: AgentSessionRuntime;
	sessionFile(): string;
	readEntries(): SessionEntry[];
	getCalls(): FakeCall[];
	/** Every ctx.ui.notify message, in order. */
	notices: string[];
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
	/** Open an existing session file instead of creating a new one. */
	openSessionFile?: string;
	/** compaction.enabled; false stages the disabled-compaction paths. */
	compactionEnabled?: boolean;
	/** Fake model context window (default 2000). Raise it to keep manual tests off the auto-compaction cliff. */
	contextWindow?: number;
}

function makeCaptureUI(notices: string[]): ExtensionUIContext {
	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string) => {
			notices.push(message);
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setEditorText: () => {},
		editor: async () => undefined,
		custom: async () => undefined,
	};
	return ui as unknown as ExtensionUIContext;
}

export async function createTestSession(opts: CreateTestSessionOptions): Promise<TestSession> {
	const cwd = opts.sessionDir;
	const agentDir = join(opts.sessionDir, "agentdir");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const calls: FakeCall[] = [];
	const notices: string[] = [];
	const fakeModel: Model<"fake-stream"> = {
		...FAKE_MODEL,
		contextWindow: opts.contextWindow ?? FAKE_MODEL.contextWindow,
	};
	const factories = [createFakeProvider(opts.turns ?? [], calls, fakeModel), ...(opts.extensions ?? [])];
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: opts.compactionEnabled ?? true,
			reserveTokens: opts.reserveTokens ?? 100,
			keepRecentTokens: opts.keepRecentTokens ?? 10,
		},
	});
	const uiContext = makeCaptureUI(notices);

	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: factories },
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: fakeModel,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};

	const sessionManager = opts.openSessionFile
		? SessionManager.open(opts.openSessionFile, undefined, cwd)
		: SessionManager.create(cwd, opts.sessionDir);
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir,
		sessionManager,
		...(opts.openSessionFile
			? { sessionStartEvent: { type: "session_start" as const, reason: "resume" as const } }
			: {}),
	});

	const rebind = async () => {
		const session = runtime.session;
		await session.bindExtensions({
			uiContext,
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async (entryId, forkOptions) => ({ cancelled: (await runtime.fork(entryId, forkOptions)).cancelled }),
				navigateTree: async (targetId, options) => ({
					cancelled: (await session.navigateTree(targetId, options)).cancelled,
				}),
				switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
		});
	};
	runtime.setRebindSession(rebind);
	await rebind();

	const session = runtime.session;
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
		runtime,
		sessionFile: () => session.sessionManager.getSessionFile() ?? "",
		readEntries,
		getCalls: () => calls,
		notices,
		dispose: async () => {
			await runtime.dispose();
		},
	};
}
