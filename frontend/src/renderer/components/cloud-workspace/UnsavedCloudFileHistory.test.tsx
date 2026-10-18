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

async function openDirtyEditor() {
	const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
	const history = await renderUnsavedFileHistory((onDirtyChange) => (
		<CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} orgId="org-1" path="README.md" sessionId="session-1" split={false} />
	));
	await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
	const editor = screen.getByRole("textbox", { name: "Edit README.md" }).querySelector<HTMLElement>(".cm-content");
	await userEvent.click(editor!);
	await userEvent.keyboard(" draft");
	await waitFor(() => expect(draft()).toContain("draft"));
	await history.click("toggle inspector");
	await history.click("toggle inspector");
	expect(history.index()).toBe(2);
	return history;
}

const draft = () => screen.getByRole("textbox", { name: "Edit README.md" }).querySelector<HTMLElement>(".cm-content")!.textContent ?? "";

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
		expect(draft()).toContain("draft");

		confirm.mockReturnValueOnce(true);
		await history.click("Go back");
		await history.waitForIndex(1);
		expect(draft()).toContain("draft");
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
		expect(draft()).toContain("draft");
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
		expect(draft()).toContain("draft");
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
		expect(draft()).toContain("draft");
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
		expect(draft()).toContain("draft");

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
		expect(draft()).toContain("draft");
	});

	it("does not ask when the file is clean", async () => {
		const history = await renderUnsavedFileHistory(() => null);
		await history.click("toggle inspector");
		await history.click("Go back");
		await history.waitForIndex(0);
		expect(confirm).not.toHaveBeenCalled();
	});
});
