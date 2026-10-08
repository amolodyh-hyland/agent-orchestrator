import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import { TooltipProvider } from "./ui/tooltip";

const { locationMock, paramsMock, useWorkspaceQueryMock } = vi.hoisted(() => ({
	locationMock: { pathname: "/" },
	paramsMock: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	useWorkspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useLocation: () => locationMock,
		useNavigate: () => vi.fn(),
		useParams: () => paramsMock,
	};
});

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: useWorkspaceQueryMock,
	useWorkspaceScope: () => {
		const result = useWorkspaceQueryMock();
		return { ...result, data: result.data ?? {} };
	},
	workspaceQueryKey: ["workspaces"],
	workspaceQueryKeyForHost: (hostId?: string) => hostId ? ["remote-workspaces", hostId] : ["workspaces"],
}));

vi.mock("../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/platform")>();
	return {
		...actual,
		isLinuxPlatform: () => false,
		isMacPlatform: () => true,
		usesBoardActionsInPanel: () => false,
		hidesShellTopbar: () => false,
	};
});

vi.mock("./NotificationCenter", () => ({
	NotificationCenter: () => <button aria-label="Notifications" type="button" />,
}));

const { ShellTopbar } = await import("./ShellTopbar");

describe("ShellTopbar on macOS", () => {
	beforeEach(() => {
		paramsMock.projectId = undefined;
		paramsMock.sessionId = undefined;
		useWorkspaceQueryMock.mockReturnValue({ data: [], isError: false, isLoading: false });
		useUiStore.setState({ isSidebarOpen: true });
	});

	it("keeps the actions container no-drag instead of relying on per-control carve-outs", () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<ShellTopbar />
				</TooltipProvider>
			</QueryClientProvider>,
		);

		const actions = screen.getByTestId("workspace-topbar-actions");
		expect((actions.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe("no-drag");
	});
});
