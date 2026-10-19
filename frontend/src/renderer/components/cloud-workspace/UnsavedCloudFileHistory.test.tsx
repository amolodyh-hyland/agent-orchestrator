// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCpClient } from "../../lib/cloud-cp";
import { resetNavigationHistoryForTests } from "../../lib/navigation-history";
import { LEAVE_MESSAGE, renderUnsavedFileHistory } from "../../test/unsaved-file-history.test.harness";
import type { FileAnnotationModel } from "../WorkspaceDiffView";
import { CloudFileContentPane } from "./CloudFileContentPane";

vi.mock("../../lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/platform")>()), isMacPlatform: () => true, isLinuxPlatform: () => false }));
vi.mock("./CloudDiffFile", () => ({ CloudDiffFile: () => <div data-testid="cloud-diff" /> }));

const annotation: FileAnnotationModel = { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };
const detail = { path: "README.md", status: "modified" as const, additions: 1, deletions: 1, size: 8, binary: false, editable: true, fileFingerprint: "fp-1", deleted: false, content: "# Hello", contentTruncated: false, diff: "diff", diffTruncated: false, workspaceVersion: "v1" };

const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
const renderPane = (onDirtyChange: (dirty: boolean) => void) => (
	<CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} orgId="org-1" path="README.md" sessionId="session-1" split={false} />
);
const EDITOR = "Edit README.md";

async function editDraft() {
	await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
	const editor = screen.getByRole("textbox", { name: EDITOR }).querySelector<HTMLElement>(".cm-content");
	await userEvent.click(editor!);
	await userEvent.keyboard(" DRAFT");
	await waitFor(() => expect(draft()).toContain("DRAFT"));
}

async function openDirtyEditor() {
	const history = await renderUnsavedFileHistory(renderPane);
	await history.click("open file");
	await editDraft();
	await history.click("toggle inspector");
	expect(history.index()).toBe(2);
	return history;
}

const draft = () => screen.getByRole("textbox", { name: EDITOR }).querySelector<HTMLElement>(".cm-content")!.textContent ?? "";

describe("unsaved cloud file edits across real hash-history traversal", () => {
	let confirm: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { confirm = vi.spyOn(window, "confirm"); });
	afterEach(() => { confirm.mockRestore(); resetNavigationHistoryForTests(); });

	it("cancelled Back from the tip keeps the position and draft, and the next Back is not swallowed", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValueOnce(false);
		await history.click("Go back");
		expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
		expect(history.index()).toBe(2);
		expect(draft()).toContain("DRAFT");

		confirm.mockReturnValueOnce(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		expect(draft()).toContain("DRAFT");
	});

	it("a cancelled Back that would unmount the pane keeps the editor and its draft", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		confirm.mockReset().mockReturnValueOnce(false);
		await history.click("Go back");
		expect(history.index()).toBe(1);
		expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
		expect(draft()).toContain("DRAFT");
	});

	it("a confirmed Back to Chat unmounts the pane and Forward brings back a fresh editor", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.click("Go back");
		await history.waitForIndex(0);
		expect(screen.getByTestId("chat")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: EDITOR })).not.toBeInTheDocument();
		await history.click("Go forward");
		await history.waitForIndex(1);
		expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: EDITOR })).not.toBeInTheDocument();
	});

	it("cancelled Forward mid-stack neither advances nor moves, and keeps the draft", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		confirm.mockReset().mockReturnValueOnce(false);
		await history.click("Go forward");
		expect(history.index()).toBe(1);
		expect(draft()).toContain("DRAFT");
		confirm.mockReturnValueOnce(true);
		await history.click("Go forward");
		await history.waitForIndex(2);
		expect(draft()).toContain("DRAFT");
	});

	it("cancelled Forward into the tip stays put and does not swallow the next Back", async () => {
		const history = await openDirtyEditor();
		confirm.mockReturnValue(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		confirm.mockReset().mockReturnValueOnce(false);
		await history.click("Go forward");
		expect(history.index()).toBe(1);
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
		expect(draft()).toContain("DRAFT");

		confirm.mockReturnValueOnce(true);
		window.history.back();
		await history.waitForIndex(1);
		confirm.mockReturnValueOnce(false);
		window.history.forward();
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
		await history.settle();
		await history.waitForIndex(1);
		confirm.mockReturnValueOnce(false);
		window.history.back();
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(4));
		await history.settle();
		await history.waitForIndex(1);
		expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
		expect(draft()).toContain("DRAFT");
	});

	it("a Forward that cannot move leaves no authorization behind for a later browser Back", async () => {
		const history = await renderUnsavedFileHistory(renderPane);
		await history.click("open file");
		expect(history.index()).toBe(1);
		// Clean file at the tip: the Forward shortcut has nowhere to go.
		await history.traverse("forward");
		expect(history.index()).toBe(1);
		await editDraft();
		confirm.mockReturnValueOnce(false);
		window.history.back();
		await waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE));
		await history.settle();
		await history.waitForIndex(1);
		expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
		expect(draft()).toContain("DRAFT");
	});

	it("does not ask when the file is clean", async () => {
		const history = await renderUnsavedFileHistory(renderPane);
		await history.click("open file");
		await history.click("Go back");
		await history.waitForIndex(0);
		expect(confirm).not.toHaveBeenCalled();
	});
});
