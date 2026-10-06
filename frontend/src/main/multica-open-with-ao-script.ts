import type { OpenWithAoPagePayload } from "../shared/multica-open-with-ao";
import { locateOpenWithAoAnchor, type OpenWithAoAnchor } from "./multica-open-with-ao-anchor";
import { createOpenWithAoMenu, type OpenWithAoMenu } from "./multica-open-with-ao-menu";

export const OPEN_WITH_AO_CONTROLLER_KEY = "__aoOpenWithAo";

export type OpenWithAoController = {
	version: string;
	update: (payload: OpenWithAoPagePayload) => void;
	destroy: () => void;
	getState: () => "NO_ISSUE" | "WAIT" | "ANCHORED" | "FALLBACK";
};

export type OpenWithAoMenuFactoryOptions = {
	payload: OpenWithAoPagePayload;
	onAction: (url: string) => void;
	getWorkspaceSlug?: () => string | null;
};

function escapeScriptJson(value: unknown): string {
	const json = JSON.stringify(value) ?? "null";
	return json.replace(/[<\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function createOpenWithAoController(options: {
	payload: OpenWithAoPagePayload;
	version: string;
	locate: () => OpenWithAoAnchor | null;
	createMenu: (options: OpenWithAoMenuFactoryOptions) => OpenWithAoMenu;
}): OpenWithAoController {
	const FALLBACK_ID = "ao-open-with-ao-fallback";
	const STYLE_ID = "ao-open-with-ao-style";
	const FALLBACK_DELAY = 1500;
	const MUTATION_DEBOUNCE = 32;
	const VALIDITY_INTERVAL = 2000;
	const RELOCATION_WINDOW = 1000;
	const RELOCATION_LIMIT = 5;
	const RELOCATION_COOLDOWN = 5000;
	function buildHeaderStyles(style: OpenWithAoPagePayload["style"]): string {
		return `
button[data-ao-open-with-ao="trigger"] {
	appearance: none;
	display: inline-flex;
	flex: 0 0 auto;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	height: var(--button-height-sm,1.75rem);
	gap: var(--button-gap-sm,.25rem);
	padding: 0 var(--button-padding-sm,.625rem);
	border: ${style.borderWidth} solid var(--border, rgba(0,0,0,.08));
	border-radius: var(--radius-md,.375rem);
	background: var(--background,#fff);
	background-clip: padding-box;
	color: var(--muted-foreground,#6b7280);
	font: 500 var(--text-label,13px)/var(--text-label--line-height,18px) var(--font-sans,system-ui,sans-serif);
	white-space: nowrap;
	cursor: default;
	user-select: none;
	outline: none;
	-webkit-app-region: no-drag;
	transition: color .15s,background-color .15s,border-color .15s,box-shadow .15s,transform .15s;
}
@media (min-resolution: 2dppx) {
	button[data-ao-open-with-ao="trigger"] { border-width: ${style.borderWidthHiDpi}; }
}
button[data-ao-open-with-ao="trigger"]:hover,
button[data-ao-open-with-ao="trigger"][aria-expanded="true"] {
	background: var(--muted,#f4f4f5);
	color: var(--foreground,#111827);
}
button[data-ao-open-with-ao="trigger"]:focus-visible {
	border-color: var(--ring,#a1a1aa);
	box-shadow: 0 0 0 3px color-mix(in oklab,var(--ring,#a1a1aa) 50%,transparent);
}
button[data-ao-open-with-ao="trigger"]:disabled { pointer-events: none; opacity: .5; }
button[data-ao-open-with-ao="trigger"] svg { width: 14px; height: 14px; flex: 0 0 14px; pointer-events: none; }
.dark button[data-ao-open-with-ao="trigger"] {
	background: color-mix(in oklab,var(--input,rgba(255,255,255,.15)) 30%,transparent);
}
.dark button[data-ao-open-with-ao="trigger"]:hover,
.dark button[data-ao-open-with-ao="trigger"][aria-expanded="true"] {
	background: color-mix(in oklab,var(--input,rgba(255,255,255,.15)) 50%,transparent);
	color: var(--foreground,#fafafa);
}
.dark button[data-ao-open-with-ao="trigger"]:focus-visible { border-color: var(--ring, #a1a1aa); }
`;
	}
	function buildFallbackStyles(style: OpenWithAoPagePayload["style"]): string {
		return `
:host { all: initial; }
button {
	appearance: none;
	display: inline-flex;
	flex: 0 0 auto;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	height: var(--button-height-sm,1.75rem);
	gap: var(--button-gap-sm,.25rem);
	padding: 0 var(--button-padding-sm,.625rem);
	border: ${style.borderWidth} solid var(--border, rgba(0,0,0,.08));
	border-radius: var(--radius-md,.375rem);
	background: var(--background,#fff);
	background-clip: padding-box;
	color: var(--muted-foreground,#6b7280);
	font: 500 var(--text-label,13px)/var(--text-label--line-height,18px) var(--font-sans,system-ui,sans-serif);
	white-space: nowrap;
	cursor: default;
	user-select: none;
	outline: none;
	-webkit-app-region: no-drag;
	box-shadow: var(--menu-shadow, 0 2px 8px rgba(0,0,0,.12));
	transition: color .15s,background-color .15s,border-color .15s,box-shadow .15s,transform .15s;
}
@media (min-resolution: 2dppx) {
	button { border-width: ${style.borderWidthHiDpi}; }
}
button:hover, button[aria-expanded="true"] { background: var(--muted,#f4f4f5); color: var(--foreground,#111827); }
button:focus-visible { border-color: var(--ring,#a1a1aa); box-shadow: 0 0 0 3px color-mix(in oklab,var(--ring,#a1a1aa) 50%,transparent),var(--menu-shadow, 0 2px 8px rgba(0,0,0,.12)); }
button:disabled { pointer-events: none; opacity: .5; }
svg { width: 14px; height: 14px; flex: 0 0 14px; pointer-events: none; }
span { white-space: nowrap; }
:host-context(html.dark) button { background: color-mix(in oklab,var(--input,rgba(255,255,255,.15)) 30%,transparent); }
:host-context(html.dark) button:hover, :host-context(html.dark) button[aria-expanded="true"] { background: color-mix(in oklab,var(--input,rgba(255,255,255,.15)) 50%,transparent); color: var(--foreground,#fafafa); }
:host-context(html.dark) button:focus-visible { border-color: var(--ring, #a1a1aa); }
`;
	}

	let payload = options.payload;
	const readWorkspaceSlug = (): string | null => {
		try {
			const candidate = JSON.parse(localStorage.getItem("multica_tabs") || "null")?.state?.activeWorkspaceSlug;
			if (
				typeof candidate !== "string" ||
				candidate.length < 1 ||
				candidate.length > 63 ||
				!/^[a-z0-9][a-z0-9_-]*$/i.test(candidate)
			) {
				return null;
			}
			return candidate.toLowerCase();
		} catch {
			return null;
		}
	};
	const menu = options.createMenu({
		payload,
		onAction: (url) => window.open(url),
		getWorkspaceSlug: readWorkspaceSlug,
	});
	let state: "NO_ISSUE" | "WAIT" | "ANCHORED" | "FALLBACK" = "WAIT";
	let trigger: HTMLButtonElement | null = null;
	let fallbackHost: HTMLDivElement | null = null;
	let observer: MutationObserver | null = null;
	let fallbackTimer: number | null = null;
	let debounceTimer: number | null = null;
	let validityTimer: number | null = null;
	let resumeTimer: number | null = null;
	let lastAnchorActions: HTMLElement | null = null;
	let headerTriggerWasPlaced = false;
	let pendingRelocation = false;
	let relocationTimes: number[] = [];
	let suppressHeaderUntil = 0;
	let destroyed = false;

	function ensureStyle(): void {
		const styles = document.querySelectorAll<HTMLStyleElement>(`style#${STYLE_ID}`);
		let style = styles[0] ?? null;
		for (let index = 1; index < styles.length; index += 1) styles[index]?.remove();
		if (!style) {
			style = document.createElement("style");
			style.id = STYLE_ID;
		}
		style.textContent = buildHeaderStyles(payload.style);
		if (!style.isConnected) (document.head ?? document.documentElement).appendChild(style);
	}

	function refreshStyles(): void {
		const headerStyle = document.querySelector<HTMLStyleElement>(`style#${STYLE_ID}`);
		if (headerStyle) headerStyle.textContent = buildHeaderStyles(payload.style);
		const fallbackStyle = fallbackHost?.shadowRoot?.querySelector("style");
		if (fallbackStyle) fallbackStyle.textContent = buildFallbackStyles(payload.style);
	}

	function removeStyle(): void {
		document.querySelectorAll(`#${STYLE_ID}`).forEach((style) => style.remove());
	}

	function setTriggerLabel(button: HTMLButtonElement, labelText: string): void {
		button.setAttribute("aria-label", labelText);
		button.setAttribute("title", labelText);
		const label = button.querySelector("span");
		if (label) label.textContent = labelText;
	}

	function clearFallbackTimer(): void {
		if (fallbackTimer === null) return;
		window.clearTimeout(fallbackTimer);
		fallbackTimer = null;
	}

	function clearDebounceTimer(): void {
		if (debounceTimer === null) return;
		window.clearTimeout(debounceTimer);
		debounceTimer = null;
	}

	function clearValidityTimer(): void {
		if (validityTimer === null) return;
		window.clearInterval(validityTimer);
		validityTimer = null;
	}

	function clearResumeTimer(): void {
		if (resumeTimer === null) return;
		window.clearTimeout(resumeTimer);
		resumeTimer = null;
	}

	function clearTimers(): void {
		clearFallbackTimer();
		clearDebounceTimer();
		clearValidityTimer();
		clearResumeTimer();
	}

	function disconnectObserver(): void {
		observer?.disconnect();
		observer = null;
		clearValidityTimer();
	}

	function closeMenuBeforeReplacingTrigger(): void {
		if (menu.isOpen()) menu.close({ restoreFocus: false });
	}

	function syncValidityTimer(): void {
		const shouldRun = observer !== null && !destroyed && payload.issue !== null;
		if (!shouldRun) {
			clearValidityTimer();
			return;
		}
		if (validityTimer !== null) return;
		validityTimer = window.setInterval(() => {
			validateAnchor();
		}, VALIDITY_INTERVAL);
	}

	function createIcon(): SVGSVGElement {
		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		icon.setAttribute("viewBox", "0 0 24 24");
		icon.setAttribute("width", "14");
		icon.setAttribute("height", "14");
		icon.setAttribute("fill", "none");
		icon.setAttribute("stroke", "currentColor");
		icon.setAttribute("stroke-width", "2");
		icon.setAttribute("stroke-linecap", "round");
		icon.setAttribute("stroke-linejoin", "round");
		icon.setAttribute("aria-hidden", "true");
		const antenna = document.createElementNS("http://www.w3.org/2000/svg", "path");
		antenna.setAttribute("d", "M12 5V3m-2 0h4");
		const head = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		head.setAttribute("x", "5");
		head.setAttribute("y", "7");
		head.setAttribute("width", "14");
		head.setAttribute("height", "12");
		head.setAttribute("rx", "3");
		const eyes = document.createElementNS("http://www.w3.org/2000/svg", "path");
		eyes.setAttribute("d", "M9 12h.01M15 12h.01M9 16h6");
		icon.append(antenna, head, eyes);
		return icon;
	}

	function createTrigger(labelText: string): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("data-ao-open-with-ao", "trigger");
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		setTriggerLabel(button, labelText);
		const label = document.createElement("span");
		label.textContent = labelText;
		button.append(createIcon(), label);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			if (menu.isOpen()) menu.close({ restoreFocus: false });
			else menu.open(button, { viaKeyboard: event.detail === 0 });
		});
		button.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			menu.open(button, { viaKeyboard: true });
		});
		return button;
	}

	function removeFallback(): void {
		fallbackHost?.remove();
		fallbackHost = null;
		if (!headerTriggerWasPlaced) trigger = null;
	}

	function removeCurrentTrigger(): void {
		closeMenuBeforeReplacingTrigger();
		trigger?.remove();
		trigger = null;
		lastAnchorActions = null;
		headerTriggerWasPlaced = false;
		pendingRelocation = false;
	}

	function showFallback(): void {
		if (destroyed || payload.issue === null) return;
		clearFallbackTimer();
		if (!fallbackHost) {
			closeMenuBeforeReplacingTrigger();
			removeCurrentTrigger();
			const host = document.createElement("div");
			host.id = FALLBACK_ID;
			host.style.cssText = "position:fixed; right:16px; bottom:calc(var(--chat-launcher-clearance, 3.5rem) + 8px); z-index:2147483000; pointer-events:auto";
			const shadow = host.attachShadow({ mode: "open" });
			const style = document.createElement("style");
			style.textContent = buildFallbackStyles(payload.style);
			shadow.appendChild(style);
			trigger = createTrigger(payload.label);
			shadow.appendChild(trigger);
			document.documentElement.appendChild(host);
			fallbackHost = host;
		}
		state = "FALLBACK";
		syncValidityTimer();
	}

	function recordRelocation(): boolean {
		const now = Date.now();
		relocationTimes = relocationTimes.filter((time) => now - time <= RELOCATION_WINDOW);
		relocationTimes.push(now);
		return relocationTimes.length > RELOCATION_LIMIT;
	}

	function enterRelocationFallback(): void {
		clearFallbackTimer();
		clearResumeTimer();
		suppressHeaderUntil = Date.now() + RELOCATION_COOLDOWN;
		relocationTimes = [];
		showFallback();
		resumeTimer = window.setTimeout(() => {
			resumeTimer = null;
			if (destroyed || payload.issue === null) return;
			suppressHeaderUntil = 0;
			ensure();
		}, RELOCATION_COOLDOWN);
	}

	function ensure(): void {
		if (destroyed || payload.issue === null) return;
		if (Date.now() < suppressHeaderUntil) {
			showFallback();
			return;
		}

		const anchor = options.locate();
		if (anchor) {
			clearFallbackTimer();
			if (headerTriggerWasPlaced && trigger && !trigger.isConnected) {
				pendingRelocation = true;
				lastAnchorActions = null;
			}
			if (fallbackHost) {
				closeMenuBeforeReplacingTrigger();
				removeFallback();
				trigger = null;
			}
			if (pendingRelocation && recordRelocation()) {
				enterRelocationFallback();
				return;
			}
			if (!trigger) {
				ensureStyle();
				trigger = createTrigger(payload.label);
			} else setTriggerLabel(trigger, payload.label);
			const alreadyPlaced =
				trigger.parentElement === anchor.actions && trigger.nextSibling === anchor.insertBefore;
			if (!alreadyPlaced) anchor.actions.insertBefore(trigger, anchor.insertBefore);
			lastAnchorActions = anchor.actions;
			headerTriggerWasPlaced = true;
			pendingRelocation = false;
			state = "ANCHORED";
			syncValidityTimer();
			return;
		}

		if (headerTriggerWasPlaced && trigger && !trigger.isConnected) {
			closeMenuBeforeReplacingTrigger();
			pendingRelocation = true;
			trigger = null;
			lastAnchorActions = null;
		}
		if (fallbackHost) state = "FALLBACK";
		else if (!headerTriggerWasPlaced) state = "WAIT";
		if (!fallbackHost && state !== "FALLBACK" && fallbackTimer === null) {
			fallbackTimer = window.setTimeout(() => {
				fallbackTimer = null;
				if (destroyed || payload.issue === null) return;
				if (options.locate() === null) showFallback();
				else ensure();
			}, FALLBACK_DELAY);
		}
		syncValidityTimer();
	}

	function validateAnchor(): void {
		if (destroyed || payload.issue === null) return;
		const anchor = options.locate();
		if (
			state === "ANCHORED" &&
			anchor !== null &&
			anchor.actions === lastAnchorActions &&
			trigger?.isConnected &&
			trigger.parentElement === lastAnchorActions &&
			trigger.nextSibling === anchor.insertBefore
		) {
			return;
		}
		ensure();
	}

	function startObserver(): void {
		if (observer || !document.body || destroyed || payload.issue === null) return;
		observer = new MutationObserver(() => {
			if (debounceTimer !== null) return;
			debounceTimer = window.setTimeout(() => {
				debounceTimer = null;
				validateAnchor();
			}, MUTATION_DEBOUNCE);
		});
		observer.observe(document.body, { childList: true, subtree: true });
		syncValidityTimer();
	}

	function update(nextPayload: OpenWithAoPagePayload): void {
		if (destroyed) return;
		payload = nextPayload;
		menu.update(payload);
		refreshStyles();
		if (payload.issue === null) {
			removeCurrentTrigger();
			removeFallback();
			menu.close({ restoreFocus: false });
			disconnectObserver();
			clearTimers();
			suppressHeaderUntil = 0;
			relocationTimes = [];
			removeStyle();
			state = "NO_ISSUE";
			return;
		}
		if (trigger) setTriggerLabel(trigger, payload.label);
		if (state === "NO_ISSUE") state = "WAIT";
		ensure();
		startObserver();
	}

	function destroy(): void {
		if (destroyed) return;
		destroyed = true;
		closeMenuBeforeReplacingTrigger();
		menu.close({ restoreFocus: false });
		menu.destroy();
		removeCurrentTrigger();
		removeFallback();
		removeStyle();
		disconnectObserver();
		clearTimers();
		state = "NO_ISSUE";
	}

	const controller: OpenWithAoController = {
		version: options.version,
		update,
		destroy,
		getState: () => state,
	};

	if (payload.issue === null) {
		state = "NO_ISSUE";
	} else {
		state = "WAIT";
		ensure();
		startObserver();
	}
	return controller;
}

