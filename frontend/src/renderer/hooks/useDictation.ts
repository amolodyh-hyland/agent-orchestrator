import { useCallback, useEffect, useRef, useState } from "react";
import type { DictationAvailability, DictationBridge, DictationError } from "../../shared/dictation";
import { aoBridge } from "../lib/bridge";

type Phase = "idle" | "starting" | "recording" | "stopping" | "finishing";

export function useDictation({ disabled, scope, locale, onTranscript, bridge = aoBridge.dictation }: {
	disabled: boolean;
	scope: string | undefined;
	locale: string;
	onTranscript: (text: string) => void;
	bridge?: DictationBridge;
}) {
	const [availability, setAvailability] = useState<DictationAvailability>({ available: false, error: "unavailable" });
	const [availabilityChecked, setAvailabilityChecked] = useState(false);
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<DictationError>();
	const current = useRef<{ id: string; phase: Phase; scope: string | undefined; locale: string } | undefined>(undefined);
	const context = useRef({ scope, locale });
	context.current = { scope, locale };
	const insert = useRef(onTranscript);
	insert.current = onTranscript;
	const blocked = useRef(disabled);
	blocked.current = disabled;
	const cancel = useCallback(() => {
		const recording = current.current;
		current.current = undefined;
		setPhase("idle");
		if (recording) void bridge?.cancel(recording.id).catch(() => undefined);
	}, [bridge]);

	useEffect(() => {
		let disposed = false;
		setAvailability({ available: false, error: "unavailable" });
		setAvailabilityChecked(false);
		setError(undefined);
		const refresh = (event?: Event) => {
			if (current.current || event?.target instanceof Node) return;
			void (bridge?.availability(locale) ?? Promise.resolve({ available: false, error: "unsupported" } as const))
				.then((result) => {
					if (disposed) return;
					setAvailabilityChecked(true);
					if (result.available) setError(undefined);
					setAvailability((previous) => previous.available === result.available && (previous.available || (!result.available && previous.error === result.error)) ? previous : result);
				})
				.catch(() => { if (!disposed) { setAvailabilityChecked(true); setAvailability({ available: false, error: "unavailable" }); } });
		};
		refresh();
		window.addEventListener("focus", refresh);
		return () => { disposed = true; window.removeEventListener("focus", refresh); cancel(); };
	}, [bridge, cancel, locale, scope]);

	useEffect(() => {
		if (disabled) cancel();
	}, [cancel, disabled]);

	useEffect(() => {
		const hidden = () => { if (document.hidden) cancel(); };
		document.addEventListener("visibilitychange", hidden);
		const unsubscribe = bridge?.onEvent((event) => {
			if (current.current?.id !== event.id) return;
			if (current.current.scope !== context.current.scope || current.current.locale !== context.current.locale) { cancel(); return; }
			if (event.type === "recording") {
				if (current.current.phase === "starting") {
					current.current.phase = "recording";
					setPhase("recording");
				}
				return;
			}
			if (event.type === "capture-stopped") {
				current.current.phase = "finishing";
				setPhase("finishing");
				return;
			}
			current.current = undefined;
			setPhase("idle");
			if (event.type === "error") setError(event.error);
			if (event.type === "result" && !blocked.current && event.text) insert.current(event.text);
		});
		return () => { document.removeEventListener("visibilitychange", hidden); unsubscribe?.(); cancel(); };
	}, [bridge, cancel]);

	const start = useCallback(async () => {
		if (blocked.current || current.current || !availability.available || !bridge) return;
		const id = crypto.randomUUID();
		current.current = { id, phase: "starting", scope, locale };
		setPhase("starting");
		setError(undefined);
		try {
			const result = await bridge.start(id, locale);
			if (current.current?.id !== id) return;
			if (result.error) {
				current.current = undefined;
				setPhase("idle");
				setError(result.error);
			}
		} catch {
			if (current.current?.id !== id) return;
			cancel();
			setError("failed");
		}
	}, [availability, bridge, cancel, locale, scope]);

	const stop = useCallback(async () => {
		const recording = current.current;
		if (!recording || recording.phase !== "recording") return;
		recording.phase = "stopping";
		setPhase("stopping");
		try { await bridge?.stop(recording.id); }
		catch {
			if (current.current !== recording) return;
			cancel();
			setError("failed");
		}
	}, [bridge, cancel]);

	return { availability, availabilityChecked, phase, active: phase !== "idle", error, start, stop, cancel, isActive: () => current.current !== undefined };
}
