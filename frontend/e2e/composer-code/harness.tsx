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
	const initial =
		new URLSearchParams(location.search).get("text") ??
		"Run `npm test`.\n```typescript\n" + "const value = 1;\n".repeat(18) + "```";
	const [wire, setWire] = useState(initial);
	const [sent, setSent] = useState("");
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
					menuOpen={false}
					menuId="suggestions"
					activeIndex={0}
					onChange={onChange}
					onComplete={() => undefined}
					onEnter={onEnter}
					onCompositionChange={() => undefined}
					onKeyDown={() => undefined}
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
			<pre data-testid="sent">{sent}</pre>
		</main>
	);
}

createRoot(document.getElementById("composer-root")!).render(
	<I18nextProvider i18n={appI18n}>
		<Fixture />
	</I18nextProvider>,
);
