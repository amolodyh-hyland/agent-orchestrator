import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readOuter } from "../lib/outer-read";
import { aoBridge } from "../lib/bridge";
import type {
	OuterNativeDraft,
	OuterResult,
	OuterStage,
} from "../../shared/outer-native";

export function useOuterView() {
	return useQuery({
		queryKey: ["outer"],
		queryFn: () => readOuter({ projection: "view" }),
		refetchInterval: 5_000,
	});
}

// Staging is inert. Submission is owned by the isolated preload's trusted
// click/Enter listener; no effect or callback here can submit the draft.
export function useOuterNativeAction(
	draft: OuterNativeDraft | undefined,
	onResult?: (result: OuterResult) => void
) {
	const slot = useId();
	const raw = draft ? JSON.stringify(draft) : "";
	const draftVersion = useRef({ raw, revision: 0 });
	if (draftVersion.current.raw !== raw) {
		draftVersion.current = {
			raw,
			revision: draftVersion.current.revision + 1,
		};
	}
	const knownStages = useRef(
		new Map<string, { raw: string; revision: number }>()
	);
	const [refresh, setRefresh] = useState(0);
	const [entry, setEntry] = useState<{ raw: string; stage: OuterStage }>();
	const [result, setResult] = useState<OuterResult>();
	const resultRef = useRef(onResult);
	resultRef.current = onResult;
	useEffect(() => {
		const bridge = aoBridge.outer;
		if (!raw || !bridge) return;
		let cancelled = false;
		let id: string | undefined;
		let expiry: ReturnType<typeof setTimeout> | undefined;
		const revision = draftVersion.current.revision;
		void bridge
			.stage(slot, JSON.parse(raw) as OuterNativeDraft)
			.catch(() => null)
			.then((stage) => {
				if (!stage) return;
				id = stage.id;
				if (cancelled) {
					void bridge.cancel(stage.id);
					return;
				}
				setEntry({ raw, stage });
				setResult(undefined);
				knownStages.current.set(stage.id, { raw, revision });
				if (knownStages.current.size > 64) {
					const oldest = knownStages.current.keys().next().value;
					if (oldest) knownStages.current.delete(oldest);
				}
				// Renew inert UI data only. Human authority and its two-minute
				// submission deadline begin at the later trusted Send gesture.
				expiry = setTimeout(
					() => setRefresh((value) => value + 1),
					Math.max(1, stage.expiresAt - Date.now() + 1)
				);
			});
		return () => {
			cancelled = true;
			if (expiry) clearTimeout(expiry);
			if (id) void bridge.cancel(id);
		};
	}, [raw, slot, refresh]);
	useEffect(
		() =>
			aoBridge.outer?.onResult((value) => {
				const known = knownStages.current.get(value.id);
				if (!known) return;
				knownStages.current.delete(value.id);
				setEntry((current) =>
					current?.stage.id === value.id ? undefined : current
				);
				if (
					known.raw === raw &&
					known.revision === draftVersion.current.revision
				) {
					setResult(value);
					resultRef.current?.(value);
					setRefresh((current) => current + 1);
				}
				window.dispatchEvent(new Event("ao:outer-changed"));
			}),
		[raw]
	);
	const ready = entry?.raw === raw && entry.stage.expiresAt > Date.now();
	return {
		ready,
		result,
		attributes: {
			"data-outer-stage-id": ready ? entry.stage.id : undefined,
			"data-outer-stage-digest": ready ? entry.stage.digest : undefined,
		},
	};
}
