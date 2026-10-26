export const DICTATION_CHANNEL = "dictation:command";
export const DICTATION_EVENT_CHANNEL = "dictation:event";

export type DictationError = "unsupported" | "unavailable" | "permission" | "microphone" | "busy" | "timeout" | "failed";
export type DictationAvailability = { available: true } | { available: false; error: DictationError };
export type DictationEvent =
	| { type: "recording" }
	| { type: "result"; text: string }
	| { type: "cancelled" }
	| { type: "error"; error: DictationError };
export type DictationUpdate = DictationEvent & { id: string };

export interface DictationEngine {
	availability(locale: string): Promise<DictationAvailability>;
	start(locale: string, emit: (event: DictationEvent) => void): void;
	stop(): void;
	cancel(): void;
}

export interface DictationBridge {
	availability(locale: string): Promise<DictationAvailability>;
	start(id: string, locale: string): Promise<{ error?: DictationError }>;
	stop(id: string): Promise<void>;
	cancel(id: string): Promise<void>;
	onEvent(listener: (event: DictationUpdate) => void): () => void;
}

export function dictationLocale(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value) ? value : undefined;
}

export function parseDictationEvent(value: unknown): DictationEvent | undefined {
	if (!value || typeof value !== "object" || !("type" in value)) return undefined;
	if (value.type === "recording" || value.type === "cancelled") return { type: value.type };
	if (value.type === "result" && "text" in value && typeof value.text === "string" && value.text.length <= 32_768) return { type: "result", text: value.text };
	if (value.type === "error" && "error" in value && ["unsupported", "unavailable", "permission", "microphone", "busy", "timeout", "failed"].includes(String(value.error))) {
		return { type: "error", error: value.error as DictationError };
	}
	return undefined;
}
