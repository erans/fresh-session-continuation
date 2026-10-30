/**
 * Notice texts — single source of truth, copied verbatim from the design
 * spec's notice table. Stage 0b/3/4a/4b/5 assert these exact strings.
 */
export const STATE_RECORD_TYPE = "fresh-session-switch";

export const NOTICES = {
	switch: (newFilePath: string, oldPath: string) =>
		`Context full → fresh session ${newFilePath} (previous session preserved: ${oldPath})`,
	degraded: (error: string | undefined) =>
		`Switch to a fresh session did not land; continuing with recall on pointer context (${
			error ?? "the switch was not dispatched"
		})`,
	treeCancelled: () => `fresh-session switch cancelled by tree navigation`,
	switchCancelled: () => `fresh-session switch cancelled by session_before_switch`,
	preflight: (check: string) => `pre-flight failed (${check}); staying on pointer context — the run is safe`,
	imagesCapped: (n: number) => `last message images capped at ${n}; use recall { tail } for the rest`,
	inProgress: () => `a switch is already in progress`,
	inputLost: () =>
		`input submitted during the switch was not delivered and is not in the record; re-send if needed`,
	continuationFailed: (error: string) => `switched, but continuation failed (${error})`,
	newestPrompt: () => `newest prompt not yet persisted; re-read it with recall { tail }`,
	notPersisted: () =>
		`Session is not persisted (--no-session): recall unavailable; default compaction used`,
	minimalPointer: (error: string) =>
		`Pointer built from partial data (${error}); recall the record for anything missing`,
	compactionDisabled: () =>
		`automatic fresh-session continuation requires the compaction machinery enabled (the default)`,
} as const;
