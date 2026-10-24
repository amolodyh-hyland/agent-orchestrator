export const RESULT_PREVIEW = "specialistResult:preview";
export const RESULT_CANCEL = "specialistResult:cancel";
export const RESULT_CLICK = "specialistResult:confirmClick";
export const RESULT_UPDATE = "specialistResult:update";
export type ResultPreview = {
 id: string; digest: string; expiresAt: number; phase: "read" | "import";
 runId: string; projectId: string; sessionId: string; serverOrigin: string; workspaceId: string; delegationId: string; taskId: string;
 scope: "task_result"; destination: "run_evidence"; untrusted: true;
 text?: string; resultRevision?: string; resultDigest?: string; byteCount?: number;
};
export type ResultUpdate = { previewId: string; ok: boolean; preview?: ResultPreview };
export type SpecialistResultBridge = {
 preview(runId: string): Promise<ResultPreview | null>;
 cancel(id: string): Promise<void>;
 onUpdate(listener: (update: ResultUpdate) => void): () => void;
};
export function installResultUserAction(doc: Document, invoke: (channel: string, input: {id: string; digest: string}) => Promise<unknown>) {
 doc.addEventListener("click", event => {
  if (!event.isTrusted || !doc.defaultView?.navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-result-preview-id]");
  if (!button || button.disabled || !button.dataset.resultPreviewId || !button.dataset.resultPreviewDigest) return;
  void invoke(RESULT_CLICK, {id:button.dataset.resultPreviewId,digest:button.dataset.resultPreviewDigest});
 },true);
}
