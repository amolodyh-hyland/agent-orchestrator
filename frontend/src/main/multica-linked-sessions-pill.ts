export const MULTICA_LINKED_SESSIONS_PILL_ID = "ao-linked-sessions";
export const MAX_PILL_ENTRIES = 5;

export type LinkedSessionPillEntry = { label: string; url: string };

const PILL_STYLES = `
.ao-linked-sessions-column {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 6px;
	font: 12px system-ui, sans-serif;
	pointer-events: none;
}
button {
	appearance: none;
	border: 1px solid rgba(31, 41, 55, 0.18);
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.96);
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
	color: #1f2937;
	cursor: pointer;
	font: inherit;
	line-height: 1.2;
	padding: 6px 10px;
	pointer-events: auto;
}
button:hover {
	background: #f3f4f6;
}
.ao-linked-sessions-more {
	border: 1px solid rgba(31, 41, 55, 0.14);
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.96);
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
	color: #374151;
	font: inherit;
	padding: 4px 8px;
}
@media (prefers-color-scheme: dark) {
	button {
		border-color: rgba(255, 255, 255, 0.2);
		background: rgba(31, 41, 55, 0.96);
		color: #f9fafb;
	}
	button:hover {
		background: #374151;
	}
	.ao-linked-sessions-more {
		border-color: rgba(255, 255, 255, 0.16);
		background: rgba(31, 41, 55, 0.96);
		color: #e5e7eb;
	}
}
`;

function escapeScriptJson(value: unknown): string {
	const json = JSON.stringify(value) ?? "null";
	return json.replace(/[<\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Source for webContents.executeJavaScript: replaces (or, with no entries, removes) the AO pill in the page. */
export function buildLinkedSessionsPillScript(entries: readonly LinkedSessionPillEntry[]): string {
	const payload = escapeScriptJson({
		entries: entries.slice(0, MAX_PILL_ENTRIES),
		overflow: Math.max(0, entries.length - MAX_PILL_ENTRIES),
	});
	const styles = JSON.stringify(PILL_STYLES) ?? "\"\"";

	return `(function () {
	document.querySelectorAll("#${MULTICA_LINKED_SESSIONS_PILL_ID}").forEach((element) => element.remove());
	const payload = ${payload};
	if (payload.entries.length === 0) return;
	const pill = document.createElement("div");
	pill.setAttribute("id", "${MULTICA_LINKED_SESSIONS_PILL_ID}");
	pill.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none");
	const shadow = pill.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = ${styles};
	shadow.appendChild(style);
	const column = document.createElement("div");
	column.setAttribute("class", "ao-linked-sessions-column");
	for (const entry of payload.entries) {
		const button = document.createElement("button");
		button.setAttribute("type", "button");
		button.setAttribute("title", "Open AO session " + entry.label);
		button.textContent = "AO · " + entry.label;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			window.open(entry.url);
		});
		column.appendChild(button);
	}
	if (payload.overflow > 0) {
		const more = document.createElement("span");
		more.setAttribute("class", "ao-linked-sessions-more");
		more.textContent = "+" + payload.overflow;
		column.appendChild(more);
	}
	shadow.appendChild(column);
	document.documentElement.appendChild(pill);
})();`;
}
