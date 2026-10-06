import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../shared/daemon-status";
import type { WorkspaceSummary } from "../types/workspace";
import { setEventsConnectionState } from "../lib/events-connection";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { MulticaOpenWithAoPublisher } from "./MulticaOpenWithAoPublisher";

const mocks = vi.hoisted(() => ({ workspaces: undefined as WorkspaceSummary[] | undefined }));

vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: mocks.workspaces }) }));

type Bridge = NonNullable<typeof window.ao>;

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

async function settleStatus() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("MulticaOpenWithAoPublisher", () => {
	let originalDaemon: Bridge["daemon"];
	let originalPublisher: Bridge["multicaOpenWithAo"];
	let publish: ReturnType<typeof vi.fn>;
	let onStatusListener: ((status: DaemonStatus) => void) | undefined;
	let unsubscribe: ReturnType<typeof vi.fn<() => void>>;
	let getStatus: ReturnType<typeof vi.fn<() => Promise<DaemonStatus>>>;

	beforeEach(() => {
		vi.useFakeTimers();
		setEventsConnectionState("idle");
		originalDaemon = { ...window.ao!.daemon };
		originalPublisher = { ...window.ao!.multicaOpenWithAo };
		publish = vi.fn().mockResolvedValue({ ok: true });
		window.ao!.multicaOpenWithAo.publish = publish as unknown as Bridge["multicaOpenWithAo"]["publish"];
		onStatusListener = undefined;
		unsubscribe = vi.fn<() => void>();
		getStatus = vi.fn<() => Promise<DaemonStatus>>(async () => ({ state: "ready" }));
		window.ao!.daemon.getStatus = getStatus;
		window.ao!.daemon.onStatus = vi.fn((listener: (status: DaemonStatus) => void) => {
			onStatusListener = listener;
			return unsubscribe;
		});
		mocks.workspaces = [{ id: "project-1", name: "Project One", path: "", sessions: [] }];
		useMulticaLinksStore.setState({ links: [] });
	});

	afterEach(() => {
		Object.assign(window.ao!.daemon, originalDaemon);
		Object.assign(window.ao!.multicaOpenWithAo, originalPublisher);
		act(() => {
			useMulticaLinksStore.setState({ links: [] });
			setEventsConnectionState("idle");
		});
		vi.useRealTimers();
	});

	it("renders nothing and publishes after the 150 ms debounce", async () => {
		const { container } = render(<MulticaOpenWithAoPublisher />);
		expect(container).toBeEmptyDOMElement();
		await settleStatus();
		await advance(149);
		expect(publish).not.toHaveBeenCalled();
		await advance(1);

		expect(publish).toHaveBeenCalledExactlyOnceWith({
			daemon: "ready",
			stale: false,
			projects: [{ id: "project-1", name: "Project One", orchestrator: null, sessions: [], moreCount: 0 }],
		});
	});

	it("does not republish an accepted snapshot when data is unchanged", async () => {
		const view = render(<MulticaOpenWithAoPublisher />);
		await settleStatus();
		await advance();
		mocks.workspaces = [...mocks.workspaces!];
		view.rerender(<MulticaOpenWithAoPublisher />);
		await advance();

		expect(publish).toHaveBeenCalledOnce();
	});

	it("retries a failed snapshot only after a new snapshot is set", async () => {
		publish.mockResolvedValueOnce({ ok: false });
		const view = render(<MulticaOpenWithAoPublisher />);
		await settleStatus();
		await advance();
		await advance(10_000);
		expect(publish).toHaveBeenCalledOnce();

		act(() => setEventsConnectionState("disconnected"));
		await advance();
		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true }));
		view.unmount();
	});

	it("publishes a fresh snapshot when daemon status changes", async () => {
		render(<MulticaOpenWithAoPublisher />);
		await settleStatus();
		await advance();
		act(() => onStatusListener?.({ state: "error" }));
		await advance();

		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ daemon: "error" }));
	});

	it("unsubscribes and disposes on unmount, and ignores later daemon updates", async () => {
		const pending = deferred<DaemonStatus>();
		getStatus.mockReturnValueOnce(pending.promise);
		const view = render(<MulticaOpenWithAoPublisher />);
		view.unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
		await act(async () => {
			pending.resolve({ state: "error" });
			await Promise.resolve();
		});
		act(() => onStatusListener?.({ state: "starting" }));
		await advance(1_000);

		expect(publish).not.toHaveBeenCalled();
	});

	it("publishes an empty non-stale snapshot while workspaces are unavailable", async () => {
		mocks.workspaces = undefined;
		getStatus.mockResolvedValue({ state: "starting" });
		render(<MulticaOpenWithAoPublisher />);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		await advance();

		expect(publish).toHaveBeenCalledExactlyOnceWith({ daemon: "starting", stale: false, projects: [] });
	});
});
