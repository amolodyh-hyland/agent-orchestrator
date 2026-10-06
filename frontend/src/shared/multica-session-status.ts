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

export type MulticaLinkStatusEntry = {
	sessionId: string;
	tone: MulticaStatusTone;
	label: string;
	detail: string;
};

export function clampStatusText(text: string, max: number): string {
	if (max < 1) return "";
	const codePoints = Array.from(text);
	if (codePoints.length <= max) return text;
	return `${codePoints.slice(0, max - 1).join("")}…`;
}
