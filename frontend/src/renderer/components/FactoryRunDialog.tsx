import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RunAction, RunPreview } from "../../shared/factory-run-confirmation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

// A human reviews a bounded snapshot, then the isolated preload handles the real
// click. The renderer has no confirm API or confirmation capability.
export function FactoryRunDialog({ projectId, sessionId }: { projectId: string; sessionId: string }) {
	const { t } = useTranslation();
	const copy = (key: string, fallback: string) => t(`factoryRun.${key}`, { defaultValue: fallback });
	const bridge = window.ao?.factoryRun;
	const [open, setOpen] = useState(false);
	const [runId, setRunId] = useState("");
	const [preview, setPreview] = useState<RunPreview | null>(null);
	const [message, setMessage] = useState("");
	const current = useRef<RunPreview | null>(null);
	const generation = useRef(0);
	function clear() { generation.current++; if (current.current) void bridge?.cancel(current.current.id); current.current = null; setPreview(null); }
	useEffect(() => bridge?.onResult((result) => {
		if (result.previewId !== current.current?.id) return;
		clear(); setMessage(result.ok ? copy("recorded", "Confirmation recorded. Preview again to inspect the current stage and blockers.") : copy("retry", "Confirmation was cancelled or the evidence changed. Preview again."));
	}), [bridge]);
	useEffect(() => () => { generation.current++; if (current.current) void bridge?.cancel(current.current.id); }, [bridge]);
	useEffect(() => {
		if (!preview) return;
		const timer = setTimeout(clear, Math.max(0, preview.expiresAt - Date.now())); return () => clearTimeout(timer);
	}, [preview]);
	async function load(action: RunAction) {
		clear(); const version = generation.current; setMessage("");
		try {
			const result = await bridge?.preview(runId, action);
			if (version !== generation.current) { if (result) void bridge?.cancel(result.id); return; }
			if (!result || result.detail.run.projectId !== projectId || result.detail.run.sessionId !== sessionId) {
				if (result) void bridge?.cancel(result.id);
				setMessage(copy("unavailable", "No matching local run is available for this session.")); return;
			}
			current.current = result; setPreview(result);
		} catch { setMessage(copy("unavailable", "No matching local run is available for this session.")); }
	}
	if (!bridge) return null;
	return <>
		<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{copy("open", "Run evidence")}</Button>
		<Dialog open={open} onOpenChange={(value) => { clear(); setOpen(value); }}>
			<DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{copy("title", "Review run evidence")}</DialogTitle></DialogHeader>
				<p>{copy("help", "Submissions are unconfirmed claims. Each receipt and stage decision requires a separate native confirmation. This records evidence only.")}</p>
				<Input aria-label={copy("id", "Run ID")} value={runId} onChange={(event) => { clear(); setRunId(event.target.value); }} />
				<Button onClick={() => void load("evidence")}>{copy("receipt", "Preview pending claim")}</Button>
				<Button onClick={() => void load("advance")}>{copy("stage", "Preview stage decision")}</Button>
				{preview ? <>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(preview.detail, null, 2)}</pre>
					<p className="break-all text-xs">{preview.digest}</p>
					<Button data-run-preview-id={preview.id} data-run-preview-digest={preview.digest}>{copy("confirm", "Review native confirmation")}</Button>
				</> : null}
				{message ? <p role="status">{message}</p> : null}
			</DialogContent>
		</Dialog>
	</>;
}
