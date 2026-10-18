import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavigationHistoryForTests } from "../lib/navigation-history";
import { LEAVE_MESSAGE, renderUnsavedFileHistory } from "../test/unsaved-file-history.test.harness";
import { FileContentPane } from "./FileContentPane";
import type { FileAnnotationModel } from "./WorkspaceDiffView";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/platform")>()), isMacPlatform: () => true, isLinuxPlatform: () => false }));
vi.mock("../lib/workspace-file-events", () => ({ subscribeWorkspaceFileChanges: vi.fn(() => vi.fn()) }));
vi.mock("../hooks/usePierreFileHighlight", () => ({ usePierreFileHighlightReady: () => true }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, PUT: vi.fn() },
	getApiBaseUrl: () => "",
	apiErrorMessage: (error: unknown, fallback = "Request failed") => (error instanceof Error ? error.message : fallback),
}));
vi.mock("./ReadOnlyFileView", () => ({
	ReadOnlyFileView: ({ detail, editing, onEditChange }: { detail: { content: string; path: string }; editing?: boolean; onEditChange?: (content: string) => void }) => editing
		? <textarea aria-label={`Edit ${detail.path}`} defaultValue={detail.content} onChange={(event) => onEditChange?.(event.target.value)} />
		: <code>{detail.content}</code>,
}));

const annotation: FileAnnotationModel = { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };

async function openDirtyEditor() {
	getMock.mockResolvedValue({
		data: {
			sessionId: "sess-1", path: "src/App.tsx", status: "modified", additions: 1, deletions: 0, size: 18, binary: false, deleted: false, editable: true,
			content: "export const x = 1;\n", contentTruncated: false, diff: "@@ -0,0 +1,1 @@\n+export const x = 1;\n", diffTruncated: false,
			workspaceVersion: "workspace-1", fileFingerprint: "file-1",
		},
	});
	const history = await renderUnsavedFileHistory((onDirtyChange) => (
		<FileContentPane annotation={annotation} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} path="src/App.tsx" sessionId="sess-1" split={false} />
	));
	await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
	await userEvent.type(screen.getByRole("textbox", { name: "Edit src/App.tsx" }), " // draft");
	await history.click("toggle inspector");
	await history.click("toggle inspector");
	expect(history.index()).toBe(2);
	return history;
}

const draft = () => (screen.getByRole("textbox", { name: "Edit src/App.tsx" }) as HTMLTextAreaElement).value;

describe("unsaved local file edits across real hash-history traversal", () => {
	let confirm: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { confirm = vi.spyOn(window, "confirm"); });
	afterEach(() => { confirm.mockRestore(); resetNavigationHistoryForTests(); });

	it("cancelled Back from the tip keeps the position and draft, and the next Back is not swallowed", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValueOnce(false);
		await history.click("Go back");
		expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
		expect(history.index()).toBe(2);
		expect(draft()).toContain("// draft");

		confirm.mockReturnValueOnce(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		expect(draft()).toContain("// draft");
	});

	it("confirmed Back and Forward move one entry each and apply the entry", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		expect(screen.getByTestId("inspector")).toHaveTextContent("true");
		await history.click("Go forward");
		await history.waitForIndex(2);
		expect(screen.getByTestId("inspector")).toHaveTextContent("false");
		expect(draft()).toContain("// draft");
	});

	it("cancelled Forward mid-stack neither advances nor moves, and keeps the draft", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.click("Go back");
		await history.waitForIndex(0);
		confirm.mockReset().mockReturnValueOnce(false);
		await history.click("Go forward");
		expect(history.index()).toBe(0);
		expect(draft()).toContain("// draft");
		confirm.mockReturnValueOnce(true);
		await history.click("Go forward");
		await history.waitForIndex(1);
	});

	it("cancelled Forward into the tip stays put and does not swallow the next Back", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		confirm.mockReset().mockReturnValueOnce(false);
		await history.click("Go forward");
		expect(history.index()).toBe(1);
		expect(draft()).toContain("// draft");
		confirm.mockReturnValueOnce(true);
		await history.click("Go back");
		await history.waitForIndex(0);
	});

	it("restores the exact entry when a browser-originated Back or Forward is refused", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValueOnce(false);
		window.history.back();
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		await history.settle();
		await history.waitForIndex(2);
		expect(draft()).toContain("// draft");

		confirm.mockReturnValueOnce(true);
		window.history.back();
		await history.waitForIndex(1);
		confirm.mockReturnValueOnce(false);
		window.history.forward();
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
		await history.settle();
		await history.waitForIndex(1);
		confirm.mockReturnValueOnce(true);
		window.history.back();
		await history.waitForIndex(0);
		expect(draft()).toContain("// draft");
	});

	it("does not ask when the file is clean", async () => {
		const history = await renderUnsavedFileHistory(() => null);
		await history.click("toggle inspector");
		await history.click("Go back");
		await history.waitForIndex(0);
		expect(confirm).not.toHaveBeenCalled();
	});
});
