import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { $getRoot, $isElementNode, CONTROLLED_TEXT_INSERTION_COMMAND, REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from "lexical";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerEditor, type ComposerEditorHandle, type ComposerEditorSnapshot } from "./ComposerEditor";
import { useUiStore } from "../../stores/ui-store";
import { aoBridge } from "../../lib/bridge";
import { normalizeWorkspaceFileReference } from "../../lib/workspace-file-path";
import { AttachmentPathContext, type AttachmentPathActions } from "./AttachmentPathChip";

afterEach(() => vi.restoreAllMocks());

function setup(actions: AttachmentPathActions = {}) {
	const ref = createRef<ComposerEditorHandle>();
	const onEnter = vi.fn((_snapshot: ComposerEditorSnapshot) => true);
	render(<AttachmentPathContext.Provider value={actions}><ComposerEditor ref={ref} enterSends label="Composer" placeholder="Message" menuOpen={false} menuId="menu" activeIndex={0} onChange={vi.fn()} onComplete={() => undefined} onEnter={onEnter} onCompositionChange={vi.fn()} onKeyDown={vi.fn()} onPaste={vi.fn()} /></AttachmentPathContext.Provider>);
	const field = screen.getByRole("combobox", { name: "Composer" });
	const editor = (field as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
	act(() => { field.focus(); ref.current!.setText("Before "); });
	return { ref, field, editor, onEnter };
}

it("keeps adjacent existing compact tokens raw through send, native copy/cut, undo/redo and paste", async () => {
	const { ref, field, editor, onEnter } = setup();
	const targets = ['https://example.test/a?q=%2F#fragment', 'C:\\Project Files\\résumé.txt'];
	act(() => {
		ref.current!.insertReference(targets[0], "Web page", targets[0]);
		ref.current!.insertReference(targets[1], "résumé.txt", targets[1]);
		ref.current!.insertText("After");
	});
	const raw = `Before ${targets[0]} ${targets[1]} After`;
	expect(ref.current!.getSnapshot().text).toBe(raw);
	expect(field.textContent).not.toContain(targets[0]);
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onEnter.mock.calls[0][0].text).toBe(raw);
	const selectAll = () => act(() => editor.update(() => {
		const paragraph = $getRoot().getFirstChildOrThrow();
		if ($isElementNode(paragraph)) paragraph.select(0, paragraph.getChildrenSize());
	}, { discrete: true }));
	selectAll();
	const setData = vi.fn();
	fireEvent.copy(field, { clipboardData: { setData } });
	await waitFor(() => expect(setData).toHaveBeenCalledWith("text/plain", raw));
	fireEvent.cut(field, { clipboardData: { setData } });
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(""));
	act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(raw));
	act(() => editor.dispatchCommand(REDO_COMMAND, undefined));
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(""));
	fireEvent.paste(field, { clipboardData: { getData: (type: string) => type === "text/plain" ? raw : "" } });
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(raw));
});

it("formats new URL/path tokens while preserving mixed source, selection, clipboard and code wrapping", async () => {
	useUiStore.setState({ chatUrlDisplay: "compact", chatPathDisplay: "compact" });
	const { ref, field, editor, onEnter } = setup();
	const raw = 'See https://example.test/a?q=%2F#part and C:\\Project\\résumé.txt with `const n = 1` after';
	act(() => ref.current!.setText(raw));
	expect(field.querySelector('[data-composer-token="address-url"]')).toHaveTextContent("example.test");
	expect(field.querySelector('[data-composer-token="address-path"]')).toHaveTextContent("résumé.txt");
	expect(ref.current!.getSnapshot().text).toBe(raw);
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onEnter.mock.calls[0][0].text).toBe(raw);
	act(() => editor.update(() => { const p = $getRoot().getFirstChildOrThrow(); if ($isElementNode(p)) p.select(0, p.getChildrenSize()); }, { discrete: true }));
	const setData = vi.fn();
	fireEvent.copy(field, { clipboardData: { setData } });
	await waitFor(() => expect(setData).toHaveBeenCalledWith("text/plain", raw));
	fireEvent.cut(field, { clipboardData: { setData } });
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(""));
	act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(raw));
	act(() => editor.dispatchCommand(REDO_COMMAND, undefined));
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(""));
	fireEvent.paste(field, { clipboardData: { getData: (type: string) => type === "text/plain" ? raw : "" } });
	await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(raw));
	act(() => editor.update(() => { const p = $getRoot().getFirstChildOrThrow(); if ($isElementNode(p)) p.select(0, p.getChildrenSize()); }, { discrete: true }));
	act(() => expect(ref.current!.wrapCodeBlock()).toBe(true));
	expect(ref.current!.getSnapshot().text).toContain(raw);
	expect(field.querySelector('[data-composer-token="address-url"]')).toBeNull();
});

