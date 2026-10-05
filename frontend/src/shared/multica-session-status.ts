export const MULTICA_STATUS_PUBLISH_CHANNEL = "multicaStatus:publish";

export const MULTICA_STATUS_TONES = ["ready", "attention", "pending", "working", "done", "unknown"] as const;

export type MulticaStatusTone = (typeof MULTICA_STATUS_TONES)[number];

export const MULTICA_STATUS_TONE_ORDER: Record<MulticaStatusTone, number> = {
	ready: 0,
	attention: 1,
	pending: 2,
	working: 3,
	done: 4,
	unknown: 5,
};

export const MAX_STATUS_ENTRIES = 1000;
export const MAX_STATUS_SESSION_ID = 200;
export const MAX_STATUS_LABEL = 60;
export const MAX_STATUS_DETAIL = 240;

export type MulticaLinkStatusEntry = {
	sessionId: string;
	tone: MulticaStatusTone;
	label: string;
	detail: string;
};

export type MulticaStatusSnapshot = { stale: boolean; entries: MulticaLinkStatusEntry[] };
export type MulticaStatusPublishResult = { ok: boolean };
export type AoMulticaStatusBridge = { publish: (snapshot: MulticaStatusSnapshot) => Promise<MulticaStatusPublishResult> };

const SNAPSHOT_KEYS = ["stale", "entries"];
const ENTRY_KEYS = ["sessionId", "tone", "label", "detail"];

export function isMulticaStatusSnapshot(value: unknown): value is MulticaStatusSnapshot {
	if (!isPlainObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return false;
	const snapshot = value as Record<string, unknown>;
	if (typeof snapshot.stale !== "boolean" || !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_STATUS_ENTRIES) return false;

	const seenSessionIds = new Set<string>();
	for (const value of snapshot.entries) {
		if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_KEYS)) return false;
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.sessionId !== "string" ||
				codePointLength(entry.sessionId) < 1 ||
				codePointLength(entry.sessionId) > MAX_STATUS_SESSION_ID ||
			typeof entry.tone !== "string" ||
				!MULTICA_STATUS_TONES.includes(entry.tone as MulticaStatusTone) ||
			typeof entry.label !== "string" ||
				codePointLength(entry.label) < 1 ||
				codePointLength(entry.label) > MAX_STATUS_LABEL ||
			typeof entry.detail !== "string" ||
				codePointLength(entry.detail) > MAX_STATUS_DETAIL ||
			seenSessionIds.has(entry.sessionId)
		) {
			return false;
		}
		seenSessionIds.add(entry.sessionId);
	}
	return true;
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

export function clampStatusText(text: string, max: number): string {
	if (max < 1) return "";
	const codePoints = Array.from(text);
	if (codePoints.length <= max) return text;
	return `${codePoints.slice(0, max - 1).join("")}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: object, expected: string[]): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}
