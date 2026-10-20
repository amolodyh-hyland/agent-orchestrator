import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ProjectSettingsSection, ProjectSettingsRow } from "@aoagents/product-ui";
import type { components } from "../../api/schema";
import { apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { clientForSessionHost } from "../lib/host-clients";
import { aoBridge } from "../lib/bridge";
import type { ProjectSettingsSaveState } from "./ProjectSettingsForm";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

type Project = components["schemas"]["Project"];
type Instructions = components["schemas"]["ProjectInstructions"];
const scopes = ["shared", "worker", "coordinator"] as const;

export function ProjectContextSettings({ project, hostId, disabled, onSaved, onSaveState, submitRef }: { project: Project; hostId?: string; disabled: boolean; onSaved: () => void; onSaveState?: (state: ProjectSettingsSaveState) => void; submitRef?: RefObject<(() => Promise<boolean>) | null> }) {
	const { t } = useTranslation();
	const id = useId();
	const [base, setBase] = useState(project);
	const [draft, setDraft] = useState<Instructions>(project.instructions ?? {});
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [error, setError] = useState<string>();
	const [conflict, setConflict] = useState<Project>();
	const [saved, setSaved] = useState(false);
	const dirty = JSON.stringify(draft) !== JSON.stringify(base.instructions ?? {});
	useEffect(() => {
		if (!dirty && project.revision > base.revision) { setBase(project); setDraft(project.instructions ?? {}); }
	}, [project, base.revision, dirty]);
	const locked = disabled || pending;
	const attachments = draft.attachments ?? [];
	const change = (next: Instructions) => { setDraft(next); setSaved(false); };
	const reload = (next: Project) => { setBase(next); setDraft(next.instructions ?? {}); setConflict(undefined); setError(undefined); };
	const attach = async (kind: "file" | "folder") => {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true); setError(undefined); setSaved(false);
		try {
			const selected = await aoBridge.app.chooseProjectContextLink({ kind, title: t(kind === "file" ? "projectContext.addFile" : "projectContext.addFolder") });
			if (!selected) return;
			const { data, error } = await clientForSessionHost().GET("/api/v1/identity");
			if (error || !data?.hostId) throw new Error(apiErrorMessage(error));
			const name = selected.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "link";
			const bindingId = `${name}_${crypto.randomUUID().slice(0, 8)}`;
			change({ ...draft, attachments: [...attachments, { id: bindingId, sourceKind: "machine_local_file", sourceRef: crypto.randomUUID(), localPath: selected.localPath, machineId: data.hostId, mediaType: selected.mediaType, required: false, enabled: true, position: Math.max(-1, ...attachments.map((item) => item.position)) + 1, roles: ["shared"] }] });
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { pendingRef.current = false; setPending(false); }
	};
	const save = async (): Promise<boolean> => {
		if (disabled || pendingRef.current) return false;
		if (conflict) {
			// A blocked resubmission must also clear the parent's pending close.
			onSaveState?.({ phase: "failed", dirty, requestPending: false, error: t("projectContext.conflict") });
			return false;
		}
		if (!dirty) return true;
		pendingRef.current = true;
		setPending(true); setError(undefined); setSaved(false);
		try {
			const client = clientForSessionHost(hostId);
			const { data, error } = await client.PUT("/api/v1/projects/{id}", { params: { path: { id: project.id } }, body: { displayName: base.name, config: base.config ?? {}, expectedRevision: base.revision, instructions: draft } });
			if (error) {
				if (apiErrorCode(error) === "PROJECT_REVISION_CONFLICT") {
					const latest = await client.GET("/api/v1/projects/{id}", { params: { path: { id: project.id } } });
					if (latest.error) throw new Error(apiErrorMessage(latest.error));
					if (latest.data?.status !== "ok") throw new Error(t("settings.project.degraded"));
					setConflict(latest.data.project as Project);
					return false;
				}
				throw new Error(apiErrorMessage(error));
			}
			if (!data) throw new Error(t("settings.project.saveFailed"));
			reload(data.project); setSaved(true); onSaved();
			return true;
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
		finally { pendingRef.current = false; setPending(false); }
	};
	useEffect(() => {
		if (submitRef) submitRef.current = save;
		return () => { if (submitRef) submitRef.current = null; };
	}, [submitRef, save]);
	useEffect(() => {
		onSaveState?.({ phase: conflict || error ? "failed" : pending ? "saving" : dirty ? "pending" : saved ? "saved" : "idle", dirty, requestPending: pending, error: conflict ? t("projectContext.conflict") : error });
	}, [conflict, error, pending, dirty, saved, onSaveState, t]);
	return <ProjectSettingsSection title={t("projectContext.title")}>
		<div className="flex flex-col gap-3">
			{scopes.map((scope) => <div key={scope} className="flex flex-col gap-1.5">
				<Label htmlFor={`${id}-${scope}`}>{t(`projectContext.${scope}`)}</Label>
				<textarea id={`${id}-${scope}`} className="settings-field-control min-h-24 w-full px-4 py-3 text-sm" disabled={locked} value={draft[scope] ?? ""} onChange={(event) => change({ ...draft, [scope]: event.target.value })} />
			</div>)}
			<p className="text-sm text-settings-muted">{t("projectContext.linksDescription")}</p>
			{attachments.map((binding) => <ProjectSettingsRow key={binding.id} label={binding.id}>
				<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
					<span className="break-all text-xs text-settings-muted">{t(`projectContext.${binding.sourceKind}`)} · {binding.machineId ?? t("projectContext.portable")} · {t(binding.enabled ? "projectContext.resolveAtStart" : "projectContext.disabled")}</span>
					<Label htmlFor={`${id}-${binding.id}`}>{t("projectContext.required")}</Label>
					<Switch id={`${id}-${binding.id}`} aria-label={`${t("projectContext.required")}: ${binding.id}`} disabled={locked} checked={binding.required} onCheckedChange={(required) => change({ ...draft, attachments: attachments.map((item) => item.id === binding.id ? { ...item, required } : item) })} />
					<Button type="button" variant="ghost" size="sm" disabled={locked} aria-label={t("projectContext.removeLink", { name: binding.id })} onClick={() => change({ ...draft, attachments: attachments.filter((item) => item.id !== binding.id) })}>{t("projectContext.removeLink", { name: binding.id })}</Button>
				</div>
			</ProjectSettingsRow>)}
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant="outline" size="sm" disabled={locked || !!hostId || attachments.length >= 64} onClick={() => void attach("file")}>{t("projectContext.addFile")}</Button>
				<Button type="button" variant="outline" size="sm" disabled={locked || !!hostId || attachments.length >= 64} onClick={() => void attach("folder")}>{t("projectContext.addFolder")}</Button>
			</div>
			{hostId && <p className="text-sm text-settings-muted">{t("projectContext.owningMachine")}</p>}
			{conflict && <div role="alert" className="flex flex-col gap-2">
				<p className="text-sm text-error">{t("projectContext.conflict")}</p>
				{scopes.map((scope) => <div key={scope}><Label htmlFor={`${id}-latest-${scope}`}>{t("projectContext.latest", { scope: t(`projectContext.${scope}`) })}</Label><textarea id={`${id}-latest-${scope}`} readOnly className="settings-field-control min-h-16 w-full px-4 py-3 text-sm" value={conflict.instructions?.[scope] ?? ""} /></div>)}
				<div className="flex gap-2">
					<Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => reload(conflict)}>{t("projectContext.reload")}</Button>
					<Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => {
						const merged = { ...draft };
						for (const scope of scopes) {
							const local = draft[scope] ?? "", original = base.instructions?.[scope] ?? "", remote = conflict.instructions?.[scope] ?? "";
							merged[scope] = local === original ? remote : remote === original || local === remote ? local : `${remote}\n\n${local}`;
						}
						const oldIds = new Set((base.instructions?.attachments ?? []).map((item) => item.id));
						const remoteBindings = new Map((conflict.instructions?.attachments ?? []).map((item) => [item.id, item]));
						merged.attachments = [...attachments.flatMap((item) => {
							const original = base.instructions?.attachments?.find((old) => old.id === item.id);
							return original && JSON.stringify(original) === JSON.stringify(item) ? remoteBindings.has(item.id) ? [remoteBindings.get(item.id)!] : [] : [item];
						}), ...(conflict.instructions?.attachments ?? []).filter((item) => !oldIds.has(item.id) && !attachments.some((local) => local.id === item.id))];
						setBase(conflict); change(merged); setConflict(undefined); setError(undefined);
					}}>{t("projectContext.merge")}</Button>
				</div>
			</div>}
			{error && <p role="alert" className="text-sm text-error">{error}</p>}
			<div className="flex items-center gap-2"><Button type="button" size="sm" disabled={locked || !dirty || !!conflict} onClick={() => void save()}>{t("projectContext.save")}</Button>{saved && <span role="status" className="text-sm text-settings-muted">{t("projectContext.saved")}</span>}</div>
		</div>
	</ProjectSettingsSection>;
}
