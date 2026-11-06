import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FileContentPane } from "../components/FileContentPane";
import type { FileAnnotationModel } from "../components/WorkspaceDiffView";
import { TooltipProvider } from "../components/ui/tooltip";
import { confirmPaneRemoval } from "../components/session-pane-context";
import { MAX_FILE_DRAFT_CHARS, resetFileDraftsForTests } from "../lib/file-draft-store";
import { useSessionPanesStore } from "../stores/session-panes-store";
import { useSessionPaneCloseGuard } from "./useSessionPaneCloseGuard";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/workspace-file-events", () => ({ subscribeWorkspaceFileChanges: () => () => undefined }));
vi.mock("./usePierreFileHighlight", () => ({ usePierreFileHighlightReady: () => true }));
vi.mock("../lib/api-client", () => ({ apiClient: { GET: getMock, PUT: vi.fn() }, getApiBaseUrl: () => "", apiErrorCode: () => undefined, apiErrorMessage: () => "failed" }));
vi.mock("../components/ReadOnlyFileView", () => ({ ReadOnlyFileView: ({ detail, onEditChange }: { detail: { content: string; path: string }; onEditChange: (content: string) => void }) => <textarea aria-label={`Edit ${detail.path}`} defaultValue={detail.content} onChange={(event) => onEditChange(event.target.value)} /> }));

function renderWithQuery(children: ReactNode) {
	return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>);
}
function noopAnnotation(): FileAnnotationModel {
	return { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };
}
beforeEach(() => { resetFileDraftsForTests(); getMock.mockReset(); });
describe("pane removal with unstored file drafts", () => {
	it.each(["close", "replace", "first split"] as const)("preserves unstored inactive editor text when cancelling pane %s", async (operation) => {
		const detail = { path: "src/file.ts", status: "modified", content: "original", size: 8, binary: false, deleted: false, contentTruncated: false, diff: "", diffTruncated: false, editable: true, fileFingerprint: "fp-1" };
		getMock.mockResolvedValue({ data: detail });
		useSessionPanesStore.setState({ panes: [], focusedId: null, sizes: {}, selected: [] });
		if (operation !== "first split") useSessionPanesStore.getState().openRight({ sessionId: "other" }, { sessionId: "files" });
		const paneId = operation === "first split" ? "single" : useSessionPanesStore.getState().panes[0].id;
		const chatLeave = vi.fn().mockResolvedValue(true);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		onTestFinished(() => confirm.mockRestore());
		function Pane() {
			const [visible, setVisible] = useState(true);
			useSessionPaneCloseGuard(paneId, "files", chatLeave);
			return <>
				{visible ? <FileContentPane active={false} annotation={noopAnnotation()} initialEditing initialMode="file" path="src/file.ts" sessionId="files" split={false} /> : null}
				<button onClick={async () => {
					if (!await confirmPaneRemoval(operation === "close" ? [paneId] : undefined)) return;
					const store = useSessionPanesStore.getState();
					if (operation === "close") store.close(paneId);
					else if (operation === "first split") store.openRight({ sessionId: "other" }, { sessionId: "files" });
					else { store.select({ sessionId: "files" }, false); store.select({ sessionId: "other" }, true); useSessionPanesStore.getState().viewSelected(); }
					setVisible(false);
				}} type="button">Remove view</button>
			</>;
		}
		renderWithQuery(<Pane />);
		const editor = await screen.findByRole("textbox", { name: "Edit src/file.ts" });
		const text = "x".repeat(MAX_FILE_DRAFT_CHARS + 1);
		fireEvent.change(editor, { target: { value: text } });
		const before = useSessionPanesStore.getState().panes;
		await userEvent.click(screen.getByRole("button", { name: "Remove view" }));
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("cannot be kept"));
		expect(useSessionPanesStore.getState().panes).toBe(before);
		expect(editor).toHaveValue(text);
		expect(chatLeave).not.toHaveBeenCalled();
		confirm.mockReturnValue(true);
		await userEvent.click(screen.getByRole("button", { name: "Remove view" }));
		await waitFor(() => expect(editor).not.toBeInTheDocument());
		expect(chatLeave).toHaveBeenCalledOnce();
	});

});