it.each([
	["/tmp/one.txt", "/tmp/two.txt"],
	["C:\\work\\one.txt", "D:\\work\\two.txt"],
	["\\\\server\\share\\one.txt", "\\\\other\\share\\two.txt"],
])("keeps separate compact composer targets, prose and raw send: %s and %s", async (first, second) => {
	useUiStore.setState({ chatPathDisplay: "compact" });
	const { ref, field, editor, onEnter } = setup();
	const raw = `${first} and ${second}`;
	act(() => ref.current!.setText(raw));
	act(() => field.blur());
	await waitFor(() => expect(field.textContent).toBe("one.txt and two.txt"));
	const tokens = field.querySelectorAll('[data-composer-token="address-path"]');
	expect([...tokens].map((token) => token.getAttribute("data-target"))).toEqual([first, second]);
	expect(ref.current!.getSnapshot().text).toBe(raw);
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onEnter.mock.calls[0][0].text).toBe(raw);
	act(() => editor.update(() => { const p = $getRoot().getFirstChildOrThrow(); if ($isElementNode(p)) p.select(0, p.getChildrenSize()); }, { discrete: true }));
	const setData = vi.fn();
	fireEvent.copy(field, { clipboardData: { setData } });
	await waitFor(() => expect(setData).toHaveBeenCalledWith("text/plain", raw));
});

it.each(["file:////server/share/a.txt", "file://localhost//server/share/a.txt", "file:///%2Fserver/share/a.txt", "file:///%5Cserver/share/a.txt"])("keeps decoded network file URLs copy-only and raw in the composer: %s", async (target) => {
	const open = vi.fn();
	const getState = vi.spyOn(aoBridge.editorHandoff, "getState");
	const action = vi.spyOn(aoBridge.editorHandoff, "pathAction");
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const { ref, field, onEnter } = setup({ sessionId: "session-1", onOpenFile: open });
	const raw = `See ${target} after`;
	act(() => ref.current!.setText(raw));
	const item = screen.getByRole("button", { name: target });
	fireEvent.contextMenu(item);
	expect(screen.queryByRole("menuitem", { name: /Open|Reveal/ })).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
	expect(copy).toHaveBeenCalledExactlyOnceWith(target);
	expect(getState).not.toHaveBeenCalled();
	expect(action).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
	expect(item).toHaveAttribute("title", target);
	expect(ref.current!.getSnapshot().text).toBe(raw);
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onEnter.mock.calls[0][0].text).toBe(raw);
});

