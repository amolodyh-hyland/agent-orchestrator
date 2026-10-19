// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { CloudCpClient } from "../../lib/cloud-cp";
import { cloudDraftSessionKey } from "../../lib/file-draft-store";
import { describeUnsavedFileDrafts, DRAFT_TEXT } from "../../test/unsaved-file-drafts.test.harness";
import type { FileAnnotationModel } from "../WorkspaceDiffView";
import { CloudFileContentPane } from "./CloudFileContentPane";

vi.mock("../../lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/platform")>()), isMacPlatform: () => true, isLinuxPlatform: () => false }));
vi.mock("./CloudDiffFile", () => ({ CloudDiffFile: () => <div data-testid="cloud-diff" /> }));

const annotation: FileAnnotationModel = { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };
const detail = { path: "README.md", status: "modified" as const, additions: 1, deletions: 1, size: 8, binary: false, editable: true, fileFingerprint: "fp-1", deleted: false, content: "# Hello", contentTruncated: false, diff: "diff", diffTruncated: false, workspaceVersion: "v1" };
const getWorkspaceReviewFile = vi.fn();
const updateWorkspaceReviewFile = vi.fn();
const client = { getWorkspaceReviewFile, updateWorkspaceReviewFile, } as unknown as CloudCpClient;
const EDITOR = "Edit README.md";
const editorContent = () => screen.getByRole("textbox", { name: EDITOR }).querySelector<HTMLElement>(".cm-content")!;

describeUnsavedFileDrafts("cloud", {
	draftSessionKey: cloudDraftSessionKey("org-1", "session-1"),
	path: "README.md",
	baseFingerprint: "fp-1",
	savedFingerprint: "fp-2",
	prepare: () => {
		getWorkspaceReviewFile.mockReset().mockResolvedValue(detail);
		updateWorkspaceReviewFile.mockReset().mockResolvedValue({ content: `# Hello ${DRAFT_TEXT}`, fileFingerprint: "fp-2" });
	},
	renderPane: (onDirtyChange) => (
		<CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} orgId="org-1" path="README.md" sessionId="session-1" split={false} />
	),
	editDraft: async () => {
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		await userEvent.click(editorContent());
		await userEvent.keyboard(` ${DRAFT_TEXT}`);
		await waitFor(() => expect(editorContent().textContent).toContain(DRAFT_TEXT));
	},
	draft: () => editorContent().textContent ?? "",
	typeMore: async (text) => {
		await userEvent.click(editorContent());
		await userEvent.keyboard(text);
	},
	deferNextSave: (response = "exact") => {
		let answer: (value: unknown) => void = () => {};
		updateWorkspaceReviewFile.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
		// The server answers with what it read back: the submitted text, or another tool's.
		return async () => {
			const content = response === "exact" ? updateWorkspaceReviewFile.mock.calls.at(-1)?.[2]?.content : "# written by another tool";
			await act(async () => answer({ content, fileFingerprint: "fp-2" }));
		};
	},
	startSave: async () => { await userEvent.click(screen.getByRole("button", { name: "Save" })); },
	externalChange: () => { getWorkspaceReviewFile.mockResolvedValue({ ...detail, content: "# Changed elsewhere", fileFingerprint: "fp-3" }); },
	lastSaveExpectedFingerprint: () => updateWorkspaceReviewFile.mock.calls.at(-1)?.[2]?.expectedFileFingerprint,
	save: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
	discard: async () => {
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
	},
});
