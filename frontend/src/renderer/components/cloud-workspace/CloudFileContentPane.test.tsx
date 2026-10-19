// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudDraftSessionKey, MAX_FILE_DRAFTS, resetFileDraftsForTests, setFileDraft } from "../../lib/file-draft-store";
import type { CloudCpClient } from "../../lib/cloud-cp";
import type { FileAnnotationModel } from "../WorkspaceDiffView";
import { TooltipProvider } from "../ui/tooltip";
import { CloudFileContentPane } from "./CloudFileContentPane";

vi.mock("../ReadOnlyFileView", () => ({ ReadOnlyFileView: ({ detail, editing, onEditChange }: { detail: { content: string }; editing: boolean; onEditChange?: (value: string) => void }) => editing ? <textarea aria-label="editor" defaultValue={detail.content} onChange={(event) => onEditChange?.(event.target.value)} /> : <pre>{detail.content}</pre> }));
vi.mock("./CloudDiffFile", () => ({ CloudDiffFile: () => <div data-testid="cloud-diff" /> }));
vi.mock("../markdown/MarkdownFileView", () => ({ MarkdownFileView: ({ content }: { content: string }) => <article>{content}</article> }));

const annotation: FileAnnotationModel = { targets: [], status: "idle", error: "", begin: vi.fn(), draftFor: () => "", statusFor: () => "idle", setDraft: vi.fn(), cancel: vi.fn(), submit: vi.fn() };
const detail = { path: "README.md", status: "modified" as const, additions: 1, deletions: 1, size: 8, binary: false, editable: true, fileFingerprint: "fp-1", deleted: false, content: "# Hello", contentTruncated: false, diff: "diff", diffTruncated: false, workspaceVersion: "v1" };

function renderPane(client: CloudCpClient, props: Partial<React.ComponentProps<typeof CloudFileContentPane>> = {}) {
	return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} orgId="org-1" path="README.md" sessionId="session-1" split={false} {...props} /></TooltipProvider></QueryClientProvider>);
}

