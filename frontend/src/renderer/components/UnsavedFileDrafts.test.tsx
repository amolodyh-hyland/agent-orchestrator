import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { describeUnsavedFileDrafts, DRAFT_TEXT } from "../test/unsaved-file-drafts.test.harness";
import { FileContentPane } from "./FileContentPane";
import type { FileAnnotationModel } from "./WorkspaceDiffView";

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }));

vi.mock("../lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/platform")>()), isMacPlatform: () => true, isLinuxPlatform: () => false }));
vi.mock("../lib/workspace-file-events", () => ({ subscribeWorkspaceFileChanges: vi.fn(() => vi.fn()) }));
vi.mock("../hooks/usePierreFileHighlight", () => ({ usePierreFileHighlightReady: () => true }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, PUT: putMock },
	getApiBaseUrl: () => "",
	apiErrorMessage: (error: unknown, fallback = "Request failed") => (error instanceof Error ? error.message : fallback),
}));
vi.mock("./ReadOnlyFileView", () => ({
	ReadOnlyFileView: ({ detail, editing, onEditChange }: { detail: { content: string; path: string }; editing?: boolean; onEditChange?: (content: string) => void }) => editing
		? <textarea aria-label={`Edit ${detail.path}`} defaultValue={detail.content} onChange={(event) => onEditChange?.(event.target.value)} />
		: <code>{detail.content}</code>,
}));

const annotation: FileAnnotationModel = { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };
const loaded = {
	sessionId: "sess-1", path: "src/App.tsx", status: "modified", additions: 1, deletions: 0, size: 18, binary: false, deleted: false, editable: true,
	content: "export const x = 1;\n", contentTruncated: false, diff: "@@ -0,0 +1,1 @@\n+export const x = 1;\n", diffTruncated: false,
	workspaceVersion: "workspace-1", fileFingerprint: "file-1",
};
const EDITOR = "Edit src/App.tsx";
const editor = () => screen.getByRole("textbox", { name: EDITOR }) as HTMLTextAreaElement;

describeUnsavedFileDrafts("local", {
	draftSessionKey: "sess-1",
	path: "src/App.tsx",
	prepare: () => {
		getMock.mockReset().mockResolvedValue({ data: loaded });
		putMock.mockReset().mockResolvedValue({ data: { ...loaded, content: `${loaded.content} // ${DRAFT_TEXT}`, fileFingerprint: "file-2" } });
	},
	renderPane: (onDirtyChange) => (
		<FileContentPane annotation={annotation} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} path="src/App.tsx" sessionId="sess-1" split={false} />
	),
	editDraft: async () => {
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		await userEvent.type(editor(), ` // ${DRAFT_TEXT}`);
	},
	draft: () => editor().value,
	save: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
	discard: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
});
