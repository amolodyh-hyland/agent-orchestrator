import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProjectContext } from "./SessionProjectContext";
const mocks = vi.hoisted(() => ({ GET: vi.fn(), client: vi.fn() }));
vi.mock("../lib/host-clients", () => ({ clientForSessionHost: (host?: string) => { mocks.client(host); return mocks; } }));
function show(startupPending = false) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = (starting: boolean) => <QueryClientProvider client={client}><SessionProjectContext sessionId="session-a" hostId="machine-a" startupPending={starting} /></QueryClientProvider>;
	const result = render(view(startupPending));
	const toggle = (open: boolean) => {
		const details = screen.getByText("Context at session start").parentElement as HTMLDetailsElement;
		details.open = open;
		fireEvent(details, new Event("toggle"));
	};
	toggle(true);
	return { toggle, setStarting: (starting: boolean) => result.rerender(view(starting)) };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
const manifest = { sessionId: "session-a", projectId: "research", projectRevision: 3, digest: "digest", sharedInstructions: "Pinned after startup" };
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
describe("Pinned session context", () => {
	it("reads the pinned manifest and displays unavailable optional context without loading the live project", async () => {
		mocks.GET.mockResolvedValue({ data: { manifest: { sessionId: "session-a", projectId: "research", projectRevision: 3, digest: "old-digest", createdAt: "2026-10-19", role: "worker", sharedInstructions: "Original session instructions", attachments: [{ binding: { id: "notes", machineId: "owner-machine", required: false, mediaType: "text/plain" }, availability: "unavailable", reason: "missing", byteCount: 0 }] } } });
		show();
		await screen.findByText("Original session instructions");
		expect(screen.getByText(/Unavailable/)).toBeInTheDocument();
		expect(screen.getByText(/owner-machine/)).toBeInTheDocument();
		expect(screen.getByText(/revision 3/)).toBeInTheDocument();
		expect(mocks.GET).toHaveBeenCalledExactlyOnceWith("/api/v1/sessions/{sessionId}/project-context", { params: { path: { sessionId: "session-a" } } });
		expect(mocks.client).toHaveBeenCalledWith("machine-a");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});
	it("shows when a session has no snapshot", async () => {
		mocks.GET.mockResolvedValue({ data: { manifest: null } });
		show();
		await screen.findByText("No pinned context was recorded for this session.");
	});
	it("polls a missing startup snapshot and stops polling once it is pinned", async () => {
		vi.useFakeTimers();
		mocks.GET.mockResolvedValueOnce({ data: { manifest: null } }).mockResolvedValue({ data: { manifest } });
		const view = show(true);
		await tick();
		expect(screen.getByText("No pinned context was recorded for this session.")).toBeInTheDocument();
		await tick(1000);
		await tick(1);
		expect(screen.getByText("Pinned after startup")).toBeInTheDocument();
		await tick(5000);
		view.setStarting(false);
		view.toggle(false);
		view.toggle(true);
		await tick();
		expect(mocks.GET).toHaveBeenCalledTimes(2);
	});
	it("checks again when startup settles and stops polling legacy sessions without a snapshot", async () => {
		vi.useFakeTimers();
		mocks.GET.mockResolvedValue({ data: { manifest: null } });
		const view = show(true);
		await tick();
		view.setStarting(false);
		await tick();
		expect(mocks.GET).toHaveBeenCalledTimes(2);
		await tick(5000);
		expect(mocks.GET).toHaveBeenCalledTimes(2);
		view.toggle(false);
		mocks.GET.mockResolvedValue({ data: { manifest } });
		view.toggle(true);
		await tick();
		expect(screen.getByText("Pinned after startup")).toBeInTheDocument();
		expect(mocks.GET).toHaveBeenCalledTimes(3);
	});
	it("shows read errors", async () => {
		mocks.GET.mockResolvedValue({ error: { message: "Snapshot unavailable" } });
		show();
		expect(await screen.findByRole("alert")).toHaveTextContent("Snapshot unavailable");
	});
});
