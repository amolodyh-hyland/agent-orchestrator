import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import type { OuterNativeDraft, OuterResult, OuterStage } from "../../shared/outer-native";

export function useOuterView() {
	return useQuery({ queryKey: ["outer"], queryFn: async () => {
		const result = await apiClient.GET("/api/v1/outer");
		if (result.error) throw result.error;
		return result.data;
	}, refetchInterval: 5_000 });
}

// Staging is inert. Submission is owned by the isolated preload's trusted
// click/Enter listener; no effect or callback here can submit the draft.
export function useOuterNativeAction(draft: OuterNativeDraft | undefined, onResult?: (result: OuterResult) => void) {
	const slot = useId();
	const raw = draft ? JSON.stringify(draft) : "";
	const [entry, setEntry] = useState<{ raw: string; stage: OuterStage }>();
	const [result, setResult] = useState<OuterResult>();
	const resultRef = useRef(onResult); resultRef.current = onResult;
	useEffect(() => {
		const bridge=aoBridge.outer;
		if (!raw || !bridge) return;
		let cancelled = false;
		let id: string | undefined;
		void bridge.stage(slot, JSON.parse(raw) as OuterNativeDraft).catch(()=>null).then((stage) => {
			if (!stage) return;
			id = stage.id;
			if (cancelled) { void bridge.cancel(stage.id); return; }
			setEntry({ raw, stage }); setResult(undefined);
		});
		return () => { cancelled = true; if (id) void bridge.cancel(id); };
	}, [raw, slot]);
	useEffect(() => aoBridge.outer?.onResult((value) => {
		if (value.id !== entry?.stage.id) return;
		setEntry(undefined); setResult(value); resultRef.current?.(value);
		window.dispatchEvent(new Event("ao:outer-changed"));
	}), [entry]);
	const ready = entry?.raw === raw && entry.stage.expiresAt > Date.now();
	return { ready, result, attributes: {
		"data-outer-stage-id": ready ? entry.stage.id : undefined,
		"data-outer-stage-digest": ready ? entry.stage.digest : undefined,
	} };
}
