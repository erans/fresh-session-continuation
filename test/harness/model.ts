import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	TextContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One scripted assistant response, consumed in order per model call. */
export interface TurnScript {
	text?: string;
	toolCalls?: { name: string; args: Record<string, unknown> }[];
	/** Serve a provider error for this turn instead of content. */
	error?: string;
}

/** What the harness records for every model call it serves. */
export interface FakeCall {
	turn: number;
	roles: string[];
	/** Text of the first user message in the call's context (pointer-prompt detection). */
	firstUser?: string;
}

export const FAKE_MODEL: Model<"fake-stream"> = {
	id: "fake-1",
	name: "Fake Scripted",
	api: "fake-stream",
	provider: "fake",
	baseUrl: "http://invalid.invalid",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 2_000,
	maxTokens: 1_000,
	reasoning: false,
	type: "chat",
};

function fakeUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function makeMessage(model: Model<Api>, content: (TextContent | ToolCall)[], stopReason: "stop" | "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: fakeUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * Extension factory registering the fake provider. Pops one TurnScript per
 * model call (repeating the last when exhausted) and records every call.
 */
export function createFakeProvider(
	turns: TurnScript[],
	log: FakeCall[],
	model: Model<"fake-stream"> = FAKE_MODEL,
): (pi: ExtensionAPI) => void {
	let i = 0;
	return (pi: ExtensionAPI) => {
		pi.registerProvider("fake", {
			name: "Fake",
			baseUrl: FAKE_MODEL.baseUrl,
			apiKey: "fake",
			api: "fake-stream",
			models: [
				{
					id: model.id,
					name: model.name,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				},
			],
			streamSimple: (model: Model<Api>, context: TranscriptContext): AssistantMessageEventStream => {
				const script = turns[Math.min(i, turns.length - 1)] ?? { text: "done" };
				const firstUser = context.messages.find((m) => m.role === "user");
				log.push({
					turn: i,
					roles: context.messages.map((m) => m.role),
					firstUser:
						typeof firstUser?.content === "string"
							? firstUser.content
							: (firstUser?.content ?? [])
									.filter((b) => b.type === "text" && typeof b.text === "string")
									.map((b) => (b as { text: string }).text)
									.join("\n"),
				});
				i++;

				const content: (TextContent | ToolCall)[] = [];
				if (script.text) content.push({ type: "text", text: script.text });
				let callIdx = 0;
				for (const call of script.toolCalls ?? []) {
					content.push({
						type: "toolCall",
						id: `call_${i}_${callIdx++}`,
						name: call.name,
						arguments: call.args as never,
					});
				}
				if (script.error) {
					const errorMessage = makeMessage(model, [{ type: "text", text: script.error }], "stop");
					const stream = createAssistantMessageEventStream();
					stream.push({
						type: "error",
						reason: "error",
						error: { ...errorMessage, stopReason: "error", errorMessage: script.error },
					});
					return stream;
				}
				const stopReason: "stop" | "toolUse" = script.toolCalls?.length ? "toolUse" : "stop";
				const message = makeMessage(model, content, stopReason);

				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				let idx = 0;
				for (const block of content) {
					if (block.type === "text") {
						stream.push({ type: "text_start", contentIndex: idx, partial: message });
						stream.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: message });
						stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: message });
					} else {
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: message });
					}
					idx++;
				}
				stream.push({ type: "done", reason: stopReason, message });
				return stream;
			},
		});
	};
}
