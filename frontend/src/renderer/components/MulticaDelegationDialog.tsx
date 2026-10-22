import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { delegationFailureLabels, delegationPolicyLabels, delegationStateLabels, type DelegationConfirmationBridge, type DelegationDraft, type DelegationPreview } from "../../shared/multica-delegation-confirmation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function MulticaDelegationDialog({ orchestrator, projectId, taskId = "", title = "", bridge = window.ao?.multicaDelegation }: {
	orchestrator: "task" | "project"; projectId: string; taskId?: string; title?: string; bridge?: DelegationConfirmationBridge;
}) {
	const { t } = useTranslation();
	const copy = (key: string, fallback: string) => t(`multica.delegation.${key}`, { defaultValue: fallback });
	const failure = (code: string) => copy(`failure.${code}`, delegationFailureLabels[code] ?? "Delegation could not be confirmed. Preview again.");
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<DelegationDraft>({ orchestrator, projectId, taskId, title, workspaceId: "", profileId: "", runtimeId: "", brief: "" });
	const [preview, setPreview] = useState<DelegationPreview | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [credential, setCredential] = useState("");
	const active = useRef<DelegationPreview | null>(null);
	const generation = useRef(0);
	const source = useRef({ orchestrator, projectId, taskId, title });
	function invalidate() {
		generation.current++;
		if (active.current) void bridge?.cancelPreview(active.current.id);
		active.current = null;
		setPreview(null);
	}
	useEffect(() => {
		if (source.current.orchestrator === orchestrator && source.current.projectId === projectId && source.current.taskId === taskId && source.current.title === title) return;
		source.current = { orchestrator, projectId, taskId, title };
		invalidate(); setBusy(false); setMessage("");
		setDraft((d) => ({ ...d, orchestrator, projectId, taskId, title }));
	}, [orchestrator, projectId, taskId, title]);
	useEffect(() => {
		return () => { generation.current++; if (active.current) void bridge?.cancelPreview(active.current.id); active.current = null; };
	}, [bridge]);
	useEffect(() => bridge?.onResult(({ previewId, result }) => {
		if (active.current?.id !== previewId) return;
		active.current = null;
		setPreview(null);
		setBusy(false);
		setMessage(result.ok && "state" in result ? copy(`state.${result.state}`, delegationStateLabels[result.state] ?? "Review delegation status before trying again.") : !result.ok ? failure(result.code) : "");
	}), [bridge]);
	useEffect(() => {
		if (!preview) return;
		const timer = setTimeout(() => { invalidate(); setMessage(failure("confirmation_required")); }, Math.max(0, preview.expiresAt - Date.now()));
		return () => clearTimeout(timer);
	}, [preview]);
	function change(field: keyof DelegationDraft, value: string) {
		invalidate(); setMessage(""); setDraft((d) => ({ ...d, [field]: value }));
	}
	async function buildPreview() {
		invalidate();
		const version = generation.current;
		setBusy(true); setMessage("");
		try {
			const result = await bridge!.preview(draft);
			if (generation.current !== version) { if (result.ok && "preview" in result) void bridge?.cancelPreview(result.preview.id); return; }
			if (result.ok && "preview" in result) { active.current = result.preview; setPreview(result.preview); }
			else if (!result.ok) setMessage(failure(result.code));
		} catch { setMessage(copy("previewFailed", "Delegation could not be previewed.")); }
		finally { if (generation.current === version) setBusy(false); }
	}
	if (!bridge) return null;
	return <>
		<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{copy("open", "Delegate to Multica")}</Button>
		<Dialog open={open} onOpenChange={(value) => { if (!value) { invalidate(); setBusy(false); setCredential(""); } setOpen(value); }}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader><DialogTitle>{orchestrator === "task" ? copy("taskTitle", "Delegate task to Multica") : copy("projectTitle", "Delegate from project orchestrator")}</DialogTitle></DialogHeader>
				<div className="grid gap-3">
					{([ ["workspaceId", copy("workspace", "Multica workspace ID")], ["profileId", copy("profileId", "Profile ID")], ["runtimeId", copy("runtimeId", "Bound runtime ID")],
						["taskId", copy("taskId", "AO task ID")], ["title", copy("title", "Title")] ] as const).map(([field, label]) => <Label key={field} className="grid gap-1">
						{label}<Input value={draft[field]} onChange={(event) => change(field, event.target.value)} disabled={busy} />
					</Label>)}
					<Label className="grid gap-1">{copy("brief", "Task brief")}<textarea className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm" value={draft.brief} disabled={busy} onChange={(event) => change("brief", event.target.value)} /></Label>
					{preview ? <div className="grid gap-2 text-sm" aria-label={copy("preview", "Delegation preview")}>
						<dl className="grid gap-1">
							<dt>{copy("profile", "Profile")}</dt><dd>{preview.profileName} ({preview.request.profileId})</dd>
							<dt>{copy("runtime", "Bound runtime")}</dt><dd>{preview.request.runtimeId}</dd>
							<dt>{copy("destination", "Destination")}</dt><dd>{preview.serverOrigin} ({preview.serverKey}) / {preview.request.workspaceId}</dd>
							<dt>{copy("source", "AO source")}</dt><dd>{preview.request.projectId} / {preview.request.taskId}</dd>
							<dt>{copy("policy", "Policy source")}</dt><dd>{copy(preview.policy, delegationPolicyLabels[preview.policy])}</dd>
							<dt>{copy("scope", "Approved context and data scope")}</dt><dd>{copy("briefScope", "Task brief and AO project/task identifiers only. No files, roots, attachments or history.")}</dd>
							<dt>{copy("title", "Title")}</dt><dd>{preview.request.title}</dd>
							<dt>{copy("brief", "Task brief")}</dt><dd className="whitespace-pre-wrap break-words">{preview.request.brief}</dd>
						</dl>
						<Button data-delegation-preview-id={preview.id} data-delegation-preview-hash={preview.hash}>{copy("confirm", "Confirm delegation")}</Button>
					</div> : <Button disabled={busy} onClick={() => void buildPreview()}>{busy ? copy("preparing", "Preparing preview…") : copy("previewAction", "Preview delegation")}</Button>}
					{message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
					{message === failure("no_token") ? <div className="grid gap-2">
						<Label className="grid gap-1">{copy("credential", "Member Public API token")}<Input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} /></Label>
						<Button variant="outline" disabled={!credential || busy} onClick={async () => {
							const token = credential; setCredential(""); setBusy(true);
							try { setMessage(await bridge.setCredential(draft.workspaceId, token) ? copy("credentialSaved", "Credential saved for this server and workspace. Preview again.") : copy("credentialFailed", "Credential could not be saved.")); }
							catch { setMessage(copy("credentialFailed", "Credential could not be saved.")); } finally { setBusy(false); }
						}}>{copy("saveCredential", "Save credential")}</Button>
					</div> : null}
					<Button variant="outline" onClick={() => { invalidate(); setOpen(false); setBusy(false); setCredential(""); }}>{copy("cancel", "Cancel")}</Button>
				</div>
			</DialogContent>
		</Dialog>
	</>;
}
