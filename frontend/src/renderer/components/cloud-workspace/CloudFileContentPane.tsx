import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MessageSquarePlus, Pencil, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cloudWorkspaceReviewFileQueryOptions, cloudWorkspaceReviewQueryKey, cloudWorkspaceReviewRevisionQueryOptions } from "../../hooks/useCloudWorkspaceReview";
import type { WorkspaceFileDetail } from "../../hooks/useSessionWorkspaceFiles";
import { clearFileDraftIfRevision, cloudDraftSessionKey, getFileDraft, rebaseFileDraft, setFileDraft, UNKNOWN_FILE_BASE, unstoredFileDraftReasonFor } from "../../lib/file-draft-store";
import type { CloudCpClient, CloudCpWorkspaceReviewFileResponse, CloudCpWorkspaceReviewScope } from "../../lib/cloud-cp";
import type { FileAnnotationModel } from "../WorkspaceDiffView";
import { cancelFileAnnotations, FileAnnotationComposer, FileAnnotationSendBar, PanelMessage, RetryButton } from "../WorkspaceDiffView";
import { ReadOnlyFileView } from "../ReadOnlyFileView";
import { MarkdownFileView } from "../markdown/MarkdownFileView";
import { MarkdownEditor } from "../MarkdownEditor";
import { Button } from "../ui/button";
import { CloudDiffFile } from "./CloudDiffFile";

export type CloudFileViewMode = "diff" | "file" | "rendered";
const createEditor: EditorFactory<"feedback", undefined> = (editorType, options, key) => new Editor(editorType, options, key);

function localDetail(detail: CloudCpWorkspaceReviewFileResponse): WorkspaceFileDetail {
	return { ...detail, status: detail.status === "copied" || detail.status === "untracked" ? "added" : detail.status, imageMediaType: undefined } as WorkspaceFileDetail;
}