describe("CloudFileContentPane", () => {
	beforeEach(() => resetFileDraftsForTests());

	it("switches between diff, complete file, and rendered Markdown", async () => {
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
		const onModeChange = vi.fn();
		renderPane(client, { onModeChange });
		expect(await screen.findByTestId("cloud-diff")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("tab", { name: "File" }));
		expect(screen.getByText("# Hello")).toBeInTheDocument();
		expect(onModeChange).toHaveBeenCalledWith("file");
		await userEvent.click(screen.getByRole("tab", { name: "Rich preview" }));
		expect(screen.getByRole("article")).toHaveTextContent("# Hello");
		expect(onModeChange).toHaveBeenCalledWith("rendered");
	});

	it("keeps editing after Edit from Diff when the parent follows the reported mode", async () => {
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
		function ControlledParent() {
			const [mode, setMode] = useState<"diff" | "file" | "rendered">("diff");
			return <CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialMode={mode} onModeChange={setMode} orgId="org-1" path="README.md" sessionId="session-1" split={false} />;
		}
		render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><ControlledParent /></TooltipProvider></QueryClientProvider>);
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));

		expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("keeps an unsaved draft when the parent re-renders with the same or a new request key", async () => {
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
		const onDirtyChange = vi.fn();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const pane = (props: Partial<React.ComponentProps<typeof CloudFileContentPane>>) => <QueryClientProvider client={queryClient}><TooltipProvider><CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialMode="file" initialRequestKey={1} onDirtyChange={onDirtyChange} orgId="org-1" path="README.md" sessionId="session-1" split={false} {...props} /></TooltipProvider></QueryClientProvider>;
		const view = render(pane({}));
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		const editor = screen.getByRole("textbox", { name: "Edit README.md" }).querySelector<HTMLElement>(".cm-content");
		await userEvent.click(editor!);
		await userEvent.keyboard("x");
		await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

		view.rerender(pane({}));
		expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
		// A new request for the same file re-seeds the editor from the stored draft, not the saved text.
		view.rerender(pane({ initialRequestKey: 2 }));
		expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
	});

	it.each([
		["a draft whose text was refused for lack of room", true],
		["a draft whose text is kept", false],
	])("a refetch never replaces the edited draft of %s when the file opened for editing", async (_label, full) => {
		if (full) for (let index = 0; index < MAX_FILE_DRAFTS; index += 1) setFileDraft("other", `f${index}.ts`, "kept", "fp");
		const getWorkspaceReviewFile = vi.fn().mockResolvedValue(detail);
		const client = { getWorkspaceReviewFile } as unknown as CloudCpClient;
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(<QueryClientProvider client={queryClient}><TooltipProvider><CloudFileContentPane annotation={annotation} baseUrl="https://cloud.test" client={client} initialEditing initialMode="file" initialRequestKey={1} orgId="org-1" path="README.md" sessionId="session-1" split={false} /></TooltipProvider></QueryClientProvider>);
		const editor = (await screen.findByRole("textbox", { name: "Edit README.md" })).querySelector<HTMLElement>(".cm-content");
		await userEvent.click(editor!);
		await userEvent.keyboard(" mine");
		await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());

		getWorkspaceReviewFile.mockResolvedValue({ ...detail, content: "# Changed elsewhere", fileFingerprint: "fp-2" });
		await act(() => queryClient.invalidateQueries());

		await waitFor(() => expect(getWorkspaceReviewFile).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(queryClient.isFetching()).toBe(0));
		await act(async () => {});
		expect(screen.getByRole("textbox", { name: "Edit README.md" }).querySelector<HTMLElement>(".cm-content")!.textContent).toContain("mine");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it.each([
		["a historical revision", { commitSha: "abc123" }, { editable: true }],
		["a file that is not editable", {}, { editable: false }],
	])("does not restore a stored draft into %s", async (_label, paneProps, detailPatch) => {
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue({ ...detail, ...detailPatch }) } as unknown as CloudCpClient;
		setFileDraft(cloudDraftSessionKey("org-1", "session-1"), "README.md", "# Draft", "fp-1");

		renderPane(client, { initialMode: "file", ...paneProps });

		expect(await screen.findByText("# Hello")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Edit README.md" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
	});

	it("saves edits with the current fingerprint and reports dirty state", async () => {
		const updateWorkspaceReviewFile = vi.fn().mockResolvedValue({ ...detail, content: "# Changed", fileFingerprint: "fp-2" });
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail), updateWorkspaceReviewFile } as unknown as CloudCpClient;
		const onDirtyChange = vi.fn();
		renderPane(client, { initialMode: "file", onDirtyChange });
		await userEvent.click(await screen.findByRole("button", { name: "Edit file" }));
		const editor = screen.getByRole("textbox", { name: "Edit README.md" }).querySelector<HTMLElement>(".cm-content");
		expect(editor).toBeInTheDocument();
		await userEvent.click(editor!);
		await userEvent.keyboard("{Control>}a{/Control}# Changed");
		await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(updateWorkspaceReviewFile).toHaveBeenCalledWith("org-1", "session-1", { path: "README.md", content: "# Changed", expectedFileFingerprint: "fp-1" }));
	});

	it("leaves line feedback to the file renderer instead of opening a second header composer", async () => {
		const client = { getWorkspaceReviewFile: vi.fn().mockResolvedValue(detail) } as unknown as CloudCpClient;
		const lineAnnotation: FileAnnotationModel = {
			...annotation,
			targets: [{
				path: "README.md",
				side: "file",
				line: 2,
				lineKind: "context",
				lineText: "Hello",
				scope: "combined",
				surface: "focused",
			}],
		};
		renderPane(client, { annotation: lineAnnotation, initialMode: "file" });
		await screen.findByText("# Hello");
		expect(screen.queryByRole("textbox", { name: /feedback/i })).not.toBeInTheDocument();
	});
});
