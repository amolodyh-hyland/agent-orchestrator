import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $getRoot, $getSelection, $isRangeSelection, CONTROLLED_TEXT_INSERTION_COMMAND, UNDO_COMMAND, type LexicalEditor } from "lexical";
import { createRef } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createEngine } from "../../lib/code-highlight-engine";
import type { HighlightWorkerRequest } from "../../lib/code-highlight-protocol";
import { useUiStore } from "../../stores/ui-store";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";

const engine = await createEngine();
const registry = new Map<string, Set<Range>>();
let holdReplies = false;
const replies: (() => void)[] = [];
const requests: HighlightWorkerRequest[] = [];
class FakeWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	postMessage(request: HighlightWorkerRequest) {
		requests.push(request);
		if (request.kind !== "highlight") return;
		const reply = () => this.onmessage?.(new MessageEvent("message", { data: { kind: "highlight", id: request.id, tree: engine.highlight(request.language, request.code) } }));
		if (holdReplies) replies.push(reply);
		else queueMicrotask(reply);
	}
}
beforeAll(() => {
	vi.stubGlobal("Highlight", class extends Set<Range> {});
	vi.stubGlobal("CSS", { ...globalThis.CSS, highlights: registry });
	vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
	holdReplies = false;
	for (const reply of replies.splice(0)) reply();
	useUiStore.setState({ defaultCodeBlockLanguage: "none", defaultInlineCodeLanguage: "none", codeColorTheme: "app", resolvedTheme: "dark" });
});
afterAll(() => vi.unstubAllGlobals());