export function CloudFileContentPane({
	annotation, baseUrl, client, commitSha, initialEditing = false, initialLine, initialMode = "diff", initialRequestKey = 0,
	onDirtyChange, onModeChange, orgId, path, scope = "combined", sessionId, split,
}: {
	annotation: FileAnnotationModel;
	baseUrl: string;
	client: CloudCpClient;
	commitSha?: string;
	initialEditing?: boolean;
	initialLine?: number;
	initialMode?: CloudFileViewMode;
	initialRequestKey?: number;
	onDirtyChange?: (dirty: boolean) => void;
	onModeChange?: (mode: CloudFileViewMode) => void;
	orgId: string;
	path: string | null;
	scope?: CloudCpWorkspaceReviewScope;
	sessionId: string;
	split: boolean;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<CloudFileViewMode>(initialMode);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const draftRef = useRef("");
	useEffect(() => { draftRef.current = draft; }, [draft]);
	const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
	const draftSessionKey = cloudDraftSessionKey(orgId, sessionId);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const query = useQuery({ ...cloudWorkspaceReviewFileQueryOptions({ client, baseUrl, orgId, sessionId, path: path ?? "", scope, commitSha }), enabled: Boolean(path) });
	const detail = query.data;
	const hasUnsavedChanges = Boolean(editing && detail && draft !== detail.content);
	const selectMode = (next: CloudFileViewMode) => {
		setMode(next);
		onModeChange?.(next);
	};
	useEffect(() => { setMode(initialMode); }, [commitSha, initialMode, initialRequestKey, path, scope]);
	useEffect(() => {
		setEditing(initialEditing);
		setDraft("");
		setRestoredDraft(null);
		setSaveError("");
	}, [commitSha, draftSessionKey, initialEditing, initialRequestKey, path, scope]);
	// A stored draft returns only for the editable working file, never for a historical revision.
	const restoredForRef = useRef<string | null>(null);
	useEffect(() => {
		if (!detail || !path) return;
		const restoreId = `${draftSessionKey}|${path}|${initialRequestKey}`;
		if (restoredForRef.current === restoreId) return;
		const saved = getFileDraft(draftSessionKey, path);
		if (!saved || saved.content === null || commitSha || !detail.editable || !detail.fileFingerprint) return;
		restoredForRef.current = restoreId;
		setEditing(true);
		setDraft(saved.content);
		draftRef.current = saved.content;
		setRestoredDraft(saved.content);
		setMode("file");
	}, [commitSha, detail, draftSessionKey, initialRequestKey, path]);
	useEffect(() => { if (initialEditing && detail && getFileDraft(draftSessionKey, path)?.content == null) setDraft(detail.content); }, [detail, draftSessionKey, initialEditing, initialRequestKey, path]);
	const changeDraft = useCallback((content: string) => {
		setDraft(content);
		draftRef.current = content;
		if (commitSha) return;
		// Back to the saved text is no draft, unless dropping the record would hide that the file
		// has changed since the edit started.
		const record = getFileDraft(draftSessionKey, path);
		const hidesConflict = record?.baseFingerprint !== undefined && record.baseFingerprint !== detail?.fileFingerprint;
		setFileDraft(draftSessionKey, path, content === detail?.content && !hidesConflict ? null : content, detail?.fileFingerprint);
	}, [commitSha, detail?.content, detail?.fileFingerprint, draftSessionKey, path]);
	const discardDraft = useCallback(() => {
		setFileDraft(draftSessionKey, path, null);
		setRestoredDraft(null);
	}, [draftSessionKey, path]);
	useEffect(() => { onDirtyChange?.(hasUnsavedChanges); }, [hasUnsavedChanges, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	const save = useCallback(async () => {
		if (!path || !detail?.fileFingerprint || saving) return;
		// Saved against the fingerprint the draft started from, so a changed file reports a conflict.
		const stored = getFileDraft(draftSessionKey, path);
		const expectedFileFingerprint = stored?.baseFingerprint ?? detail.fileFingerprint;
		const savedText = draft;
		setSaving(true); setSaveError("");
		try {
			const result = await client.updateWorkspaceReviewFile(orgId, sessionId, { path, content: draft, expectedFileFingerprint });
			queryClient.setQueryData(cloudWorkspaceReviewFileQueryOptions({ client, baseUrl, orgId, sessionId, path, scope, commitSha }).queryKey, { ...detail, ...result });
			await queryClient.invalidateQueries({ queryKey: cloudWorkspaceReviewQueryKey(baseUrl, orgId, sessionId) });
			clearFileDraftIfRevision(draftSessionKey, path, stored?.revision);
			// Newer edits build on the response fingerprint only if it holds exactly the text sent.
			const confirmed = result.content === savedText && Boolean(result.fileFingerprint);
			rebaseFileDraft(draftSessionKey, path, expectedFileFingerprint, confirmed ? result.fileFingerprint : UNKNOWN_FILE_BASE);
			// Edits typed while the save ran stay; only the saved text's editor closes.
			if (draftRef.current === savedText) { setRestoredDraft(null); setEditing(false); setDraft(""); }
		} catch (error) { setSaveError(error instanceof Error ? error.message : t("files.saveError")); }
		finally { setSaving(false); }
	}, [baseUrl, client, commitSha, detail, draft, draftSessionKey, orgId, path, queryClient, saving, scope, sessionId, t]);
	useEffect(() => {
		if (!editing) return;
		const shortcut = (event: KeyboardEvent) => { if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) { event.preventDefault(); if (hasUnsavedChanges) void save(); } };
		window.addEventListener("keydown", shortcut, true); return () => window.removeEventListener("keydown", shortcut, true);
	}, [editing, hasUnsavedChanges, save]);

	if (!path) return <PanelMessage>{t("files.explorer.selectFile")}</PanelMessage>;
	if (query.isPending) return <PanelMessage>{t("files.loading")}</PanelMessage>;
	if (query.error || !detail) return <PanelMessage action={<RetryButton onClick={() => void query.refetch()} />}>{query.error?.message ?? t("files.error.loadFile")}</PanelMessage>;
	const storedDraft = editing ? getFileDraft(draftSessionKey, path) : undefined;
	const unstoredReason = editing ? unstoredFileDraftReasonFor(draftSessionKey, path) : null;
	const draftNotice = !editing ? "" : unstoredReason
		? t(unstoredReason === "size" ? "files.draftTooLarge" : "files.draftsFull")
		: storedDraft?.baseFingerprint && storedDraft.baseFingerprint !== detail.fileFingerprint ? t("files.draftConflict") : "";
	const renderedAvailable = !detail.deleted && !detail.binary && !detail.contentTruncated && /\.(md|markdown)$/i.test(path);
	const effectiveMode = detail.status === "unmodified" && mode === "diff" ? "file" : mode === "rendered" && !renderedAvailable ? "file" : mode;
	const wholeFileAnnotationTarget = annotation.targets.find((target) => target.surface !== "review" && target.path === path && target.side === "file" && target.line == null);
	const tabs = <div className="sticky top-0 z-20 flex min-h-9 items-center gap-2 border-b border-border bg-surface px-2 py-1">
		<div aria-label={t("files.fileDisplayMode")} className="flex items-center" role="tablist">
			{detail.status !== "unmodified" ? <Button aria-selected={effectiveMode === "diff"} disabled={editing} onClick={() => selectMode("diff")} role="tab" size="sm" variant={effectiveMode === "diff" ? "secondary" : "ghost"}>{t("files.diff")}</Button> : null}
			<Button aria-selected={effectiveMode === "file"} disabled={editing} onClick={() => selectMode("file")} role="tab" size="sm" variant={effectiveMode === "file" ? "secondary" : "ghost"}>{t("files.fileView")}</Button>
			{renderedAvailable ? <Button aria-selected={effectiveMode === "rendered"} disabled={editing} onClick={() => selectMode("rendered")} role="tab" size="sm" variant={effectiveMode === "rendered" ? "secondary" : "ghost"}>{t("files.rendered")}</Button> : null}
		</div>
		{editing ? <div className="ml-auto flex gap-1"><Button aria-label={t("files.cancelEditing")} disabled={saving} onClick={() => { discardDraft(); setEditing(false); setDraft(""); setSaveError(""); }} size="sm" variant="ghost"><X />{t("files.cancelEditing")}</Button><Button aria-label={t("files.saveFile")} disabled={saving || !hasUnsavedChanges} onClick={() => void save()} size="sm" variant="primary">{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{t("files.saveFile")}</Button></div> : <><Button aria-label={t("files.editFile")} className="ml-auto" disabled={!detail.editable || !detail.fileFingerprint || Boolean(commitSha)} onClick={() => { cancelFileAnnotations(annotation, (target) => target.surface !== "review" && target.path === path); discardDraft(); selectMode("file"); setDraft(detail.content); setEditing(true); }} size="icon-sm" variant="ghost"><Pencil /></Button><Button aria-label={t("files.addFeedback")} onClick={() => annotation.begin({ path: detail.path, previousPath: detail.previousPath, side: "file", scope, surface: "focused", workspaceVersion: detail.workspaceVersion, fileFingerprint: detail.fileFingerprint })} size="icon-sm" variant="ghost"><MessageSquarePlus /></Button></>}
		{wholeFileAnnotationTarget ? <div className="absolute right-2 top-full z-50 w-[min(32rem,calc(100%-1rem))]"><FileAnnotationComposer annotation={annotation} target={wholeFileAnnotationTarget} /></div> : null}
	</div>;
	return <div className="relative min-w-0">{tabs}<EditProvider createEditor={createEditor}>{effectiveMode === "diff" ? <CloudDiffFile annotation={annotation} baseUrl={baseUrl} client={client} commitSha={commitSha} file={detail} onActiveSelectionChange={() => undefined} orgId={orgId} patch={detail.diff} scope={scope} sessionId={sessionId} split={split && (detail.status === "modified" || detail.status === "renamed")} workspaceVersion={detail.workspaceVersion} fallback={<PanelMessage>{t("files.diffUnavailable")}</PanelMessage>} /> : effectiveMode === "rendered" ? <MarkdownFileView content={detail.content} filePath={path} sessionId={sessionId} truncated={detail.contentTruncated} version={query.dataUpdatedAt} /> : <CompleteCloudFileView annotation={annotation} baseUrl={baseUrl} client={client} commitSha={commitSha} detail={editing && restoredDraft !== null ? { ...detail, content: restoredDraft } : detail} editing={editing} onEditChange={changeDraft} orgId={orgId} revealLine={initialLine ? { line: initialLine, requestKey: initialRequestKey } : undefined} scope={scope} sessionId={sessionId} />}</EditProvider>{saveError || draftNotice ? <p className="border-t border-error/40 bg-error/10 px-3 py-2 text-xs text-error" role="alert">{saveError || draftNotice}</p> : null}<FileAnnotationSendBar annotation={annotation} className="sticky bottom-0 z-20" surface="focused" /></div>;
}

function CompleteCloudFileView({ annotation, baseUrl, client, commitSha, detail, editing, onEditChange, orgId, revealLine, scope, sessionId }: { annotation: FileAnnotationModel; baseUrl: string; client: CloudCpClient; commitSha?: string; detail: CloudCpWorkspaceReviewFileResponse; editing: boolean; onEditChange: (content: string) => void; orgId: string; revealLine?: { line: number; requestKey: number }; scope: CloudCpWorkspaceReviewScope; sessionId: string }) {
	const { t } = useTranslation();
	const needsRevision = detail.deleted || detail.contentTruncated;
	const side = detail.deleted ? "before" : "after";
	const revision = useQuery({ ...cloudWorkspaceReviewRevisionQueryOptions({ client, baseUrl, orgId, sessionId, query: { path: detail.path, scope, commitSha, side, workspaceVersion: detail.workspaceVersion } }), enabled: needsRevision });
	if (needsRevision && revision.isPending) return <PanelMessage>{t("files.loading")}</PanelMessage>;
	if (revision.error) return <PanelMessage>{revision.error.message}</PanelMessage>;
	const resolved = revision.data ? { ...detail, deleted: false, binary: revision.data.binary, content: revision.data.content, contentTruncated: revision.data.truncated, size: revision.data.size } : detail;
	const local = localDetail(resolved);
	if (editing && !local.deleted && !local.binary && !local.contentTruncated && /\.(md|markdown)$/i.test(local.path)) {
		return <MarkdownEditor filePath={local.path} onChange={onEditChange} value={local.content} />;
	}
	return <ReadOnlyFileView annotation={annotation} detail={local} editing={editing} onEditChange={onEditChange} revealLine={revealLine} scope={scope === "untracked" ? "combined" : scope} sessionId={sessionId} side={side} />;
}
