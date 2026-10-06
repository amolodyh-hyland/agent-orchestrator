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
	const FALLBACK_DELAY = 1500;
	const MUTATION_DEBOUNCE = 32;
	const VALIDITY_INTERVAL = 2000;
	const RELOCATION_WINDOW = 1000;
	const RELOCATION_LIMIT = 5;
	const RELOCATION_COOLDOWN = 5000;
	const FALLBACK_STYLES = `
:host { all: initial; }
button {
	appearance: none;
	background: var(--surface-raised, #fff);
	color: var(--foreground, #111827);
	border: 1px solid var(--surface-border, rgba(0,0,0,.12));
	border-radius: 999px;
	box-shadow: var(--menu-shadow, 0 2px 10px rgba(0,0,0,.18));
	padding: 6px 12px;
	font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 6px;
}
button:hover { background: var(--accent, #f4f4f5); }
button:focus-visible { outline: 2px solid var(--ring, #a1a1aa); outline-offset: 2px; }
svg { width: 16px; height: 16px; flex: 0 0 16px; }
span { white-space: nowrap; }
`;

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
		const shouldRun =
			observer !== null &&
			!destroyed &&
			payload.issue !== null &&
			(state === "ANCHORED" || state === "FALLBACK");
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
		icon.setAttribute("width", "16");
		icon.setAttribute("height", "16");
		icon.setAttribute("fill", "none");
		icon.setAttribute("stroke", "currentColor");
		icon.setAttribute("stroke-width", "1.8");
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

	function createTrigger(className?: string): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("data-ao-open-with-ao", "trigger");
		button.setAttribute("aria-label", "Open with AO");
		button.setAttribute("title", "Open with AO");
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		if (className !== undefined) {
			button.className = className;
			button.style.cssText = "width:auto; padding:0 8px; gap:6px; height:var(--button-height-sm, 28px)";
		} else {
			button.style.cssText = "font-size:12px; line-height:1.2";
		}
		const label = document.createElement("span");
		label.textContent = "Open with AO";
		if (className !== undefined) {
			label.style.cssText = "font-size:var(--text-caption,12px); font-weight:500; white-space:nowrap";
		} else {
			label.style.cssText = "white-space:nowrap";
		}
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
		if (destroyed || payload.issue === null || fallbackHost) return;
		clearFallbackTimer();
		closeMenuBeforeReplacingTrigger();
		removeCurrentTrigger();
		const host = document.createElement("div");
		host.id = FALLBACK_ID;
		host.style.cssText = "position:fixed; right:16px; bottom:calc(var(--chat-launcher-clearance, 3.5rem) + 8px); z-index:2147483000; pointer-events:auto";
		const shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = FALLBACK_STYLES;
		shadow.appendChild(style);
		trigger = createTrigger();
		shadow.appendChild(trigger);
		document.documentElement.appendChild(host);
		fallbackHost = host;
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
			if (!trigger) trigger = createTrigger(anchor.menuTrigger.className);
			else {
				trigger.className = anchor.menuTrigger.className;
				trigger.style.cssText = "width:auto; padding:0 8px; gap:6px; height:var(--button-height-sm, 28px)";
			}
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
		if (state !== "FALLBACK" && fallbackTimer === null) {
			fallbackTimer = window.setTimeout(() => {
				fallbackTimer = null;
				if (destroyed || payload.issue === null) return;
				if (options.locate() === null) showFallback();
				else ensure();
			}, FALLBACK_DELAY);
		}
		if (!headerTriggerWasPlaced) state = "WAIT";
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
		if (payload.issue === null) {
			removeCurrentTrigger();
			removeFallback();
			menu.close({ restoreFocus: false });
			disconnectObserver();
			clearTimers();
			suppressHeaderUntil = 0;
			relocationTimes = [];
			state = "NO_ISSUE";
			return;
		}
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
