import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	CONTROLLED_TEXT_INSERTION_COMMAND,
	$getNodeByKey,
	$createRangeSelection,
	$setSelection,
	REDO_COMMAND,
	UNDO_COMMAND,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { typeInLexicalEditor } from "../../test/lexical";
import { aoBridge } from "../../lib/bridge";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";

function setup(text: string) {
	const ref = createRef<ComposerEditorHandle>();
	const onChange = vi.fn();
	const onEnter = vi.fn(() => true);
	render(
		<ComposerEditor
			ref={ref}
			label="Composer"
			placeholder="Message"
			menuOpen={false}
			menuId="menu"
			activeIndex={0}
			onChange={onChange}
			onComplete={() => undefined}
			onEnter={onEnter}
			onCompositionChange={vi.fn()}
			onKeyDown={vi.fn()}
			onPaste={vi.fn()}
		/>,
	);
	const field = screen.getByRole("combobox", { name: "Composer" });
	const editor = (field as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
	act(() => {
		field.focus();
		ref.current!.setText(text);
	});
	return { ref, field, editor, onChange, onEnter };
}

function caret(editor: LexicalEditor, offset: number) {
	act(() =>
		editor.update(
			() => {
				let start = 0;
				const visit = (node: LexicalNode): boolean => {
					if ($isElementNode(node)) return node.getChildren().some(visit);
					const end = start + node.getTextContentSize();
					if ($isTextNode(node) && offset >= start && offset <= end && node.getStyle() !== "display: none") {
						node.select(offset - start, offset - start);
						return true;
					}
					start = end;
					return false;
				};
				visit($getRoot());
			},
			{ discrete: true },
		),
	);
}

function selectRange(editor: LexicalEditor, anchor: number, focus: number) {
	act(() =>
		editor.update(
			() => {
				const selection = $createRangeSelection();
				$setSelection(selection);
				for (const [point, offset] of [
					[selection.anchor, anchor],
					[selection.focus, focus],
				] as const) {
					let start = 0;
					const leaves: LexicalNode[] = [];
					const visit = (node: LexicalNode) => {
						if ($isElementNode(node)) node.getChildren().forEach(visit);
						else leaves.push(node);
					};
					visit($getRoot());
					for (const node of leaves) {
						const end = start + node.getTextContentSize();
						if ($isTextNode(node) && offset >= start && offset <= end && node.getStyle() !== "display: none") {
							point.set(node.getKey(), offset - start, "text");
							break;
						}
						start = end;
					}
				}
			},
			{ discrete: true },
		),
	);
}

describe("composer code editing", () => {
	it.each([
		["A `abcd` Z", 0, 5, "X`cd` Z", "`cd` Z", "A `ab`"],
		["A `abcd` Z", 5, 0, "X`cd` Z", "`cd` Z", "A `ab`"],
		["A `abcd` Z", 5, 10, "A `ab`X", "A `ab`", "`cd` Z"],
		["A `abcd` Z", 7, 10, "A `abcd`X", "A `abcd`", " Z"],
		["A `abcd` Z", 10, 7, "A `abcd`X", "A `abcd`", " Z"],
		["A `abcd` Z", 0, 3, "X`abcd` Z", "`abcd` Z", "A "],
		["A `abcd` Z", 3, 0, "X`abcd` Z", "`abcd` Z", "A "],
		["A `abcd` M `efgh` Z", 5, 14, "A `ab`X`gh` Z", "A `abgh` Z", "`cd` M `ef`"],
		["A ``abcd`` M `efgh` Z", 6, 16, "A ``ab``X`gh` Z", "A ``abgh`` Z", "``cd`` M `ef`"],
		["A\n```ts\nabcd\n```\nZ", 0, 10, "X\n```ts\ncd\n```\nZ", "```ts\ncd\n```\nZ", "A\n```ts\nab\n```"],
		["A\n```ts\nabcd\n```\nZ", 10, 18, "A\n```ts\nab\n```\nX", "A\n```ts\nab\n```", "```ts\ncd\n```\nZ"],
		["A\n```ts\nabcd\n```\nZ", 12, 18, "A\n```ts\nabcd\n```\nX", "A\n```ts\nabcd\n```", "\nZ"],
		["A\n```ts\nabcd\n```\nZ", 18, 12, "A\n```ts\nabcd\n```\nX", "A\n```ts\nabcd\n```", "\nZ"],
		["A\n```ts\nabcd\n```\nZ", 0, 8, "X\n```ts\nabcd\n```\nZ", "```ts\nabcd\n```\nZ", "A\n"],
		["A\n```ts\nabcd\n```\nZ", 8, 0, "X\n```ts\nabcd\n```\nZ", "```ts\nabcd\n```\nZ", "A\n"],
	])(
		"keeps code boundaries balanced for typing, paste, and cut: %s [%i,%i]",
		async (source, anchor, focus, typed, cut, copied) => {
			const { ref, editor, field } = setup(source);
			selectRange(editor, anchor, focus);
			await act(async () => {
				editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "X");
			});
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(typed));
			act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source));
			selectRange(editor, anchor, focus);
			fireEvent.paste(field, { clipboardData: { getData: (type: string) => (type === "text/plain" ? "X" : "") } });
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(typed));
			act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source));
			selectRange(editor, anchor, focus);
			fireEvent.keyDown(field, { key: "Backspace" });
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(cut));
			act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source));
			selectRange(editor, anchor, focus);
			const setData = vi.fn();
			fireEvent.cut(field, { clipboardData: { setData } });
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(cut));
			expect(setData).toHaveBeenCalledWith("text/plain", copied);
		},
	);

	it.each(["A `value` Z", "A\n```ts\nvalue\n```\nZ"])(
		"undoes ordinary edits without a presentation-only step: %s",
		async (source) => {
			const { ref, editor } = setup(source);
			caret(editor, 1);
			await act(async () => {
				editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "X");
			});
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source.slice(0, 1) + "X" + source.slice(1)));
			act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source));
			act(() => editor.dispatchCommand(REDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(source.slice(0, 1) + "X" + source.slice(1)));
		},
	);

	it("retains the existing code node when an edit only changes surrounding prose", async () => {
		const { editor } = setup("A `value` Z");
		const block = editor
			.getEditorState()
			.read(() => $getRoot().getFirstChildOrThrow<import("lexical").ElementNode>().getChildAtIndex(1)!);
		caret(editor, 1);
		await act(async () => {
			editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "X");
		});
		expect(editor.getEditorState().read(() => $getNodeByKey(block.getKey()))).toBe(block);
	});
	it.each([
		"before `value` after",
		"``a ` tick``",
		"```ts\nconst a = `b`;\n```",
		"  ````custom option\r\na\r\n\r\nb\r\n`````  \r\nafter",
		"```\n",
		"```\n\n```",
	])("hides recognized markers and round-trips exact Markdown: %s", (text) => {
		const { ref, field } = setup(text);
		expect(ref.current!.getSnapshot().text).toBe(text);
		const markers = field.querySelectorAll('[style="display: none;"]');
		expect(markers.length).toBeGreaterThan(0);
		expect([...markers].map((node) => node.textContent).join("")).toContain("`");
	});

	it.each(["`value`", "```ts\nvalue\n```"])(
		"backspace at the start unwraps code with one undoable edit: %s",
		async (text) => {
			const { ref, editor, field } = setup(text);
			caret(editor, text.indexOf("value"));
			fireEvent.keyDown(field, { key: "Backspace" });
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("value"));
			act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe(text));
			act(() => editor.dispatchCommand(REDO_COMMAND, undefined));
			await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("value"));
		},
	);

	it("moves across invisible inline delimiters and types outside the span", async () => {
		const { ref, editor, field } = setup("`value`");
		caret(editor, 6);
		fireEvent.keyDown(field, { key: "ArrowRight" });
		act(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "!"));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("`value`!"));
	});

	it("deletes the formatting at the closing edge without deleting code", async () => {
		const { ref, editor, field } = setup("`value`");
		caret(editor, 6);
		fireEvent.keyDown(field, { key: "Delete" });
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("value"));
	});

	it("sets a custom fence language, persists the change, and copies only the code", async () => {
		const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
		const { ref, onChange, editor } = setup("````custom\nhello\nworld\n````");
		const dropdown = await screen.findByRole("combobox", { name: "Code language" });
		expect(dropdown).toHaveTextContent("custom");
		await userEvent.click(dropdown);
		await userEvent.click(screen.getByRole("option", { name: /^python$/ }));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("````python\nhello\nworld\n````"));
		expect(onChange.mock.lastCall?.[0].text).toBe("````python\nhello\nworld\n````");
		await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
		expect(copy).toHaveBeenCalledWith("hello\nworld");
		expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
		act(() => editor.dispatchCommand(UNDO_COMMAND, undefined));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("````custom\nhello\nworld\n````"));
		act(() => editor.dispatchCommand(REDO_COMMAND, undefined));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("````python\nhello\nworld\n````"));
		copy.mockRestore();
	});

	it("does not claim copy succeeded when the clipboard rejects it", async () => {
		const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockRejectedValue(new Error("denied"));
		setup("```\nhello\n```");
		await userEvent.click(await screen.findByRole("button", { name: "Copy code" }));
		expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
		copy.mockRestore();
	});

	it("shows collapse controls only for overflowing blocks and keeps the draft intact", async () => {
		const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
		const source = "```\n" + "line\n".repeat(20) + "```";
		const { ref, field } = setup(source);
		const more = await screen.findByRole("button", { name: "Show more" });
		expect(more).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(more);
		expect(field.querySelector(".chat-composer-code-body")).toHaveStyle({ maxHeight: "none" });
		await userEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(field.querySelector(".chat-composer-code-body")).toHaveStyle({ maxHeight: "160px" });
		expect(ref.current!.getSnapshot().text).toBe(source);
		height.mockRestore();
	});

	it("keeps short blocks free of collapse controls", () => {
		setup("```\nshort\n```");
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("defers recognition and edge deletion during composition", async () => {
		const { editor, field, ref, onEnter } = setup("`value");
		fireEvent.compositionStart(field);
		await typeInLexicalEditor(field, "`");
		expect(field.querySelector(".chat-composer-inline-code")).toBeNull();
		fireEvent.keyDown(field, { key: "Enter", isComposing: true });
		expect(onEnter).not.toHaveBeenCalled();
		fireEvent.compositionEnd(field);
		await waitFor(() => expect(field.querySelector(".chat-composer-inline-code")).not.toBeNull());
		expect(ref.current!.getSnapshot().text).toBe("`value`");
		caret(editor, 1);
		fireEvent.compositionStart(field);
		const composingText = ref.current!.getSnapshot().text;
		fireEvent.keyDown(field, { key: "Backspace", isComposing: true });
		expect(ref.current!.getSnapshot().text).toBe(composingText);
		fireEvent.compositionEnd(field);
	});

	it("preserves a range selection through live formatting", async () => {
		const { editor, ref } = setup("before `value` after");
		act(() =>
			editor.update(
				() => {
					const node = $getRoot()
						.getAllTextNodes()
						.find((node) => node.getTextContent() === "value");
					node!.select(0, 5);
				},
				{ discrete: true },
			),
		);
		expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe("value");
		expect(ref.current!.getSnapshot().text).toBe("before `value` after");
	});

	it("replaces selected code content while preserving its hidden markers", async () => {
		const { editor, ref } = setup("before `value` after");
		act(() =>
			editor.update(
				() => {
					$getRoot()
						.getAllTextNodes()
						.find((node) => node.getTextContent() === "value")!
						.select(0, 5);
				},
				{ discrete: true },
			),
		);
		act(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "replacement"));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("before `replacement` after"));
	});

	it("preserves selection offsets in ordinary multiline drafts", async () => {
		const { editor, ref } = setup("first\nsecond");
		act(() =>
			editor.update(
				() => {
					$getRoot()
						.getAllTextNodes()
						.find((node) => node.getTextContent() === "second")!
						.select(1, 4);
				},
				{ discrete: true },
			),
		);
		act(() => editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "X"));
		await waitFor(() => expect(ref.current!.getSnapshot().text).toBe("first\nsXnd"));
	});

	it("places the caret inside a block wrapped on a later paragraph", async () => {
		const { editor, ref, field } = setup("first\nsecond");
		act(() =>
			editor.update(
				() => {
					$getRoot()
						.getAllTextNodes()
						.find((node) => node.getTextContent() === "second")!
						.select(0, 6);
				},
				{ discrete: true },
			),
		);
		act(() => {
			ref.current!.wrapCodeBlock();
		});
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		expect(field).toHaveFocus();
		expect(ref.current!.getSnapshot().text).toBe("first\n```\nsecond\n\n```");
	});

	it("keeps an editable caret between the hidden fences of an empty block", async () => {
		const { editor, ref, field } = setup("");
		act(() => {
			ref.current!.wrapCodeBlock();
		});
		await waitFor(() => expect(field.querySelector(".chat-composer-code-block")).not.toBeNull());
		await act(async () => {
			editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, "hello");
		});
		expect(ref.current!.getSnapshot().text).toBe("```\nhello\n```");
	});

	it("moves by grapheme inside code without splitting an emoji sequence", async () => {
		const { editor, field } = setup("`a👩‍💻b`");
		caret(editor, 8);
		await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
		expect(field).toHaveFocus();
		expect(
			editor.getEditorState().read(() => {
				const selection = $getSelection();
				return $isRangeSelection(selection) ? selection.anchor.offset : undefined;
			}),
		).toBe(1);
	});
});
