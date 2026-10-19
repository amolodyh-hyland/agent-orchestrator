import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { draftedFilePaths, getFileDraft, MAX_FILE_DRAFT_CHARS, MAX_FILE_DRAFTS, resetFileDraftsForTests, setFileDraft } from "../lib/file-draft-store";
import { describeUnsavedFileDrafts, DRAFT_TEXT, LEAVE_TOO_LARGE_MESSAGE, renderUnsavedFileDrafts } from "../test/unsaved-file-drafts.test.harness";
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
	prepareAgain: async () => {
		getMock.mockReset().mockResolvedValue({ data: loaded });
	},
	baseFingerprint: "file-1",
	savedFingerprint: "file-2",
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
	typeMore: async (text) => { await userEvent.type(editor(), text); },
	deferNextSave: (response = "exact") => {
		let answer: (value: unknown) => void = () => {};
		putMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
		return async () => {
			const content = response === "exact" ? putMock.mock.calls.at(-1)?.[1]?.body?.content : "written by another tool\n";
			await act(async () => answer({ data: { ...loaded, content, fileFingerprint: "file-2" } }));
		};
	},
	startSave: async () => { await userEvent.click(screen.getByRole("button", { name: "Save" })); },
	externalChange: () => { getMock.mockResolvedValue({ data: { ...loaded, content: "export const x = 99;\n", fileFingerprint: "file-3" } }); },
	lastSaveExpectedFingerprint: () => putMock.mock.calls.at(-1)?.[1]?.body?.expectedFileFingerprint,
	save: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
	discard: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
});

describe("a local draft too large to keep", () => {
	it("says so and warns that leaving discards it", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		resetFileDraftsForTests();
		getMock.mockReset().mockResolvedValue({ data: loaded });
		const history = await renderUnsavedFileDrafts("sess-1", "src/App.tsx", (onDirtyChange) => (
			<FileContentPane annotation={annotation} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} path="src/App.tsx" sessionId="sess-1" split={false} />
		));
		await history.click("open file");
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		fireEvent.change(editor(), { target: { value: "x".repeat(MAX_FILE_DRAFT_CHARS + 1) } });

		expect(await screen.findByRole("alert")).toHaveTextContent("too large to keep");
		expect(getFileDraft("sess-1", "src/App.tsx")).toMatchObject({ content: null, reason: "size" });
		await history.click("Go back");
		expect(confirm).toHaveBeenCalledWith(LEAVE_TOO_LARGE_MESSAGE);
		expect(history.index()).toBe(1);
		confirm.mockRestore();
		resetFileDraftsForTests();
	});
});

describe("a local draft refused for lack of room", () => {
	it("warns, keeps the stored drafts and says leaving discards it", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		resetFileDraftsForTests();
		for (let index = 0; index < MAX_FILE_DRAFTS; index += 1) setFileDraft("other", `f${index}.ts`, `kept ${index}`, "fp");
		getMock.mockReset().mockResolvedValue({ data: loaded });
		const history = await renderUnsavedFileDrafts("sess-1", "src/App.tsx", (onDirtyChange) => (
			<FileContentPane annotation={annotation} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} path="src/App.tsx" sessionId="sess-1" split={false} />
		));
		await history.click("open file");
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		await userEvent.type(editor(), " // typed");

		expect(await screen.findByRole("alert")).toHaveTextContent("Too many unsaved drafts");
		expect(getFileDraft("sess-1", "src/App.tsx")).toMatchObject({ content: null, reason: "capacity" });
		expect(draftedFilePaths("other")).toHaveLength(MAX_FILE_DRAFTS);
		expect(getFileDraft("other", "f0.ts")?.content).toBe("kept 0");
		await history.click("Go back");
		expect(confirm).toHaveBeenCalledWith(LEAVE_TOO_LARGE_MESSAGE);
		confirm.mockRestore();
		resetFileDraftsForTests();
	});
});
