import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProjectContext } from "./SessionProjectContext";
const mocks = vi.hoisted(() => ({ GET: vi.fn(), client: vi.fn() }));
vi.mock("../lib/host-clients", () => ({ clientForSessionHost: (host?: string) => { mocks.client(host); return mocks; } }));
function show() {
	render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionProjectContext sessionId="session-a" hostId="machine-a" /></QueryClientProvider>);
	const details = screen.getByText("Context at session start").parentElement!;
	details.setAttribute("open", "");
	fireEvent(details, new Event("toggle"));
}
beforeEach(() => vi.clearAllMocks());
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
	it("shows read errors", async () => {
		mocks.GET.mockResolvedValue({ error: { message: "Snapshot unavailable" } });
		show();
		expect(await screen.findByRole("alert")).toHaveTextContent("Snapshot unavailable");
	});
});