it.each([
	["/work/a%20.txt", "/work/a%2520.txt", "/work/a%20.txt", "/work/a%20.txt"],
	["/work/a%.txt", "/work/a%25.txt", "/work/a%.txt", "/work/a%.txt"],
	["C:\\work\\a%20.txt", "C:\\work\\a%2520.txt", "C:/work/a%20.txt", "C:\\work\\a%20.txt"],
	["file:///work/a%2520.txt", "file:///work/a%2520.txt", "/work/a%20.txt", "/work/a%20.txt"],
	["file:///C:/work/a%2520.txt", "file:///C:/work/a%2520.txt", "C:/work/a%20.txt", "C:/work/a%20.txt"],
])("opens composer literal-percent paths through the existing resolver exactly once: %s", async (target, reference, expected, nativePath) => {
	useUiStore.setState({ chatPathDisplay: "compact" });
	const resolved = vi.fn();
	const open = vi.fn((path: string) => resolved(normalizeWorkspaceFileReference(path)));
	const action = vi.spyOn(aoBridge.editorHandoff, "pathAction").mockResolvedValue(undefined);
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const { ref, field, onEnter } = setup({ sessionId: "session-1", onOpenFile: open });
	const raw = `See ${target} after`;
	act(() => ref.current!.setText(raw));
	const item = screen.getByRole("button", { name: target });
	fireEvent.contextMenu(item);
	await userEvent.click(screen.getByRole("menuitem", { name: "Open in Orchestrator" }));
	expect(resolved).toHaveBeenCalledExactlyOnceWith(expected);
	expect(open).toHaveBeenCalledExactlyOnceWith(reference);
	fireEvent.contextMenu(item);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
	expect(action).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", path: nativePath, action: "reveal" });
	fireEvent.contextMenu(item);
	await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
	expect(copy).toHaveBeenCalledExactlyOnceWith(target);
	expect(item).toHaveAttribute("title", target);
	expect(field.querySelector('[data-composer-token="address-path"]')).toHaveAttribute("data-target", target);
	expect(ref.current!.getSnapshot().text).toBe(raw);
	fireEvent.keyDown(field, { key: "Enter" });
	expect(onEnter.mock.calls[0][0].text).toBe(raw);
});

it("edits a compact target as selected raw text without immediately retokenizing or changing other text", async () => {
	const { ref, field } = setup();
	act(() => ref.current!.setText("A https://edit.example.test/original Z"));
	fireEvent.click(field.querySelector('[data-composer-token="address-url"] a')!);
	expect(field.querySelector('[data-composer-token="address-url"]')).toBeNull();
	expect(window.getSelection()?.toString()).toBe("https://edit.example.test/original");
	await act(async () => { await Promise.resolve(); });
	expect(field.querySelector('[data-composer-token="address-url"]')).toBeNull();
	act(() => ref.current!.insertText("https://edit.example.test/changed?q=%2F#frag"));
	expect(ref.current!.getSnapshot().text).toBe("A https://edit.example.test/changed?q=%2F#frag Z");
	expect(field.querySelector('[data-composer-token="address-url"]')).toBeNull();
});

it("defers address recognition and send during IME, then formats without changing composed source", async () => {
	const { ref, field, editor, onEnter } = setup();
	act(() => ref.current!.setText(""));
	fireEvent.compositionStart(field);
	act(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "https://ime.example.test/日本語 after"));
	await act(async () => { await Promise.resolve(); });
	expect(field.querySelector('[data-composer-token="address-url"]')).toBeNull();
	fireEvent.keyDown(field, { key: "Enter", isComposing: true, keyCode: 229 });
	expect(onEnter).not.toHaveBeenCalled();
	act(() => editor.update(() => { $getRoot().selectEnd(); }, { discrete: true }));
	fireEvent.compositionEnd(field);
	await waitFor(() => expect(field.querySelector('[data-composer-token="address-url"]')).not.toBeNull());
	expect(ref.current!.getSnapshot().text).toBe("https://ime.example.test/日本語 after");
});

it("formats after blur without stealing focus from another control", async () => {
	const { ref, field } = setup();
	act(() => ref.current!.setText("https://blur.example.test/path"));
	render(<button>Another control</button>);
	const button = screen.getByRole("button", { name: "Another control" });
	await userEvent.click(button);
	await waitFor(() => expect(field.querySelector('[data-composer-token="address-url"]')).not.toBeNull());
	expect(button).toHaveFocus();
	expect(ref.current!.getSnapshot().text).toBe("https://blur.example.test/path");
});
