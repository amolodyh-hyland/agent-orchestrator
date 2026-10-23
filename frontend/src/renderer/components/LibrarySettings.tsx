import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectSettingsSection } from "@aoagents/product-ui";
import type { components } from "../../api/schema";
import { clientForSessionHost } from "../lib/host-clients";
import { apiErrorMessage } from "../lib/api-client";
import { Button } from "./ui/button";

type Result = components["schemas"]["LibraryResult"];
type Operation = components["schemas"]["LibraryOperation"];
type Entry = components["schemas"]["LibraryEntry"];

export function LibrarySettings({ projectId, hostId, disabled }: { projectId: string; hostId?: string; disabled: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [result, setResult] = useState<Result>();
	const [review, setReview] = useState<Operation>();
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const requestPending = useRef(false);
	const destination = JSON.stringify([hostId ?? "local", projectId]);
	const currentDestination = useRef(destination);
	currentDestination.current = destination;
	const [loadedDestination, setLoadedDestination] = useState(destination);
	const visibleResult = loadedDestination === destination ? result : undefined;
	const locked = disabled || pending;
	useEffect(() => { setResult(undefined); setReview(undefined); setError(undefined); setLoadedDestination(destination); }, [destination]);

	async function load() {
		if (locked || requestPending.current) return;
		requestPending.current = true; setPending(true); setReview(undefined); setError(undefined);
		try {
			const { data, error } = await clientForSessionHost(hostId).GET("/api/v1/library");
			if (error || !data) throw error;
			if (currentDestination.current !== destination) return;
			setResult(data); setLoadedDestination(destination);
		} catch (error) { if (currentDestination.current === destination) setError(apiErrorMessage(error)); }
		finally { requestPending.current = false; setPending(false); }
	}

	async function operate(operation: Operation) {
		if (locked || requestPending.current || !visibleResult || operation.expectedRevision !== visibleResult.revision) return;
		requestPending.current = true; setPending(true); setError(undefined); setReview(undefined);
		try {
			const { data, error } = await clientForSessionHost(hostId).POST("/api/v1/library/operations", { body: operation });
			if (error || !data) throw error;
			if (currentDestination.current !== destination) return;
			setResult(data);
			void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "conversation-skills" || query.queryKey[0] === "remote-conversation-skills" });
		} catch (error) { if (currentDestination.current === destination) setError(apiErrorMessage(error)); }
		finally { requestPending.current = false; setPending(false); }
	}

	function request(operation: Omit<Operation, "expectedRevision">) {
		if (visibleResult) setReview({ ...operation, expectedRevision: visibleResult.revision });
	}
	function bind(entry: Entry) {
		const source = visibleResult?.sources.find((source) => source.sourceId === entry.sourceId);
		if (!source) return;
		request({ operation: "bind", binding: {
			bindingId: `bind_${crypto.randomUUID().replaceAll("-", "")}`, ownerId: source.ownerId,
			projectId, sourceId: source.sourceId, entryId: entry.entryId, approvedContentHash: entry.contentHash,
			roles: ["chat"], position: visibleResult?.bindings.length ?? 0, required: false, enabled: true, revision: 0,
		} });
	}

	return <ProjectSettingsSection title={t("library.title")}>
		<div className="flex flex-col gap-3">
			<Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void load()}>{t("library.showSources")}</Button>
			{visibleResult ? <>
				<p className="text-sm text-muted-foreground">{t("library.destination", { host: hostId ?? t("library.localHost"), project: projectId })}</p>
				{visibleResult.warnings?.map((warning) => <p role="status" key={warning} className="text-sm text-warning">{warning}</p>)}
				{visibleResult.sources.length === 0 ? <p className="text-sm text-muted-foreground">{t("library.empty")}</p> : null}
				<div className="divide-y divide-border">
					{visibleResult.sources.map((source) => <div key={source.sourceId} className="py-2">
						<p className="text-sm">{source.sourceId} · {source.scope} · {source.ownerId} · {source.inspectionState}</p>
						<p className="break-all text-xs text-muted-foreground">{source.resolverId} · {source.rootRef} · {source.rootGeneration} · {source.revision}</p>
						<Button type="button" variant="ghost" size="sm" disabled={locked || source.detached} onClick={() => request({ operation: source.inspectionState === "inspection_allowed" ? "inspect" : "allow_inspection", sourceId: source.sourceId, rootIdentity: { resolverId: source.resolverId, rootRef: source.rootRef, rootGeneration: source.rootGeneration } })}>{t(source.inspectionState === "inspection_allowed" ? "library.inspect" : "library.allowInspection")}</Button>
						{visibleResult.entries.filter((entry) => entry.sourceId === source.sourceId).map((entry) => <div key={entry.entryId} className="py-1 text-sm">
							<p>{entry.displayName} · {entry.entryId}</p><p className="break-all text-xs text-muted-foreground">{entry.contentHash} · {entry.status} · {entry.reasonCode}</p>
							{visibleResult.preview?.filter((staged) => staged.entry.entryId === entry.entryId && staged.present).map((staged) => <div key={staged.entry.entryId}>
								{entry.files.map((file) => <details key={file.path}><summary className="text-xs">{file.path} · {file.sizeBytes} · {file.sha256}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{staged.content?.[file.path]}</pre></details>)}
								{["rule", "skill", "prompt_command"].includes(entry.kind) ? <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => request({ operation: "approve", sourceId: source.sourceId, rootIdentity: staged.rootIdentity, entries: [{ entryId: entry.entryId, contentHash: entry.contentHash }], purposes: [entry.kind === "rule" ? "load_context" : entry.kind === "prompt_command" ? "invoke_prompt_command" : "materialize_skill"] })}>{t("library.approve")}</Button> : null}
							</div>)}
							<Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => bind(entry)}>{t("library.bind")}</Button>
						</div>)}
					</div>)}
				</div>
				{visibleResult.approvals.map((approval) => <div key={approval.approvalId} className="text-sm">
					<p>{approval.approvalId} · {approval.state} · {approval.policyRevision}</p>
					<Button type="button" variant="ghost" size="sm" disabled={locked || approval.state !== "approved"} onClick={() => request({ operation: "revoke", approvalId: approval.approvalId })}>{t("library.revoke")}</Button>
				</div>)}
				<p className="text-sm text-muted-foreground">{t("library.futureSessions")}</p>
			</> : null}
			{review && visibleResult ? <div role="region" aria-label={t("library.review")} className="flex flex-col gap-2">
				<p className="text-sm">{t("library.review")}</p>
				{review.purposes?.includes("materialize_skill") ? <p className="text-sm text-muted-foreground">{t("library.automaticSelection")}</p> : null}
				<p className="text-xs text-muted-foreground">{t("library.destination", { host: hostId ?? t("library.localHost"), project: projectId })}</p>
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(review.operation === "revoke" ? { ...review, approval: visibleResult.approvals.find((approval) => approval.approvalId === review.approvalId) } : review, null, 2)}</pre>
				<div className="flex gap-2"><Button type="button" size="sm" disabled={locked} onClick={() => void operate(review)}>{t("library.confirm")}</Button><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setReview(undefined)}>{t("library.cancel")}</Button></div>
			</div> : null}
			{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
		</div>
	</ProjectSettingsSection>;
}
