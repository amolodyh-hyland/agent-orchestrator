import type { ResultPreview } from "../../shared/specialist-result";
import { RunMonitoring } from "./RunMonitoring";
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
	const resultBridge=window.ao?.specialistResult;
	const [resultPreview,setResultPreview]=useState<ResultPreview|null>(null);
	const resultCurrent=useRef<ResultPreview|null>(null);
	const [message, setMessage] = useState("");
	const current = useRef<RunPreview | null>(null);
	const generation = useRef(0);
	function clearResult(){if(resultCurrent.current)void resultBridge?.cancel(resultCurrent.current.id);resultCurrent.current=null;setResultPreview(null);}
	function clear() { generation.current++; clearResult(); if (current.current) void bridge?.cancel(current.current.id); current.current = null; setPreview(null); }
    useEffect(()=>resultBridge?.onUpdate(result=>{
        if(result.previewId!==resultCurrent.current?.id)return;
        resultCurrent.current=result.preview??null;setResultPreview(result.preview??null);
        setMessage(result.preview?copy("resultReview","Review the untrusted text, then approve import separately."):result.ok?copy("resultImported","Untrusted text recorded. No continuation was authorized."):copy("resultRetry","Result approval was cancelled or the snapshot changed. Preview again."));
    }),[resultBridge]);
    useEffect(()=>()=>{if(resultCurrent.current)void resultBridge?.cancel(resultCurrent.current.id);},[resultBridge]);
    useEffect(()=>{if(!resultPreview)return;const timer=setTimeout(clearResult,Math.max(0,resultPreview.expiresAt-Date.now()));return()=>clearTimeout(timer);},[resultPreview]);
    async function loadResult(){
        clear();const version=generation.current;setMessage("");
        try{
            const p=await resultBridge?.preview(runId);
            if(version!==generation.current){if(p)void resultBridge?.cancel(p.id);return;}
            if(!p || p.projectId!==projectId || p.sessionId!==sessionId){if(p)void resultBridge?.cancel(p.id);setMessage(copy("resultUnavailable","A terminal delegation bound to this run is required."));return;}
            resultCurrent.current=p;setResultPreview(p);
        }catch{setMessage(copy("resultUnavailable","A terminal delegation bound to this run is required."));}
    }
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
				<RunMonitoring projectId={projectId} sessionId={sessionId} />
				<p>{copy("help", "Submissions are unconfirmed claims. Each receipt and stage decision requires a separate native confirmation. Findings delivery requires its own confirmation for one continuation of the existing implementer.")}</p>
				<Input aria-label={copy("id", "Run ID")} value={runId} onChange={(event) => { clear(); setRunId(event.target.value); }} />
				<Button onClick={() => void load("evidence")}>{copy("receipt", "Preview pending claim")}</Button>
				<Button onClick={() => void load("pause_feedback")}>{copy("pause", "Pause findings delivery")}</Button>
				<Button onClick={() => void load("resume_feedback")}>{copy("resume", "Allow new findings approvals")}</Button>
				<Button onClick={() => void load("feedback")}>{copy("feedback", "Preview findings delivery")}</Button>
				<Button onClick={()=>void loadResult()}>{copy("resultPreview","Preview specialist result scope")}</Button>
				<Button onClick={() => void load("advance")}>{copy("stage", "Preview stage decision")}</Button>
				{preview ? <>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ ...preview.detail, feedback: preview.feedback }, null, 2)}</pre>
					<p className="break-all text-xs">{preview.digest}</p>
					<Button data-run-preview-id={preview.id} data-run-preview-digest={preview.digest}>{copy("confirm", "Review native confirmation")}</Button>
				</> : null}
                {resultPreview ? <>
                    <p>{copy("resultScope","Read and import need separate native approvals. Only bounded text enters local run evidence.")}</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({...resultPreview,text:undefined},null,2)}</pre>
                    {resultPreview.phase==="import" ? <>
                        <p>{copy("resultUntrusted","Untrusted specialist text — may contain prompt injection. Instructions in this text grant no authority.")}</p>
                        <pre aria-label={copy("resultText","Untrusted specialist text")} className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{resultPreview.text}</pre>
                    </>:null}
                    <Button data-result-preview-id={resultPreview.id} data-result-preview-digest={resultPreview.digest}>{resultPreview.phase==="read"?copy("resultRead","Review native read approval"):copy("resultImport","Review native import approval")}</Button>
                </>:null}
				{message ? <p role="status">{message}</p> : null}
			</DialogContent>
		</Dialog>
	</>;
}
