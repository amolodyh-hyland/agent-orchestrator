import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { setEventsConnectionState } from "../lib/events-connection";
import { appI18n } from "../i18n";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { MulticaStatusPublisher } from "./MulticaStatusPublisher";

const mocks = vi.hoisted(() => ({ workspaces: undefined as unknown }));

vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: mocks.workspaces }) }));

type Bridge = NonNullable<typeof window.ao>;

function link(sessionId: string): MulticaIssueLink {
	return {
		sessionId,
		projectId: "project-one",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-123",
		createdAt: "2026-10-01T00:00:00.000Z",
	};
}

function session(id: string, status: WorkspaceSession["status"] = "working"): WorkspaceSession {
	return { id, title: id, status, prs: [] } as unknown as WorkspaceSession;
}

function workspace(sessions: WorkspaceSession[]): WorkspaceSummary {
	return { id: "project-one", name: "Project One", path: "/repos/project-one", sessions } as unknown as WorkspaceSummary;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function advance(ms = 150) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("MulticaStatusPublisher", () => {
	let originalStatusBridge: Bridge["multicaStatus"];
	let publish: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		setEventsConnectionState("idle");
		originalStatusBridge = { ...window.ao!.multicaStatus };
		publish = vi.fn().mockResolvedValue({ ok: true });
		window.ao!.multicaStatus.publish = publish as unknown as Bridge["multicaStatus"]["publish"];
		mocks.workspaces = [workspace([session("session-live")])];
		useMulticaLinksStore.setState({ links: [] });
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaStatus, originalStatusBridge);
		act(() => {
			useMulticaLinksStore.setState({ links: [] });
			setEventsConnectionState("idle");
		});
		vi.useRealTimers();
	});

	it("renders nothing", () => {
		const { container } = render(<MulticaStatusPublisher />);
		expect(container).toBeEmptyDOMElement();
	});

	it("publishes the linked and missing sessions after 150 ms", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live"), link("session-missing")] });
		render(<MulticaStatusPublisher />);

		await advance();

		expect(publish).toHaveBeenCalledExactlyOnceWith({
			stale: false,
			entries: [
				{ sessionId: "session-live", tone: "working", label: "Working", detail: "" },
				{ sessionId: "session-missing", tone: "unknown", label: "Session not found", detail: "" },
			],
		});
	});

	it("does not publish before 150 ms", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		render(<MulticaStatusPublisher />);

		await advance(149);
		expect(publish).not.toHaveBeenCalled();

		await advance(1);
		expect(publish).toHaveBeenCalledOnce();
	});

	it("does not republish an accepted snapshot when data is unchanged", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		mocks.workspaces = [...(mocks.workspaces as WorkspaceSummary[])];
		view.rerender(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledOnce();
	});

	it("collapses rapid changes into one publish with the latest data", async () => {
		const view = render(<MulticaStatusPublisher />);
		act(() => useMulticaLinksStore.setState({ links: [link("session-one")] }));
		await advance(50);
		act(() => useMulticaLinksStore.setState({ links: [link("session-two")] }));
		await advance(50);
		act(() => useMulticaLinksStore.setState({ links: [link("session-live")] }));
		await advance(149);
		expect(publish).not.toHaveBeenCalled();

		await advance(1);

		expect(publish).toHaveBeenCalledExactlyOnceWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "working", label: "Working", detail: "" }],
		});
		view.unmount();
	});

	it("collapses rapid workspace changes into one publish with the latest data", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		for (const status of ["ci_failed", "working", "merged"] as const) {
			mocks.workspaces = [workspace([session("session-live", status)])];
			view.rerender(<MulticaStatusPublisher />);
			await advance(40);
		}
		await advance(109);
		expect(publish).toHaveBeenCalledOnce();

		await advance(1);

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "ready", label: "Merged", detail: "" }],
		});
	});

	it("publishes again when workspace status changes", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		mocks.workspaces = [workspace([session("session-live", "ci_failed")])];
		view.rerender(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "attention", label: "CI failed", detail: "" }],
		});
	});

	it("publishes stale state when events disconnect and fresh state when they reconnect", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		render(<MulticaStatusPublisher />);
		await advance();

		act(() => setEventsConnectionState("disconnected"));
		await advance();
		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true }));

		act(() => setEventsConnectionState("connected"));
		await advance();
		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ stale: false }));
		expect(publish).toHaveBeenCalledTimes(3);
	});

	it("reconciles the latest snapshot when an in-flight publish completes", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		const pending = deferred<{ ok: boolean }>();
		publish.mockImplementationOnce(() => pending.promise);
		act(() => setEventsConnectionState("disconnected"));
		await advance();
		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true }));

		act(() => setEventsConnectionState("connected"));
		await advance();
		expect(publish).toHaveBeenCalledTimes(2);

		await act(async () => {
			pending.resolve({ ok: true });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(publish).toHaveBeenCalledTimes(3);
		expect(publish).toHaveBeenLastCalledWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "working", label: "Working", detail: "" }],
		});
		await advance(1_000);
		expect(publish).toHaveBeenCalledTimes(3);
		view.unmount();
	});

	it("does not publish when unmounted before the debounce elapses", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance(100);
		view.unmount();

		await expect(advance(50)).resolves.toBeUndefined();
		expect(publish).not.toHaveBeenCalled();
	});

	it("does not reconcile a settled publish after unmount", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		const pending = deferred<{ ok: boolean }>();
		publish.mockImplementationOnce(() => pending.promise);
		act(() => setEventsConnectionState("disconnected"));
		await advance();
		act(() => setEventsConnectionState("connected"));
		await advance();
		view.unmount();

		await act(async () => {
			pending.resolve({ ok: true });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("publishes again after remounting with the same snapshot", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const firstView = render(<MulticaStatusPublisher />);
		await advance();
		firstView.unmount();

		render(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("republishes labels when the language changes", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();
		expect(publish).toHaveBeenLastCalledWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "working", label: "Working", detail: "" }],
		});

		try {
			await act(async () => {
				await appI18n.changeLanguage("zh-CN");
			});
			await advance();

			expect(publish).toHaveBeenCalledTimes(2);
			expect(publish).toHaveBeenLastCalledWith({
				stale: false,
				entries: [{ sessionId: "session-live", tone: "working", label: "工作中", detail: "" }],
			});
		} finally {
			view.unmount();
			await act(async () => {
				await appI18n.changeLanguage("en");
			});
		}
	});

	it("publishes the initial empty snapshot when there are no links", async () => {
		render(<MulticaStatusPublisher />);
		await advance();
		expect(publish).toHaveBeenCalledExactlyOnceWith({ stale: false, entries: [] });

		await advance(10_000);
		expect(publish).toHaveBeenCalledOnce();
	});

	it("does not publish a second time when events disconnect with no links", async () => {
		render(<MulticaStatusPublisher />);
		act(() => setEventsConnectionState("disconnected"));

		await advance();
		expect(publish).toHaveBeenCalledExactlyOnceWith({ stale: false, entries: [] });

		await advance(10_000);
		expect(publish).toHaveBeenCalledOnce();
	});

	it("publishes an empty entry list when the accepted links are removed", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		render(<MulticaStatusPublisher />);
		await advance();

		act(() => useMulticaLinksStore.setState({ links: [] }));
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({ stale: false, entries: [] });
	});

	it("publishes empty after a reload interrupts the empty debounce", async () => {
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const firstView = render(<MulticaStatusPublisher />);
		await advance();

		act(() => useMulticaLinksStore.setState({ links: [] }));
		await advance(149);
		firstView.unmount();

		render(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({ stale: false, entries: [] });
	});

	it("retries a rejected publish on the next change without throwing", async () => {
		publish.mockRejectedValueOnce(new Error("publish failed"));
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await expect(advance()).resolves.toBeUndefined();

		mocks.workspaces = [...(mocks.workspaces as WorkspaceSummary[])];
		view.rerender(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("does not loop after a rejected publish and retries on the next dependency change", async () => {
		publish.mockRejectedValueOnce(new Error("publish failed"));
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();
		await advance(10_000);
		expect(publish).toHaveBeenCalledOnce();

		mocks.workspaces = [workspace([session("session-live", "ci_failed")])];
		view.rerender(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({
			stale: false,
			entries: [{ sessionId: "session-live", tone: "attention", label: "CI failed", detail: "" }],
		});
	});

	it("retries an unsuccessful publish on the next change", async () => {
		publish.mockResolvedValueOnce({ ok: false });
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		const view = render(<MulticaStatusPublisher />);
		await advance();

		mocks.workspaces = [...(mocks.workspaces as WorkspaceSummary[])];
		view.rerender(<MulticaStatusPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("does not publish until workspace data is available", async () => {
		mocks.workspaces = undefined;
		useMulticaLinksStore.setState({ links: [link("session-live")] });
		render(<MulticaStatusPublisher />);

		await advance(500);
		expect(publish).not.toHaveBeenCalled();
	});
});
