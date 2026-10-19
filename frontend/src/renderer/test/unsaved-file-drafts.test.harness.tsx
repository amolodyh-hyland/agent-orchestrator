import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationHistorySync } from "../components/NavigationHistorySync";
import { TitlebarNav } from "../components/TitlebarNav";
import { TooltipProvider } from "../components/ui/tooltip";
import { useUnsavedLeaveGuard } from "../hooks/useUnsavedLeaveGuard";
import { draftedFilePaths, getFileDraft, resetFileDraftsForTests } from "../lib/file-draft-store";
import { resetNavigationHistoryForTests, traverseHistory } from "../lib/navigation-history";
import { useUiStore } from "../stores/ui-store";

export const LEAVE_MESSAGE = "This file has unsaved changes. Your draft is kept and comes back when you return. Leave now?";

// Mirrors SessionView: the file tab is open when the user opened it or when an unsaved draft
// exists for the session, and the dirty pane arms the same leave guard.
function SessionRoute({ draftSessionKey, renderPane }: { draftSessionKey: string; renderPane: (onDirtyChange: (dirty: boolean) => void) => ReactNode }) {
	const [fileOpen, setFileOpen] = useState(() => draftedFilePaths(draftSessionKey).length > 0);
	const [dirty, setDirty] = useState(false);
	useUnsavedLeaveGuard(dirty, LEAVE_MESSAGE);
	return (
		<>
			<button onClick={() => setFileOpen(true)} type="button">open file</button>
			{fileOpen ? renderPane(setDirty) : <p data-testid="no-file">no file</p>}
		</>
	);
}

function Shell() {
	const router = useRouter();
	return (
		<>
			<TitlebarNav />
			<NavigationHistorySync />
			<button onClick={() => void router.navigate({ to: "/board" as never })} type="button">go to board</button>
			<button onClick={() => void router.navigate({ to: "/session" as never })} type="button">go to session</button>
			<Outlet />
		</>
	);
}

/** Real hash history and routes (a session route and a board route), the shell history sync and the title bar buttons around a real file pane. */
export async function renderUnsavedFileDrafts(draftSessionKey: string, renderPane: (onDirtyChange: (dirty: boolean) => void) => ReactNode) {
	// With the sidebar closed the title bar shows its history arrows instead of the brand.
	useUiStore.setState({ isSidebarOpen: false });
	window.history.replaceState(null, "", "#/board");
	const rootRoute = createRootRoute({ component: Shell });
	const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/board", component: () => <p data-testid="board">board</p> });
	const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/session", component: () => <SessionRoute draftSessionKey={draftSessionKey} renderPane={renderPane} /> });
	const router = createRouter({ history: createHashHistory(), routeTree: rootRoute.addChildren([boardRoute, sessionRoute]) });
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><TooltipProvider><RouterProvider router={router} /></TooltipProvider></QueryClientProvider>);
	await screen.findByTestId("board");
	// window.history outlives a test, so positions are relative to where this one started.
	const rawIndex = () => (router.history.location.state as { __TSR_index: number }).__TSR_index;
	const base = rawIndex();
	const index = () => rawIndex() - base;
	const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));
	const click = async (name: string) => { act(() => screen.getByRole("button", { name }).click()); await settle(); };
	const traverse = (direction: "back" | "forward") => { act(() => traverseHistory(router.history, direction)); return settle(); };
	await click("go to session");
	return { router, index, settle, click, traverse, waitForIndex: (expected: number) => waitFor(() => expect(index()).toBe(expected)) };
}

export type DraftPaneDriver = {
	/** The session key and path the pane stores its draft under. */
	draftSessionKey: string;
	path: string;
	renderPane: (onDirtyChange: (dirty: boolean) => void) => ReactNode;
	/** Opens the editor on the loaded file and types the draft into it. */
	editDraft: () => Promise<void>;
	/** The text currently in the editor. */
	draft: () => string;
	/** Clicks Save and waits until the pane is no longer editing. */
	save: () => Promise<void>;
	discard: () => Promise<void>;
	prepare: () => void;
};

export const DRAFT_TEXT = "DRAFT";

/** The shared scenarios: a dirty editor is unmounted by a real route change and must come back. */
export function describeUnsavedFileDrafts(name: string, driver: DraftPaneDriver) {
	describe(`unsaved ${name} file edits across route-driven unmount`, () => {
		let confirm: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			resetFileDraftsForTests();
			driver.prepare();
			confirm = vi.spyOn(window, "confirm");
		});
		afterEach(() => { confirm.mockRestore(); resetNavigationHistoryForTests(); resetFileDraftsForTests(); });

		async function openDirty() {
			const history = await renderUnsavedFileDrafts(driver.draftSessionKey, driver.renderPane);
			await history.click("open file");
			await driver.editDraft();
			expect(driver.draft()).toContain(DRAFT_TEXT);
			return history;
		}

		it("keeps the draft when the board route unmounts the editor and the session is reopened", async () => {
			const history = await openDirty();
			await history.click("go to board");
			expect(screen.getByTestId("board")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
			expect(getFileDraft(driver.draftSessionKey, driver.path)).toContain(DRAFT_TEXT);

			await history.click("Go back");
			await history.waitForIndex(1);
			expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
			expect(driver.draft()).toContain(DRAFT_TEXT);
		});

		it("keeps the draft across a browser-originated Back and Forward without asking", async () => {
			const history = await openDirty();
			window.history.back();
			await history.waitForIndex(0);
			expect(screen.getByTestId("board")).toBeInTheDocument();
			window.history.forward();
			await history.waitForIndex(1);
			expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
			expect(driver.draft()).toContain(DRAFT_TEXT);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("asks before the shell's own Back moves, and a refusal stays on the dirty editor", async () => {
			const history = await openDirty();
			confirm.mockReturnValueOnce(false);
			await history.click("Go back");
			expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
			expect(history.index()).toBe(1);
			expect(driver.draft()).toContain(DRAFT_TEXT);

			confirm.mockReturnValueOnce(true);
			await history.click("Go back");
			await history.waitForIndex(0);
			expect(screen.getByTestId("board")).toBeInTheDocument();
			await history.click("Go forward");
			await history.waitForIndex(1);
			expect(driver.draft()).toContain(DRAFT_TEXT);
		});

		it("does not ask when Forward has nowhere to go", async () => {
			const history = await openDirty();
			await history.traverse("forward");
			expect(confirm).not.toHaveBeenCalled();
			expect(history.index()).toBe(1);
		});

		it("clears the draft on save", async () => {
			const history = await openDirty();
			await driver.save();
			expect(getFileDraft(driver.draftSessionKey, driver.path)).toBeUndefined();
			await history.click("go to board");
			await history.click("Go back");
			await history.waitForIndex(1);
			expect(screen.getByTestId("no-file")).toBeInTheDocument();
		});

		it("clears the draft on an explicit discard", async () => {
			const history = await openDirty();
			await driver.discard();
			expect(getFileDraft(driver.draftSessionKey, driver.path)).toBeUndefined();
			await history.click("go to board");
			await history.click("Go back");
			await history.waitForIndex(1);
			expect(screen.getByTestId("no-file")).toBeInTheDocument();
		});
	});
}
