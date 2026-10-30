import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { STATE_RECORD_TYPE } from "./notices.js";

export interface SwitchPayload {
	oldSessionPath: string;
	pointerTextStatic: string;
}

export type SwitchState = "idle" | "armed" | "in-flight";

export interface StateRecordData {
	state: "armed" | "cleared";
	owner: string;
	oldSessionPath: string;
	pointerTextStatic: string;
	armedAt: number;
}

/** Append a state record to the current session (records are append-only). */
export function appendStateRecord(pi: ExtensionAPI, data: StateRecordData): void {
	pi.appendEntry(STATE_RECORD_TYPE, data);
}

/**
 * Newest state record on the active branch (leaf path) whose owner matches
 * the current session file. Never the file-wide newest. Absent, cleared,
 * or fork-copied records resolve to null (silent no-op).
 */
export function resolveActiveRecord(
	branch: SessionEntry[],
	currentFile: string,
): StateRecordData | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== STATE_RECORD_TYPE) continue;
		const data = entry.data as StateRecordData;
		if (data.state === "armed" && data.owner === currentFile) return data;
		return null; // newest state record is cleared or foreign — no-op
	}
	return null;
}

/**
 * Process-local state machine: idle → armed → in-flight → idle. One
 * instance per extension runtime, created by the factory — module-level
 * singletons would leak state across session replacements.
 */
export function createSwitchState() {
	let state: SwitchState = "idle";
	let cancelled = false;
	let active = true;
	let dispatchQueued = false;
	let payload: SwitchPayload | null = null;

	return {
		getState(): SwitchState {
			return state;
		},
		arm(p: SwitchPayload): void {
			payload = p;
			cancelled = false;
			state = "armed";
		},
		refreshInFlight(p: SwitchPayload): void {
			if (state !== "in-flight") return;
			payload = p;
		},
		toInFlight(): boolean {
			if (state === "in-flight") return false;
			state = "in-flight";
			return true;
		},
		toIdle(): void {
			state = "idle";
		},
		getPayload(): SwitchPayload | null {
			return payload;
		},
		getCancelled(): boolean {
			return cancelled;
		},
		setCancelled(): void {
			if (state === "armed" || state === "in-flight") cancelled = true;
		},
		clearCancelled(): void {
			cancelled = false;
		},
		isActive(): boolean {
			return active;
		},
		markInactive(): void {
			active = false;
		},
		getDispatchQueued(): boolean {
			return dispatchQueued;
		},
		setDispatchQueued(v: boolean): void {
			dispatchQueued = v;
		},
	};
}

export type SwitchStateInstance = ReturnType<typeof createSwitchState>;
