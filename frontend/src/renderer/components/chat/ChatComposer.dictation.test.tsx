import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "react";
import { aoBridge } from "../../lib/bridge";
import type { DictationUpdate } from "../../../shared/dictation";
import { ChatComposer } from "./ChatComposer";
import { TooltipProvider } from "../ui/tooltip";
import { typeInLexicalEditor, placeLexicalCaret } from "../../test/lexical";
import { activateChatDraftScope, readChatSessionDraft } from "../../lib/chat-drafts";

let emit: (event: DictationUpdate) => void;
beforeEach(() => {
	vi.spyOn(aoBridge.dictation, "availability").mockResolvedValue({ available: true });
	vi.spyOn(aoBridge.dictation, "start").mockResolvedValue({});
	vi.spyOn(aoBridge.dictation, "stop").mockResolvedValue(undefined);
	vi.spyOn(aoBridge.dictation, "cancel").mockResolvedValue(undefined);
	vi.spyOn(aoBridge.dictation, "onEvent").mockImplementation((listener) => { emit = listener; return () => undefined; });
});
afterEach(() => vi.restoreAllMocks());

function setup(extra: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
	const onSend = vi.fn();
	const view = render(<TooltipProvider><Activity mode="visible"><ChatComposer onSend={onSend} {...extra} /></Activity></TooltipProvider>);
	const field = screen.getByRole("combobox");
	const start = async () => {
		const mic = screen.getByRole("button", { name: "Dictate on this device" });
		await waitFor(() => expect(mic).toBeEnabled());
		fireEvent.mouseDown(mic);
		fireEvent.click(mic);
		const id = vi.mocked(aoBridge.dictation.start).mock.calls.at(-1)![0];
		act(() => emit({ id, type: "recording" }));
		return id;
	};
	return { ...view, onSend, field, start };
}

describe("chat dictation controls", () => {
	it("inserts at the cursor, persists the draft, and waits for an explicit send", async () => {
		const scope = { sessionId: "dictation-chat", incarnation: "dictation-chat-instance" };
		activateChatDraftScope(scope);
		const s = setup({ draftSessionId: scope.sessionId, draftSessionIncarnation: scope.incarnation });
		await typeInLexicalEditor(s.field, "hello world");
		await placeLexicalCaret(s.field, 6);
		const id = await s.start();
		expect(screen.getByRole("status")).toHaveTextContent("Recording on this device");
		expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
		fireEvent.keyDown(s.field, { key: "Enter" });
		expect(s.onSend).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Stop dictation and insert text" }));
		expect(aoBridge.dictation.stop).toHaveBeenCalledWith(id);
		// IPC acceptance is not evidence that the native microphone has closed.
		expect(screen.getByRole("status")).toHaveTextContent("Recording on this device");
		act(() => emit({ id, type: "capture-stopped" }));
		expect(screen.getByRole("status")).toHaveTextContent("Finishing dictation");
		expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
		act(() => emit({ id, type: "result", text: "brave " }));
		expect(s.field).toHaveTextContent("hello brave world");
		expect(readChatSessionDraft(scope).composer.text).toBe("hello brave world");
		expect(s.onSend).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(s.onSend).toHaveBeenCalledWith("hello brave world", undefined, expect.any(String)));
	});

	it("cancels on Escape and never inserts a late transcript", async () => {
		const s = setup();
		await typeInLexicalEditor(s.field, "keep me");
		const id = await s.start();
		fireEvent.keyDown(s.field, { key: "Escape" });
		act(() => emit({ id, type: "result", text: "discard" }));
		expect(aoBridge.dictation.cancel).toHaveBeenCalledWith(id);
		expect(s.field).toHaveTextContent("keep me");
		expect(s.onSend).not.toHaveBeenCalled();
	});

	it("allows cancel while permission is pending and exposes permission errors", async () => {
		const s = setup();
		await waitFor(() => expect(screen.getByRole("button", { name: "Dictate on this device" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Dictate on this device" }));
		const id = vi.mocked(aoBridge.dictation.start).mock.calls.at(-1)![0];
		expect(screen.getByRole("button", { name: "Cancel dictation" })).toBeEnabled();
		act(() => emit({ id, type: "error", error: "permission" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Allow microphone and speech access");
		expect(s.onSend).not.toHaveBeenCalled();
	});

	it("disables the mic with a keyboard-accessible explanation when unsupported", async () => {
		vi.mocked(aoBridge.dictation.availability).mockResolvedValue({ available: false, error: "unsupported" });
		setup();
		await waitFor(() => expect(screen.getByLabelText("Dictation requires the macOS or Windows desktop app.")).toHaveAttribute("tabindex", "0"));
		expect(screen.getByRole("button", { name: "Dictate on this device" })).toBeDisabled();
	});

	it.each([
		["permission", "Allow microphone and speech access"],
		["unavailable", "Install speech resources in system settings"],
		["unsupported", "Dictation requires the macOS or Windows desktop app"],
	] as const)("shows persistent %s recovery without opening a tooltip", async (error, text) => {
		vi.mocked(aoBridge.dictation.availability).mockResolvedValue({ available: false, error });
		setup();
		const status = await screen.findByRole("status");
		expect(status).toBeVisible();
		expect(status).toHaveTextContent(text);
		expect(status).toHaveAttribute("aria-live", "polite");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		expect(aoBridge.dictation.start).not.toHaveBeenCalled();
	});

	it.each(["hidden", "inert", "aria-hidden", "display", "visibility", "activity", "unmount"])("cancels capture when controls disappear via %s", async (kind) => {
		const s = setup();
		await typeInLexicalEditor(s.field, "preserved draft");
		const id = await s.start();
		if (kind === "unmount") s.unmount();
		else if (kind === "activity") {
			// Activity hides retained chat tabs without unmounting their editors.
			s.rerender(<TooltipProvider><Activity mode="hidden"><ChatComposer onSend={s.onSend} /></Activity></TooltipProvider>);
		} else {
			act(() => {
				if (kind === "display") s.container.style.display = "none";
				else if (kind === "visibility") s.container.style.visibility = "hidden";
				else s.container.setAttribute(kind, kind === "aria-hidden" ? "true" : "");
			});
		}
		await waitFor(() => expect(aoBridge.dictation.cancel).toHaveBeenCalledWith(id));
		act(() => emit({ id, type: "result", text: "discarded speech" }));
		expect(s.field).not.toHaveTextContent("discarded speech");
		if (kind !== "activity" && kind !== "unmount") expect(s.field).toHaveTextContent("preserved draft");
		expect(s.onSend).not.toHaveBeenCalled();
	});

	it("keeps native orchestrator sending disarmed while dictating", async () => {
		const s = setup({ nativeSession: { sessionId: "outer", outer: true, expected: { bindingRevision: 2, scopeRevision: 2, controllerGeneration: "generation", settingsDigest: "a".repeat(64) } } });
		await typeInLexicalEditor(s.field, "draft");
		await s.start();
		expect(s.field.closest("form")).not.toHaveAttribute("data-outer-stage-id");
		fireEvent.keyDown(s.field, { key: "Enter" });
		expect(s.onSend).not.toHaveBeenCalled();
	});
});
