import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createHashHistory, createRootRoute, createRoute, createRouter, RouterProvider, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { expect } from "vitest";
import { NavigationHistorySync } from "../components/NavigationHistorySync";
import { TitlebarNav } from "../components/TitlebarNav";
import { TooltipProvider } from "../components/ui/tooltip";
import { useUiStore } from "../stores/ui-store";
import { useUnsavedLeaveGuard } from "../hooks/useUnsavedLeaveGuard";
import { subscribeNavigationRestore, writeAONavigationLocation, type NavigationHistoryLike } from "../lib/navigation-history";

export const LEAVE_MESSAGE = "This file has unsaved changes. Leave and discard them?";

function Page({ renderPane }: { renderPane: (onDirtyChange: (dirty: boolean) => void) => ReactNode }) {
	const router = useRouter();
	const [dirty, setDirty] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	useUnsavedLeaveGuard(dirty, LEAVE_MESSAGE);
	// Same restore wiring as SessionView: a confirmed traversal applies the entry's inspector state.
	useState(() => subscribeNavigationRestore((location) => setInspectorOpen(Boolean(location.sessionView?.inspectorOpen))));
	const toggleInspector = () => {
		const next = !inspectorOpen;
		setInspectorOpen(next);
		writeAONavigationLocation(router.history as unknown as NavigationHistoryLike, {
			sessionView: { sessionKey: "s", sessionId: "s", target: { kind: "worker" }, inspectorView: "files", inspectorOpen: next },
		});
	};
	return (
		<>
			<TitlebarNav />
			<NavigationHistorySync />
			<button onClick={toggleInspector} type="button">toggle inspector</button>
			<output data-testid="inspector">{String(inspectorOpen)}</output>
			{renderPane(setDirty)}
		</>
	);
}

/** Real hash history, router, shell history sync and title bar buttons around a real file pane. */
export async function renderUnsavedFileHistory(renderPane: (onDirtyChange: (dirty: boolean) => void) => ReactNode) {
	// With the sidebar closed the title bar shows its history arrows instead of the brand.
	useUiStore.setState({ isSidebarOpen: false });
	window.history.replaceState(null, "", "#/");
	const rootRoute = createRootRoute({ component: () => <Page renderPane={renderPane} /> });
	const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
	const router = createRouter({ history: createHashHistory(), routeTree: rootRoute.addChildren([indexRoute]) });
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}><TooltipProvider><RouterProvider router={router} /></TooltipProvider></QueryClientProvider>);
	await screen.findByRole("button", { name: "toggle inspector" });
	// window.history outlives a test, so positions are relative to where this one started.
	const rawIndex = () => (router.history.location.state as { __TSR_index: number }).__TSR_index;
	const base = rawIndex();
	const index = () => rawIndex() - base;
	const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));
	const click = async (name: string) => { act(() => screen.getByRole("button", { name }).click()); await settle(); };
	return { router, index, settle, click, waitForIndex: (expected: number) => waitFor(() => expect(index()).toBe(expected)) };
}
