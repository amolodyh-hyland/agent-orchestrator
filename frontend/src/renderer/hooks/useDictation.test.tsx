import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DictationBridge, DictationUpdate } from "../../shared/dictation";
import { useDictation } from "./useDictation";

function setup(props = { disabled: false, scope: "one", locale: "en" }) {
	let listener: (event: DictationUpdate) => void = () => undefined;
	const unsubscribe = vi.fn();
	const bridge: DictationBridge = {
		availability: vi.fn(async () => ({ available: true as const })),
		start: vi.fn(async () => ({})), stop: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
		onEvent: (callback) => { listener = callback; return unsubscribe; },
	};
	const insert = vi.fn();
	const view = renderHook((input) => useDictation({ ...input, onTranscript: insert, bridge }), { initialProps: props });
	const start = async () => {
		await waitFor(() => expect(view.result.current.availability.available).toBe(true));
		await act(() => view.result.current.start());
		return vi.mocked(bridge.start).mock.calls.at(-1)![0];
	};
	const emit = (event: DictationUpdate) => act(() => listener(event));
	return { ...view, bridge, insert, start, emit, unsubscribe };
}

describe("composer dictation state", () => {
	it("waits for recording, stops once, inserts a final transcript once", async () => {
		const s = setup();
		const id = await s.start();
		expect(s.result.current.phase).toBe("starting");
		s.emit({ id, type: "recording" });
		expect(s.result.current.phase).toBe("recording");
		await act(async () => { await s.result.current.stop(); await s.result.current.stop(); });
		expect(s.bridge.stop).toHaveBeenCalledOnce();
		expect(s.insert).not.toHaveBeenCalled();
		s.emit({ id, type: "result", text: "editable draft" });
		s.emit({ id, type: "result", text: "duplicate" });
		expect(s.insert).toHaveBeenCalledExactlyOnceWith("editable draft");
		expect(s.result.current.phase).toBe("idle");
	});

	it("cancels pending permission, ignores late results and permits retry", async () => {
		const s = setup();
		const id = await s.start();
		act(() => s.result.current.cancel());
		expect(s.bridge.cancel).toHaveBeenCalledWith(id);
		s.emit({ id, type: "recording" });
		s.emit({ id, type: "result", text: "discard" });
		expect(s.insert).not.toHaveBeenCalled();
		await s.start();
		expect(s.bridge.start).toHaveBeenCalledTimes(2);
	});

	it.each(["permission", "unavailable", "microphone", "busy", "timeout", "failed"] as const)("surfaces %s and leaves the draft alone", async (error) => {
		const s = setup();
		const id = await s.start();
		s.emit({ id, type: "error", error });
		expect(s.result.current.error).toBe(error);
		expect(s.result.current.active).toBe(false);
		expect(s.insert).not.toHaveBeenCalled();
	});

	it.each(["disable", "scope", "locale", "unmount"])("discards recording on %s", async (kind) => {
		const s = setup();
		const id = await s.start();
		if (kind === "unmount") s.unmount();
		else s.rerender({ disabled: kind === "disable", scope: kind === "scope" ? "two" : "one", locale: kind === "locale" ? "fr" : "en" });
		s.emit({ id, type: "result", text: "wrong draft" });
		expect(s.bridge.cancel).toHaveBeenCalledWith(id);
		expect(s.insert).not.toHaveBeenCalled();
	});

	it("refreshes denied availability on focus without requesting access automatically", async () => {
		const s = setup();
		await waitFor(() => expect(s.result.current.availability.available).toBe(true));
		vi.mocked(s.bridge.availability).mockResolvedValueOnce({ available: false, error: "permission" });
		act(() => window.dispatchEvent(new Event("focus")));
		await waitFor(() => expect(s.result.current.availability).toEqual({ available: false, error: "permission" }));
		await act(() => s.result.current.start());
		expect(s.bridge.start).not.toHaveBeenCalled();
	});
});

it("handles refused start and a rejected bridge without inserting text", async () => {
	const s = setup();
	await waitFor(() => expect(s.result.current.availability.available).toBe(true));
	vi.mocked(s.bridge.start).mockResolvedValueOnce({ error: "busy" });
	await act(() => s.result.current.start());
	expect(s.result.current.error).toBe("busy");
	expect(s.result.current.active).toBe(false);
	vi.mocked(s.bridge.start).mockRejectedValueOnce(new Error("private transport details"));
	await act(() => s.result.current.start());
	expect(s.result.current.error).toBe("failed");
	expect(s.insert).not.toHaveBeenCalled();
});

it("cancels when the desktop document becomes hidden", async () => {
	const s = setup();
	const id = await s.start();
	const previous = Object.getOwnPropertyDescriptor(document, "hidden");
	Object.defineProperty(document, "hidden", { configurable: true, value: true });
	try { act(() => document.dispatchEvent(new Event("visibilitychange"))); }
	finally {
		if (previous) Object.defineProperty(document, "hidden", previous);
		else Reflect.deleteProperty(document, "hidden");
	}
	s.emit({ id, type: "result", text: "discard" });
	expect(s.bridge.cancel).toHaveBeenCalledWith(id);
	expect(s.insert).not.toHaveBeenCalled();
});