export function buildOpenWithAoScript(payload: OpenWithAoPagePayload): string {
	const functions = `${locateOpenWithAoAnchor.toString()}${createOpenWithAoMenu.toString()}${createOpenWithAoController.toString()}`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < functions.length; index += 1) {
		hash ^= functions.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const version = hash.toString(16).padStart(8, "0");
	const escapedPayload = escapeScriptJson(payload);
	return `(function () {
	const locateOpenWithAoAnchor = ${locateOpenWithAoAnchor.toString()};
	const createOpenWithAoMenu = ${createOpenWithAoMenu.toString()};
	const createOpenWithAoController = ${createOpenWithAoController.toString()};
	const payload = ${escapedPayload};
	const version = "${version}";
	const existing = window.__aoOpenWithAo;
	if (existing && existing.version === version) {
		existing.update(payload);
		return;
	}
	if (existing) existing.destroy();
	window.__aoOpenWithAo = createOpenWithAoController({ payload, version, locate: locateOpenWithAoAnchor, createMenu: createOpenWithAoMenu });
})();`;
}

export function buildOpenWithAoRemoveScript(): string {
	return `(function () {
	const c = window.__aoOpenWithAo;
	if (c) { c.destroy(); delete window.__aoOpenWithAo; }
})();`;
}
