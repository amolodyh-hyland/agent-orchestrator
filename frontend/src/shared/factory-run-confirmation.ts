export const RUN_PREVIEW = "factoryRun:preview";
export const RUN_CANCEL = "factoryRun:cancel";
export const RUN_CONFIRM_CLICK = "factoryRun:confirmClick";
export const RUN_RESULT = "factoryRun:result";
export type RunAction = "evidence" | "advance" | "feedback" | "pause_feedback" | "resume_feedback";
export type RunPreview = { id: string; digest: string; action: RunAction; expiresAt: number; feedback?: { payload: string; sessionId: string; sha: string; round: number; targetDigest: string }; detail: {
	run: { id: string; projectId: string; sessionId: string; version: number; stage: string };
	evidence: unknown[]; observed: unknown[]; blockers: string[]; nextAction: string;
} };
export type RunResult = { previewId: string; ok: boolean };
export type RunConfirmationBridge = {
	preview(runId: string, action: RunAction): Promise<RunPreview | null>;
	cancel(id: string): Promise<void>;
	onResult(listener: (result: RunResult) => void): () => void;
};
// This function runs in the isolated preload, never in the page world. A scripted
// click or direct renderer bridge call cannot produce the confirmation IPC.
export function installRunUserAction(doc: Document, invoke: (channel: string, input: {id: string; digest: string}) => Promise<unknown>) {
	doc.addEventListener("click", (event) => {
		if (!event.isTrusted || !doc.defaultView?.navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>("button[data-run-preview-id]");
		if (!button || button.disabled || !button.dataset.runPreviewId || !button.dataset.runPreviewDigest) return;
		void invoke(RUN_CONFIRM_CLICK, { id: button.dataset.runPreviewId, digest: button.dataset.runPreviewDigest });
	}, true);
}
