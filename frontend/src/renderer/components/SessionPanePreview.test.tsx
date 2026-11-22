import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPanePreview } from "./SessionPanePreview";
import { useContext } from "react";
import { AppBrowserLinkContext } from "./AppLink";

const mocks = vi.hoisted(() => ({ source: vi.fn(), browser: vi.fn(), annotations: vi.fn(), navigate: vi.fn(), openLink: vi.fn() }));
vi.mock("../lib/use-session-link-navigation", () => ({ useSessionLinkSource: (...args: unknown[]) => mocks.source(...args) }));
vi.mock("../lib/navigate-to-session", () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock("../hooks/useHostConnection", () => ({ useHostConnection: () => ({ baseUrl: "http://remote-proxy.test" }) }));
vi.mock("../hooks/useBrowserView", () => ({ useBrowserView: (options: unknown) => { mocks.browser(options); return { navState: { url: "https://preview.test" }, openLink: mocks.openLink }; } }));
vi.mock("./BrowserPanel", () => ({
	useBrowserAnnotationQueue: (options: unknown) => { mocks.annotations(options); return {}; },
	BrowserPanelView: ({ session }: { session: { id: string } }) => <div>Browser owner: {session.id}</div>,
}));
vi.mock("./SessionArtifactsView", () => ({ SessionArtifactsView: ({ session, hostId, request }: { session: { id: string }; hostId?: string; request: { path: string } }) => {
	const open = useContext(AppBrowserLinkContext);
	return <div>Artifact owner: {hostId ?? "local"}/{session.id}/{request.path}<button onClick={() => open?.("http://artifact.test/owner-plan")}>Open artifact in browser</button></div>;
} }));

const owner = { id: "worker", title: "Worker report", isTerminated: false, status: "working", previewUrl: "http://preview.test", previewRevision: 2 };
const target = { projectId: "project", sessionId: "worker" };

describe("borrowed session preview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.source.mockReturnValue({ ready: true, workspaces: [{ id: "project", sessions: [owner] }] });
	});
	it("opens an artifact under its true owner without creating a native browser or navigating", async () => {
		const close = vi.fn(), user = userEvent.setup();
		render(<SessionPanePreview target={{ ...target, path: "reports/plan.md" }} active onClose={close} />);
		expect(screen.getByText("Artifact owner: local/worker/reports/plan.md")).toBeInTheDocument();
		expect(mocks.browser).not.toHaveBeenCalled();
		expect(mocks.navigate).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Go to session" }));
		expect(mocks.navigate).toHaveBeenCalledWith("project", "worker", undefined);
		await user.click(screen.getByRole("button", { name: "Close session preview" }));
		expect(close).toHaveBeenCalledOnce();
	});
	it("keeps remote browser navigation, annotation and proxy identity on the owner", () => {
		const { rerender } = render(<SessionPanePreview target={{ ...target, hostId: "box-a" }} active onClose={vi.fn()} />);
		expect(mocks.source).toHaveBeenCalledWith("box-a", undefined);
		expect(mocks.browser).toHaveBeenLastCalledWith(expect.objectContaining({
			sessionId: "remote:box-a:worker", origin: { hostId: "box-a", sessionId: "worker", proxyBase: "http://remote-proxy.test" }, active: true, previewUrl: owner.previewUrl,
		}));
		expect(mocks.annotations).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "worker", hostId: "box-a" }));
		rerender(<SessionPanePreview target={{ ...target, hostId: "box-a" }} active={false} onClose={vi.fn()} />);
		expect(mocks.browser).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
	});
	it("does not borrow another session when the requested owner disappears", () => {
		mocks.source.mockReturnValue({ ready: true, workspaces: [{ id: "other", sessions: [owner] }] });
		render(<SessionPanePreview target={target} active onClose={vi.fn()} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(mocks.browser).not.toHaveBeenCalled();
	});

	it("routes an artifact's browser action to its owner rather than the surrounding orchestrator", async () => {
		const parentBrowser = vi.fn(), user = userEvent.setup();
		render(<AppBrowserLinkContext.Provider value={parentBrowser}><SessionPanePreview target={{ ...target, path: "plan.html" }} active onClose={vi.fn()} /></AppBrowserLinkContext.Provider>);
		await user.click(screen.getByRole("button", { name: "Open artifact in browser" }));
		expect(parentBrowser).not.toHaveBeenCalled();
		expect(mocks.browser).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "worker" }));
		expect(mocks.openLink).toHaveBeenCalledWith("http://artifact.test/owner-plan");
	});
});