function setup(text: string, label = "Composer") {
	const ref = createRef<ComposerEditorHandle>();
	const view = render(<ComposerEditor ref={ref} enterSends label={label} placeholder="Message" menuOpen={false} menuId="menu" activeIndex={0} onChange={vi.fn()} onComplete={() => undefined} onEnter={() => false} onCompositionChange={vi.fn()} onKeyDown={vi.fn()} onPaste={vi.fn()} />);
	const field = screen.getByRole("combobox", { name: label });
	const editor = (field as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
	act(() => { field.focus(); ref.current!.setText(text); });
	return { ...view, ref, field, editor };
}
function highlighted(kind: string) {
	return [...registry].filter(([name]) => name.endsWith(`-${kind}`)).flatMap(([, ranges]) => [...ranges].map((range) => range.toString()));
}

it("colors default fences and inline code without changing text, caret, undo or redo state", async () => {
	useUiStore.setState({ defaultCodeBlockLanguage: "typescript", defaultInlineCodeLanguage: "python" });
	const source = '```\nconst number = 23;\n```\n`def hello(): pass`';
	const { ref, field, editor, unmount } = setup(source);
	const documentBefore = editor.getEditorState().toJSON();
	const selectionBefore = editor.getEditorState().read(() => $getSelection()?.clone());
	const nativeBefore = window.getSelection()?.getRangeAt(0).cloneRange();
	await waitFor(() => expect(highlighted("keyword")).toEqual(expect.arrayContaining(["const", "def", "pass"])));
	expect(ref.current!.getSnapshot().text).toBe(source);
	expect(editor.getEditorState().toJSON()).toEqual(documentBefore);
	expect(editor.getEditorState().read(() => $getSelection()?.is(selectionBefore!))).toBe(true);
	expect(window.getSelection()?.anchorNode).toBe(nativeBefore?.startContainer);
	expect(window.getSelection()?.anchorOffset).toBe(nativeBefore?.startOffset);
	act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
	expect(ref.current!.getSnapshot().text).toBe(source);
	expect(field.querySelector(".chat-composer-code-block")).toBeInTheDocument();
	unmount();
	expect(registry.size).toBe(0);
});

it("honors explicit fence languages and does not apply the default to text or unknown labels", async () => {
	useUiStore.setState({ defaultCodeBlockLanguage: "typescript" });
	setup('```python\ndef explicit(): pass\n```\n```text\nconst plain = 29;\n```\n```unknown\nconst other = 31;\n```');
	await waitFor(() => expect(highlighted("keyword")).toContain("def"));
	expect(highlighted("keyword")).not.toContain("const");
});

it("discards stale worker replies, skips composition and colors the latest text afterward", async () => {
	useUiStore.setState({ defaultInlineCodeLanguage: "typescript" });
	holdReplies = true;
	const { ref, field } = setup('`const stale = 41;`');
	await waitFor(() => expect(replies.length).toBeGreaterThan(0));
	fireEvent.compositionStart(field);
	act(() => ref.current!.setText('`const fresh = 43;`'));
	await act(async () => { for (const reply of replies.splice(0)) reply(); });
	expect(registry.size).toBe(0);
	holdReplies = false;
	fireEvent.compositionEnd(field);
	await waitFor(() => expect(highlighted("number")).toContain("43"));
	expect(highlighted("number")).not.toContain("41");
});

it("repaints light/dark palettes without a new worker request or caret move", async () => {
	useUiStore.setState({ defaultInlineCodeLanguage: "typescript", codeColorTheme: "nord" });
	const { field, editor } = setup('`const theme = 47;`');
	await waitFor(() => expect(highlighted("keyword")).toContain("const"));
	const calls = requests.length;
	const selection = editor.getEditorState().read(() => $getSelection()?.clone());
	const dark = field.parentElement!.style.getPropertyValue("--ao-code-keyword");
	act(() => useUiStore.setState({ resolvedTheme: "light" }));
	expect(field.parentElement!.style.getPropertyValue("--ao-code-keyword")).not.toBe(dark);
	expect(requests).toHaveLength(calls);
	expect(editor.getEditorState().read(() => $getSelection()?.is(selection!))).toBe(true);
});

it("coalesces rapid edits and keeps inserted text editable", async () => {
	useUiStore.setState({ defaultInlineCodeLanguage: "typescript" });
	const { ref, editor } = setup('`const burst = 53;`');
	const calls = requests.length;
	for (let number = 54; number <= 60; number += 1) act(() => ref.current!.setText(`\`const burst = ${number};\``));
	await waitFor(() => expect(highlighted("number")).toContain("60"));
	expect(requests.length - calls).toBe(1);
	act(() => editor.update(() => { $getRoot().selectEnd(); }, { discrete: true }));
	act(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, " editable"));
	await waitFor(() => expect(ref.current!.getSnapshot().text).toContain("editable"));
	expect(editor.getEditorState().read(() => $isRangeSelection($getSelection()))).toBe(true);
});


it("keeps simultaneous composers isolated when one unmounts", async () => {
	useUiStore.setState({ defaultInlineCodeLanguage: "typescript" });
	const first = setup('`const first = 67;`', "First composer");
	setup('`const second = 71;`', "Second composer");
	await waitFor(() => expect(highlighted("number")).toEqual(expect.arrayContaining(["67", "71"])));
	first.unmount();
	expect(highlighted("number")).toContain("71");
	expect(highlighted("number")).not.toContain("67");
});

it("keeps very large drafts readable without submitting unbounded highlighting work", async () => {
	useUiStore.setState({ defaultInlineCodeLanguage: "typescript" });
	const source = "`" + "x".repeat(100_001) + "`";
	const calls = requests.length;
	const { ref } = setup(source);
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
	expect(requests).toHaveLength(calls);
	expect(registry.size).toBe(0);
	expect(ref.current!.getSnapshot().text).toBe(source);
});


it("bounds DOM highlight ranges for densely tokenized code", async () => {
	useUiStore.setState({ defaultCodeBlockLanguage: "typescript" });
	setup("```\n" + "x=1;".repeat(8_000) + "\n```");
	await waitFor(() => expect(highlighted("number")).toContain("1"));
	expect([...registry.values()].reduce((total, ranges) => total + ranges.size, 0)).toBeLessThanOrEqual(10_000);
});
