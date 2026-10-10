import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../types/workspace";
import { setEventsConnectionState } from "../lib/events-connection";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { MulticaSyncFactsPublisher } from "./MulticaSyncFactsPublisher";

const mocks = vi.hoisted(() => ({ workspaces: undefined as WorkspaceSummary[] | undefined }));

vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: mocks.workspaces }) }));

type Bridge = NonNullable<typeof window.ao>;

async function advance(ms = 300) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

const link = { sessionId: "s-1", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", createdAt: "2026-01-01T00:00:00.000Z" };
const workspaces = (): WorkspaceSummary[] => [
	{
		id: "project-1",
		name: "Project One",
		path: "",
		sessions: [{ id: "s-1", workspaceId: "project-1", workspaceName: "Project One", title: "s-1", provider: "claude-code", status: "working", updatedAt: "2026-01-01T00:00:00.000Z", prs: [] }],
	},
];

describe("MulticaSyncFactsPublisher", () => {
	let original: Bridge["multicaSync"];
	let publishFacts: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		setEventsConnectionState("idle");
		original = { ...window.ao!.multicaSync };
		publishFacts = vi.fn().mockResolvedValue({ ok: true });
		window.ao!.multicaSync.publishFacts = publishFacts as unknown as Bridge["multicaSync"]["publishFacts"];
		mocks.workspaces = workspaces();
		useMulticaLinksStore.setState({ links: [link] });
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaSync, original);
		act(() => {
			useMulticaLinksStore.setState({ links: [] });
			setEventsConnectionState("idle");
		});
		vi.useRealTimers();
	});

	it("publishes the facts of linked sessions once, after a short delay", async () => {
		render(<MulticaSyncFactsPublisher />);
		expect(publishFacts).not.toHaveBeenCalled();
		await advance();

		expect(publishFacts).toHaveBeenCalledExactlyOnceWith({
			stale: false,
			sessions: [{ sessionId: "s-1", provisioning: "ready", column: "building", activity: "unknown", terminated: false, prs: [] }],
		});
	});

	it("publishes nothing until the workspaces have loaded", async () => {
		mocks.workspaces = undefined;
		render(<MulticaSyncFactsPublisher />);
		await advance();
		expect(publishFacts).not.toHaveBeenCalled();
	});

	it("marks the facts stale when the daemon feed is lost", async () => {
		render(<MulticaSyncFactsPublisher />);
		await advance();
		act(() => setEventsConnectionState("disconnected"));
		await advance();

		expect(publishFacts).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true }));
	});

	it("does not publish again when nothing changed", async () => {
		const view = render(<MulticaSyncFactsPublisher />);
		await advance();
		view.rerender(<MulticaSyncFactsPublisher />);
		await advance();
		expect(publishFacts).toHaveBeenCalledTimes(1);
	});

	it("publishes an empty list when no session is linked", async () => {
		useMulticaLinksStore.setState({ links: [] });
		render(<MulticaSyncFactsPublisher />);
		await advance();
		expect(publishFacts).toHaveBeenCalledExactlyOnceWith({ stale: false, sessions: [] });
	});
});
