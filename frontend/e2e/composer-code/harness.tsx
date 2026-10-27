import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { appI18n } from "../../src/renderer/i18n";
import {
	ComposerEditor,
	type ComposerEditorHandle,
	type ComposerEditorSnapshot,
} from "../../src/renderer/components/chat/ComposerEditor";
import "../../src/renderer/styles.css";

function Fixture() {
	const editor = useRef<ComposerEditorHandle>(null);
	const parameters = new URLSearchParams(location.search);
	const initial =
		parameters.get("text") ??
		"Run `npm test`.\n```typescript\n" + "const value = 1;\n".repeat(18) + "```";
	const [wire, setWire] = useState(initial);
	const [sent, setSent] = useState("");
	const [menuOpen, setMenuOpen] = useState(parameters.get("popup") === "1");
	const [activeIndex, setActiveIndex] = useState(0);
	const options = ["src/first.ts", "src/second.ts"];
	useEffect(() => {
		editor.current?.setText(initial);
	}, [initial]);
	const onChange = useCallback((snapshot: ComposerEditorSnapshot) => setWire(snapshot.text), []);
	const onEnter = useCallback((snapshot: ComposerEditorSnapshot) => {
		setSent(snapshot.text);
		editor.current?.clear();
		setWire("");
		return true;
	}, []);
	return (
		<main className="mx-auto max-w-2xl space-y-4 bg-background p-6 text-foreground">
			<div className="cursor-chat-composer p-3">
				<ComposerEditor
					ref={editor}
					label="Message"
					placeholder="Message"
					menuOpen={menuOpen}
					menuId="suggestions"
					activeIndex={activeIndex}
					onChange={onChange}
					onComplete={(snapshot, key) => {
						if (!menuOpen || !snapshot.trigger || key !== "Tab") return undefined;
						setMenuOpen(false);
						return options[activeIndex];
					}}
					onEnter={onEnter}
					onCompositionChange={() => undefined}
					onKeyDown={(event) => {
						if (!menuOpen || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
						event.preventDefault();
						setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
					}}
					onPaste={() => undefined}
				/>
			</div>
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => editor.current?.wrapInlineCode()}
			>
				Inline code
			</button>
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => editor.current?.wrapCodeBlock()}
			>
				Code block
			</button>
			{menuOpen ? (
				<ul role="listbox" id="suggestions" aria-label="Files">
					{options.map((option, index) => (
						<li key={option} role="option" id={`suggestions-option-${index}`} aria-selected={activeIndex === index}>
							{option}
						</li>
					))}
				</ul>
			) : null}
			<pre data-testid="wire">{wire}</pre>
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					editor.current?.clear();
					setWire("");
				}}
			>
				Clear
			</button>
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => editor.current?.insertText("!")}
			>
				Insert dictated text
			</button>
			<pre data-testid="sent">{sent}</pre>
		</main>
	);
}

createRoot(document.getElementById("composer-root")!).render(
	<I18nextProvider i18n={appI18n}>
		<Fixture />
	</I18nextProvider>,
);
