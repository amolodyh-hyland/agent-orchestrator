import type {
	OpenWithAoPagePayload,
	OpenWithAoPageProject,
	OpenWithAoPageSession,
} from "../shared/multica-open-with-ao";

export type OpenWithAoMenuOptions = {
	payload: OpenWithAoPagePayload;
	onAction: (url: string) => void;
	isTrustedEvent?: (event: Event) => boolean;
	getWorkspaceSlug?: () => string | null;
};

export type OpenWithAoMenu = {
	open: (trigger: HTMLElement, options?: { viaKeyboard?: boolean }) => void;
	close: (options?: { restoreFocus?: boolean }) => void;
	update: (payload: OpenWithAoPagePayload) => void;
	openSubmenu: (rowKey: string) => void;
	closeSubmenus: (fromLevel: number) => void;
	isOpen: () => boolean;
	destroy: () => void;
};

export function createOpenWithAoMenu(options: OpenWithAoMenuOptions): OpenWithAoMenu {
	type Entry = {
		display: "item" | "label" | "separator";
		key: string;
		kind: "project" | "orchestrator" | "task" | "action" | "submenu" | "info";
		label: string;
		projectId?: string;
		sessionId?: string;
		children?: Entry[];
		tone?: string;
		stateLabel?: string;
		detail?: string;
		linked?: boolean;
		stale?: boolean;
		terminated?: boolean;
		disabled?: boolean;
		footer?: boolean;
	};
	type PanelRecord = {
		level: number;
		key: string | null;
		rows: Entry[];
		element: HTMLDivElement;
		anchor: HTMLElement;
		opener: HTMLElement | null;
		side: "left" | "right" | null;
		scrollHandler: EventListener;
	};

	const MENU_ID = "ao-open-with-ao-menu";
	const OPEN_DELAY = 100;
	const CLOSE_GRACE = 150;
	const styles = `
:host { all: initial; }
.panel {
	position: fixed;
	pointer-events: auto;
	box-sizing: border-box;
	min-width: 14rem;
	max-width: 22rem;
	padding: 4px;
	background: var(--surface-raised, #fff);
	color: var(--popover-foreground, #111827);
	border-radius: var(--radius, 0.5rem);
	box-shadow: 0 0 0 1px var(--surface-border, rgba(0,0,0,.1)), var(--menu-shadow, 0 8px 24px rgba(15,23,42,.08));
	font: var(--text-body, 14px)/1.4 var(--font-sans, system-ui, sans-serif);
	overflow-y: auto;
	overflow-x: hidden;
	overscroll-behavior: contain;
	outline: none;
}
.panel:focus { outline: none; }
.footer {
	position: sticky;
	bottom: -4px;
	margin: 0 -4px -4px;
	padding: 0 4px 4px;
	background: var(--surface-raised, #fff);
	border-radius: 0 0 var(--radius, 0.5rem) var(--radius, 0.5rem);
}
.item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 6px;
	border-radius: 6px;
	cursor: default;
	user-select: none;
	outline: none;
}
.item:hover, .item[data-highlighted="true"], .item:focus {
	background: var(--accent, #f4f4f5);
	color: var(--accent-foreground, #18181b);
}
.panel[data-nav="keyboard"] .item:focus-visible { box-shadow: inset 0 0 0 2px var(--ring, #a1a1aa); }
.item[aria-disabled="true"] { opacity: .5; }
.item[aria-disabled="true"]:hover, .item[aria-disabled="true"][data-highlighted="true"], .item[aria-disabled="true"]:focus {
	background: transparent;
	color: inherit;
}
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-size: var(--text-caption, 12px); color: var(--muted-foreground, #6b7280); white-space: nowrap; }
.label { padding: 4px 6px; font-size: var(--text-caption, 12px); font-weight: 500; color: var(--muted-foreground, #6b7280); }
.sep { height: 1px; margin: 4px -4px; background: var(--border, rgba(0,0,0,.08)); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.dot { display: inline-block; width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; }
.dot[data-tone="ready"] { background: #16a34a; }
.dot[data-tone="attention"] { background: #dc2626; }
.dot[data-tone="pending"] { background: #d97706; }
.dot[data-tone="working"] { background: #2563eb; }
.dot[data-tone="done"] { background: #6b7280; }
.dot[data-tone="unknown"] { background: #9ca3af; }
.item[data-stale="true"], .item[data-terminated="true"] { opacity: .6; }
.icon { width: 14px; height: 14px; flex: 0 0 14px; }
@media (prefers-reduced-motion: no-preference) {
	.panel { animation: ao-menu-fade-in 100ms ease-out; }
	@keyframes ao-menu-fade-in { from { opacity: 0; } to { opacity: 1; } }
}
`;

	let payload = options.payload;
	const onAction = options.onAction;
	const isTrustedEvent = options.isTrustedEvent ?? ((event: Event) => event.isTrusted === true);
	let host: HTMLDivElement | null = null;
	let shadow: ShadowRoot | null = null;
	let trigger: HTMLElement | null = null;
	let panels: PanelRecord[] = [];
	let navMode: "pointer" | "keyboard" = "pointer";
	let destroyed = false;
	const timers = new Map<string, number>();
	const expectedScroll = new Map<HTMLElement, number>();

	function separator(key: string, footer = false): Entry {
		return { display: "separator", key, kind: "info", label: "", ...(footer ? { footer: true } : {}) };
	}

	function labelEntry(key: string, label: string): Entry {
		return { display: "label", key, kind: "info", label };
	}

	function infoEntry(key: string, label: string): Entry {
		return { display: "item", key, kind: "info", label, disabled: true };
	}

	function projectContent(project: OpenWithAoPageProject, currentPayload: OpenWithAoPagePayload): Entry[] {
		const rows: Entry[] = [];
		if (project.orchestrator) {
			rows.push(sessionEntry(project, project.orchestrator, "orchestrator", "Orchestrator"));
		} else {
			rows.push(infoEntry("orchestrator:none", "No orchestrator running"));
		}
		rows.push(separator("separator:tasks"));
		if (project.sessions.length > 0) {
			rows.push(labelEntry("label:tasks", "Tasks"));
			for (const session of project.sessions) rows.push(sessionEntry(project, session, "task", session.label));
		} else {
			rows.push(infoEntry("tasks:none", "No tasks in this project yet."));
		}
		if (project.moreCount > 0) rows.push(infoEntry("tasks:more", `+${project.moreCount} more in AO`));
		if (currentPayload.issue !== null) {
			rows.push(separator("separator:actions", true));
			rows.push({
				display: "item",
				key: `new-task:${project.id}`,
				kind: "action",
				label: "New task from this ticket",
				projectId: project.id,
				footer: true,
			});
		}
		return rows;
	}

	function sessionEntry(
		project: OpenWithAoPageProject,
		session: OpenWithAoPageSession,
		kind: "orchestrator" | "task",
		label: string,
	): Entry {
		return {
			display: "item",
			key: `${kind}:${session.id}`,
			kind,
			label,
			projectId: project.id,
			sessionId: session.id,
			tone: session.tone,
			stateLabel: session.stateLabel,
			detail: session.detail,
			linked: session.linked,
			stale: session.stale,
			terminated: session.terminated,
		};
	}

	function projectRow(project: OpenWithAoPageProject, currentPayload: OpenWithAoPagePayload): Entry {
		return {
			display: "item",
			key: `project:${project.id}`,
			kind: "project",
			label: project.name,
			projectId: project.id,
			linked: project.linked,
			children: projectContent(project, currentPayload),
		};
	}

	function buildModel(currentPayload: OpenWithAoPagePayload): Entry[] {
		if (currentPayload.daemon !== "ready") {
			let message = "AO is offline. Start AO and try again.";
			if (currentPayload.daemon === "unknown") message = "AO is not connected.";
			else if (currentPayload.daemon === "starting") message = "AO is starting…";
			return [infoEntry(`daemon:${currentPayload.daemon}`, message)];
		}
		if (currentPayload.projects.length === 0) return [infoEntry("projects:none", "No AO projects yet.")];

		const deduced = currentPayload.projects.find((project) => project.id === currentPayload.deducedProjectId);
		if (deduced) {
			return [
				...projectContent(deduced, currentPayload),
				separator("separator:all-projects", true),
				{
					display: "item",
					key: "all-projects",
					kind: "submenu",
					label: "All projects",
					children: currentPayload.projects.map((project) => projectRow(project, currentPayload)),
					footer: true,
				},
			];
		}
		return currentPayload.projects.map((project) => projectRow(project, currentPayload));
	}

	function makeSvg(className: string, pathData: string): SVGSVGElement {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", `icon ${className}`);
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "14");
		svg.setAttribute("height", "14");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", pathData);
		svg.appendChild(path);
		return svg;
	}

	function makeRow(entry: Entry): HTMLElement {
		if (entry.display === "separator") {
			const separatorElement = document.createElement("div");
			separatorElement.className = "sep";
			separatorElement.setAttribute("role", "separator");
			return separatorElement;
		}
		if (entry.display === "label") {
			const labelElement = document.createElement("div");
			labelElement.className = "label";
			labelElement.setAttribute("role", "presentation");
			labelElement.textContent = entry.label;
			return labelElement;
		}

		const row = document.createElement("div");
		row.className = "item";
		row.setAttribute("role", "menuitem");
		row.setAttribute("tabindex", "-1");
		row.setAttribute("data-key", entry.key);
		row.setAttribute("data-kind", entry.kind);
		row.setAttribute("title", fullText(entry));
		if (entry.disabled) row.setAttribute("aria-disabled", "true");
		if (entry.children) {
			row.setAttribute("aria-haspopup", "menu");
			row.setAttribute("aria-expanded", "false");
		}
		if (entry.tone) row.setAttribute("data-tone", entry.tone);
		if (entry.linked) row.setAttribute("data-linked", "true");
		if (entry.stale) row.setAttribute("data-stale", "true");
		if (entry.terminated) row.setAttribute("data-terminated", "true");

		if (entry.tone) {
			const dot = document.createElement("span");
			dot.className = "dot";
			dot.setAttribute("aria-hidden", "true");
			dot.setAttribute("data-tone", entry.tone);
			row.appendChild(dot);
		}
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = entry.label;
		row.appendChild(name);
		if (entry.stateLabel) {
			const state = document.createElement("span");
			state.className = "state";
			state.textContent = entry.stateLabel;
			row.appendChild(state);
		}
		if (entry.linked) {
			row.appendChild(makeSvg("link", "M10 13a5 5 0 0 0 7.07 0l1.42-1.42a5 5 0 0 0-7.07-7.07L10.6 5.3 M14 11a5 5 0 0 0-7.07 0l-1.42 1.42a5 5 0 0 0 7.07 7.07L13.4 18.7"));
			const screenReaderText = document.createElement("span");
			screenReaderText.className = "sr";
			screenReaderText.textContent = "Linked";
			row.appendChild(screenReaderText);
		}
		if (entry.children) row.appendChild(makeSvg("chev", "m9 18 6-6-6-6"));

		row.addEventListener("click", (event) => {
			event.preventDefault();
			activate(entry, { viaKeyboard: false, event });
		});
		row.addEventListener("pointerenter", () => onRowPointerEnter(row, entry));
		row.addEventListener("pointerleave", () => onRowPointerLeave(row));
		return row;
	}

	function activate(entry: Entry, activationOptions: { viaKeyboard: boolean; event: Event }): void {
		if (entry.disabled) return;
		if (entry.children) {
			openSubmenu(entry.key);
			if (activationOptions.viaKeyboard) {
				const panel = panels.find((candidate) => candidate.key === entry.key);
				const row = firstEnabledRow(panel);
				row?.focus({ preventScroll: true });
				if (row) revealRow(row);
			}
			return;
		}
		if ((entry.kind === "orchestrator" || entry.kind === "task") && entry.projectId && entry.sessionId) {
			if (!isTrustedEvent(activationOptions.event)) return;
			let workspaceQuery = "";
			try {
				const slug = options.getWorkspaceSlug?.();
				if (typeof slug === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug)) {
					workspaceQuery = `&w=${encodeURIComponent(slug)}`;
				}
			} catch {
				workspaceQuery = "";
			}
			const url = `ao://multica/open-with-ao/open/${encodeURIComponent(entry.projectId)}/${encodeURIComponent(entry.sessionId)}?n=${payload.nonce}${workspaceQuery}`;
			try {
				onAction(url);
			} finally {
				close({ restoreFocus: true });
			}
			return;
		}
		if (entry.kind === "action" && entry.projectId) {
			if (!isTrustedEvent(activationOptions.event)) return;
			const url = `ao://multica/open-with-ao/new-task/${encodeURIComponent(entry.projectId)}?n=${payload.nonce}`;
			try {
				onAction(url);
			} finally {
				close({ restoreFocus: true });
			}
		}
	}

	function timerKey(kind: "open" | "close", level: number): string {
		return `${kind}:${level}`;
	}

	function clearTimer(key: string): void {
		const timer = timers.get(key);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		timers.delete(key);
	}

	function clearTimers(predicate?: (key: string) => boolean): void {
		for (const key of Array.from(timers.keys())) {
			if (!predicate || predicate(key)) clearTimer(key);
		}
	}

	function setTimer(key: string, delay: number, callback: () => void): void {
		clearTimer(key);
		const timer = window.setTimeout(() => {
			timers.delete(key);
			if (host && !destroyed) callback();
		}, delay);
		timers.set(key, timer);
	}

	function rowPanel(row: HTMLElement): PanelRecord | undefined {
		const element = row.closest<HTMLElement>(".panel");
		return panels.find((panel) => panel.element === element);
	}

	function revealRow(row: HTMLElement): void {
		const panel = rowPanel(row)?.element;
		if (!panel || row.closest(".footer")) return;
		const previousScrollTop = panel.scrollTop;
		const panelRect = panel.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const padding = 4;
		const footer = panel.querySelector<HTMLElement>(".footer");
		const footerRect = footer?.getBoundingClientRect();
		const visibleBottom = footerRect && footerRect.height > 0
			? Math.min(panelRect.bottom - padding, footerRect.top)
			: panelRect.bottom - padding;
		if (rowRect.top < panelRect.top + padding) {
			panel.scrollTop = Math.max(0, panel.scrollTop - (panelRect.top + padding - rowRect.top));
		} else if (rowRect.bottom > visibleBottom) {
			panel.scrollTop += rowRect.bottom - visibleBottom;
		}
		if (panel.scrollTop !== previousScrollTop) expectedScroll.set(panel, panel.scrollTop);
	}

	function setHighlighted(panel: PanelRecord, row: HTMLElement): void {
		for (const candidate of Array.from(panel.element.querySelectorAll<HTMLElement>(".item[data-key]"))) {
			if (candidate === row) candidate.setAttribute("data-highlighted", "true");
			else candidate.removeAttribute("data-highlighted");
		}
	}

	function onRowPointerEnter(row: HTMLElement, entry: Entry): void {
		const panel = rowPanel(row);
		if (!panel) return;
		const level = panel.level;
		if (entry.disabled || entry.kind === "info") {
			clearTimer(timerKey("open", level));
			if (panels.some((candidate) => candidate.level > level)) {
				const closeLevel = level + 1;
				setTimer(timerKey("close", closeLevel), CLOSE_GRACE, () => closeSubmenus(closeLevel));
			}
			return;
		}
		setHighlighted(panel, row);
		row.focus({ preventScroll: true });
		if (entry.children) {
			clearTimer(timerKey("close", level + 1));
			clearTimer(timerKey("open", level));
			if (!panels.some((candidate) => candidate.key === entry.key)) {
				setTimer(timerKey("open", level), OPEN_DELAY, () => openSubmenu(entry.key));
			}
		} else {
			clearTimer(timerKey("open", level));
			if (panels.some((candidate) => candidate.level > level)) {
				const closeLevel = level + 1;
				setTimer(timerKey("close", closeLevel), CLOSE_GRACE, () => closeSubmenus(closeLevel));
			}
		}
	}

	function onRowPointerLeave(row: HTMLElement): void {
		const panel = rowPanel(row);
		if (!panel) return;
		clearTimer(timerKey("open", panel.level));
		if (!panels.some((candidate) => candidate.level > panel.level)) return;
		const closeLevel = panel.level + 1;
		setTimer(timerKey("close", closeLevel), CLOSE_GRACE, () => closeSubmenus(closeLevel));
	}

	function onPanelPointerEnter(level: number): void {
		setNavMode("pointer");
		clearTimers((key) => {
			const separatorIndex = key.indexOf(":");
			const kind = key.slice(0, separatorIndex);
			const timerLevel = Number(key.slice(separatorIndex + 1));
			if (kind === "open") return timerLevel < level;
			return kind === "close" && timerLevel >= level;
		});
	}

	function setNavMode(mode: "pointer" | "keyboard"): void {
		if (navMode === mode) return;
		navMode = mode;
		for (const panel of panels) panel.element.setAttribute("data-nav", mode);
	}

	function fullText(entry: Entry): string {
		if (!entry.stateLabel) return entry.label;
		const pieces = [entry.label, entry.stateLabel];
		if (entry.detail) pieces.push(entry.detail);
		return pieces.join("\n");
	}

	function findItemElement(panelRecord: PanelRecord, key: string): HTMLElement | null {
		for (const element of Array.from(panelRecord.element.querySelectorAll<HTMLElement>(".item[data-key]"))) {
			if (element.getAttribute("data-key") === key) return element;
		}
		return null;
	}

	function findSubmenuRow(key: string): { parent: PanelRecord; entry: Entry; row: HTMLElement } | null {
		for (let index = panels.length - 1; index >= 0; index -= 1) {
			const parent = panels[index];
			if (!parent) continue;
			const entry = parent.rows.find((candidate) => candidate.key === key && candidate.children !== undefined);
			if (!entry) continue;
			const row = findItemElement(parent, key);
			if (row) return { parent, entry, row };
		}
		return null;
	}

	function appendPanel(
		rows: Entry[],
		level: number,
		ariaLabel: string,
		anchor: HTMLElement,
		key: string | null,
		opener: HTMLElement | null,
	): PanelRecord | null {
		if (!shadow) return null;
		const panel = document.createElement("div");
		panel.className = "panel";
		panel.setAttribute("role", "menu");
		panel.setAttribute("tabindex", "-1");
		panel.setAttribute("data-level", String(level));
		panel.setAttribute("aria-label", ariaLabel);
		panel.setAttribute("data-nav", navMode);
		panel.id = `ao-menu-${level}`;
		panel.style.visibility = "hidden";
		const record: PanelRecord = {
			level,
			key,
			rows,
			element: panel,
			anchor,
			opener,
			side: null,
			scrollHandler: () => onPanelScroll(record),
		};
		panel.addEventListener("pointerenter", () => onPanelPointerEnter(level));
		panel.addEventListener("pointermove", () => setNavMode("pointer"));
		panel.addEventListener("scroll", record.scrollHandler, { passive: true });
		for (const entry of rows) {
			if (!entry.footer) panel.appendChild(makeRow(entry));
		}
		const footerRows = rows.filter((entry) => entry.footer);
		if (footerRows.length > 0) {
			const footer = document.createElement("div");
			footer.className = "footer";
			for (const entry of footerRows) footer.appendChild(makeRow(entry));
			panel.appendChild(footer);
		}
		shadow.appendChild(panel);
		panels.push(record);
		place(record);
		panel.style.visibility = "visible";
		return record;
	}

	function place(record: PanelRecord): void {
		const rect = record.anchor.getBoundingClientRect();
		const margin = 8;
		let left: number;
		let top: number;
		if (record.level === 0) {
			record.element.style.maxHeight = "";
			const panelRect = record.element.getBoundingClientRect();
			const panelWidth = panelRect.width;
			const naturalHeight = panelRect.height || record.element.scrollHeight;
			const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 4 - margin);
			const spaceAbove = Math.max(0, rect.top - 4 - margin);
			left = rect.left + panelWidth > window.innerWidth - margin ? rect.right - panelWidth : rect.left;
			if (naturalHeight <= spaceBelow) {
				top = rect.bottom + 4;
				record.element.style.maxHeight = `${spaceBelow}px`;
				record.element.setAttribute("data-placement", "below");
			} else if (spaceAbove > spaceBelow) {
				const used = Math.min(naturalHeight, spaceAbove);
				top = rect.top - 4 - used;
				record.element.style.maxHeight = `${spaceAbove}px`;
				record.element.setAttribute("data-placement", "above");
			} else {
				top = rect.bottom + 4;
				record.element.style.maxHeight = `${spaceBelow}px`;
				record.element.setAttribute("data-placement", "below");
			}
			top = Math.max(margin, top);
		} else {
			const panelRect = record.element.getBoundingClientRect();
			const panelWidth = panelRect.width;
			if (record.level === 1) {
				record.side = "right";
				left = rect.right;
				if (left + panelWidth > window.innerWidth - margin) {
					left = rect.left - panelWidth;
					record.side = "left";
				}
			} else {
				const parent = panels.find((candidate) => candidate.level === record.level - 1);
				const preferredSide = parent?.side ?? "right";
				const candidateLeft = (side: "left" | "right"): number =>
					side === "left" ? rect.left - panelWidth : rect.right;
				const fits = (candidate: number): boolean =>
					candidate >= margin && candidate + panelWidth <= window.innerWidth - margin;
				let side = preferredSide;
				left = candidateLeft(side);
				if (!fits(left)) {
					const otherSide = side === "left" ? "right" : "left";
					const otherLeft = candidateLeft(otherSide);
					if (fits(otherLeft)) {
						side = otherSide;
						left = otherLeft;
					}
				}
				record.side = side;
			}
			const height = panelRect.height;
			top = Math.max(margin, rect.top - 4);
			record.element.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
			if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - height);
		}
		if (record.level > 0) {
			left = Math.min(left, window.innerWidth - margin - record.element.getBoundingClientRect().width);
		}
		left = Math.max(margin, left);
		record.element.style.left = `${left}px`;
		record.element.style.top = `${top}px`;
	}

	function reposition(): void {
		for (const panel of panels) place(panel);
	}

	function onResize(): void {
		reposition();
	}

	function removePanel(panel: PanelRecord): void {
		expectedScroll.delete(panel.element);
		panel.element.removeEventListener("scroll", panel.scrollHandler);
		panel.element.remove();
	}

	function closeSubmenus(fromLevel: number): void {
		if (destroyed) return;
		const firstLevel = Math.max(1, fromLevel);
		clearTimers((key) => {
			const level = Number(key.slice(key.indexOf(":") + 1));
			return level >= firstLevel;
		});
		const closing = panels.filter((panel) => panel.level >= firstLevel);
		for (const panel of closing) {
			if (panel.opener?.isConnected) panel.opener.setAttribute("aria-expanded", "false");
			removePanel(panel);
		}
		panels = panels.filter((panel) => panel.level < firstLevel);
	}

	function onPanelScroll(panel: PanelRecord): void {
		if (expectedScroll.has(panel.element)) {
			const expected = expectedScroll.get(panel.element);
			expectedScroll.delete(panel.element);
			if (expected !== undefined && Math.abs(panel.element.scrollTop - expected) < 1) return;
		}
		clearTimers((key) => {
			const level = Number(key.slice(key.indexOf(":") + 1));
			return level >= panel.level;
		});
		const closing = panels.filter((candidate) => candidate.level > panel.level);
		if (closing.length === 0) return;
		const active = shadow?.activeElement as HTMLElement | null;
		const restoreFocus = active !== null && closing.some((candidate) => candidate.element.contains(active));
		const firstClosed = closing[0];
		closeSubmenus(panel.level + 1);
		if (restoreFocus) focusOpener(firstClosed);
	}

	function openSubmenu(rowKey: string): void {
		if (destroyed || !host) return;
		const found = findSubmenuRow(rowKey);
		if (!found) return;
		clearTimer(timerKey("open", found.parent.level));
		closeSubmenus(found.parent.level + 1);
		found.row.setAttribute("aria-expanded", "true");
		appendPanel(
			found.entry.children ?? [],
			found.parent.level + 1,
			found.entry.label,
			found.row,
			found.entry.key,
			found.row,
		);
	}

	function firstEnabledRow(panel: PanelRecord | undefined): HTMLElement | null {
		if (!panel) return null;
		for (const row of Array.from(panel.element.querySelectorAll<HTMLElement>('.item[role="menuitem"]'))) {
			if (row.getAttribute("aria-disabled") !== "true") return row;
		}
		return null;
	}

	function focusedRow(panel: PanelRecord): HTMLElement | null {
		const active = shadow?.activeElement as HTMLElement | null;
		if (!active || !panel.element.contains(active) || !active.matches('.item[role="menuitem"]')) return null;
		return active;
	}

	function activePanel(): PanelRecord | undefined {
		const active = shadow?.activeElement as HTMLElement | null;
		if (active) {
			const focusedPanel = panels.find((panel) => panel.element.contains(active));
			if (focusedPanel) return focusedPanel;
		}
		return panels[panels.length - 1];
	}

	function enabledRows(panel: PanelRecord): HTMLElement[] {
		return Array.from(panel.element.querySelectorAll<HTMLElement>('.item[role="menuitem"]'))
			.filter((row) => row.getAttribute("aria-disabled") !== "true");
	}

	function focusRow(panel: PanelRecord, row: HTMLElement | undefined): void {
		if (!row) return;
		setHighlighted(panel, row);
		row.focus({ preventScroll: true });
		revealRow(row);
	}

	function focusOpener(panel: PanelRecord | undefined): void {
		const opener = panel?.opener;
		if (!opener) return;
		const parent = panels.find((candidate) => candidate.element.contains(opener));
		if (!parent) return;
		setHighlighted(parent, opener);
		opener.focus({ preventScroll: true });
		revealRow(opener);
	}

	function keyEventIsForMenu(event: KeyboardEvent): boolean {
		const path = event.composedPath();
		return Boolean(
			host &&
				(path.includes(host) ||
					(trigger !== null && path.includes(trigger)) ||
					event.target === document.body ||
					event.target === document.documentElement),
		);
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (!host || !keyEventIsForMenu(event)) return;
		const panel = activePanel();
		if (!panel) return;
		const row = focusedRow(panel);
		const rows = enabledRows(panel);
		const handle = (): void => {
			setNavMode("keyboard");
			clearTimers();
			event.preventDefault();
			event.stopPropagation();
		};
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			handle();
			if (rows.length === 0) return;
			const currentIndex = row ? rows.indexOf(row) : -1;
			let nextIndex: number;
			if (currentIndex < 0) nextIndex = event.key === "ArrowDown" ? 0 : rows.length - 1;
			else nextIndex = (currentIndex + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
			focusRow(panel, rows[nextIndex]);
			return;
		}
		if (event.key === "Home" || event.key === "End") {
			handle();
			focusRow(panel, event.key === "Home" ? rows[0] : rows[rows.length - 1]);
			return;
		}
		if (event.key === "ArrowRight" && row) {
			const key = row.getAttribute("data-key");
			const entry = panel.rows.find((candidate) => candidate.key === key);
			if (entry?.children) {
				handle();
				activate(entry, { viaKeyboard: true, event });
			}
			return;
		}
		if (event.key === "ArrowLeft" && panel.level >= 1) {
			handle();
			const closingPanel = panel;
			closeSubmenus(panel.level);
			focusOpener(closingPanel);
			return;
		}
		if (event.key === "Escape") {
			handle();
			const deepest = panels[panels.length - 1];
			if (deepest && deepest.level >= 1) {
				closeSubmenus(deepest.level);
				focusOpener(deepest);
			} else {
				close({ restoreFocus: true });
			}
			return;
		}
		if ((event.key === "Enter" || event.key === " ") && row) {
			handle();
			const key = row.getAttribute("data-key");
			const entry = panel.rows.find((candidate) => candidate.key === key);
			if (entry) activate(entry, { viaKeyboard: true, event });
			return;
		}
		if (event.key === "Tab") {
			close({ restoreFocus: false });
		}
	}

	function onPointerDown(event: PointerEvent): void {
		if (!host) return;
		const path = event.composedPath();
		if (!path.includes(host) && !path.includes(trigger as HTMLElement)) close({ restoreFocus: false });
	}

	function onFocusIn(event: FocusEvent): void {
		if (!host) return;
		const path = event.composedPath();
		if (!path.includes(host) && (trigger === null || !path.includes(trigger))) close({ restoreFocus: false });
	}

	function onWindowScroll(event: Event): void {
		if (!host || event.composedPath().includes(host)) return;
		close({ restoreFocus: false });
	}

	function open(openTrigger: HTMLElement, openOptions?: { viaKeyboard?: boolean }): void {
		if (destroyed || host) return;
		trigger = openTrigger;
		navMode = openOptions?.viaKeyboard ? "keyboard" : "pointer";
		host = document.createElement("div");
		host.id = MENU_ID;
		host.style.position = "fixed";
		host.style.top = "0";
		host.style.left = "0";
		host.style.width = "0";
		host.style.height = "0";
		host.style.zIndex = "2147483000";
		host.style.pointerEvents = "none";
		shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = styles;
		shadow.appendChild(style);
		document.body.appendChild(host);
		trigger.setAttribute("aria-expanded", "true");
		const root = appendPanel(buildModel(payload), 0, "Open with AO", trigger, null, null);
		window.addEventListener("resize", onResize);
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("focusin", onFocusIn, true);
		window.addEventListener("scroll", onWindowScroll, true);
		if (openOptions?.viaKeyboard) {
			const row = firstEnabledRow(root ?? undefined);
			row?.focus({ preventScroll: true });
			if (row) revealRow(row);
		} else root?.element.focus({ preventScroll: true });
	}

	function close(closeOptions?: { restoreFocus?: boolean }): void {
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("focusin", onFocusIn, true);
		window.removeEventListener("scroll", onWindowScroll, true);
		window.removeEventListener("resize", onResize);
		clearTimers();
		if (host) {
			host.remove();
		}
		for (const panel of panels) removePanel(panel);
		if (trigger) {
			trigger.setAttribute("aria-expanded", "false");
		}
		const previousTrigger = trigger;
		host = null;
		shadow = null;
		trigger = null;
		panels = [];
		if (closeOptions?.restoreFocus) previousTrigger?.focus();
	}

	function update(nextPayload: OpenWithAoPagePayload): void {
		if (destroyed) return;
		payload = nextPayload;
		if (!host || !trigger || !shadow) return;
		const focusedElement = shadow.activeElement as HTMLElement | null;
		const focusedKey = focusedElement?.getAttribute("data-key") ?? null;
		const focusWasInMenu = focusedElement !== null && panels.some((panel) => panel.element.contains(focusedElement));
		const highlightedKeys = Array.from(shadow.querySelectorAll<HTMLElement>('.item[data-highlighted="true"]'))
			.map((row) => row.getAttribute("data-key"))
			.filter((key): key is string => key !== null);
		const rootPanelHadFocus = focusedElement?.classList.contains("panel") && focusedElement.getAttribute("data-level") === "0";
		const chain = panels.slice(1).map((panel) => panel.key).filter((key): key is string => key !== null);
		clearTimers();
		for (const panel of panels) removePanel(panel);
		panels = [];
		const root = appendPanel(buildModel(payload), 0, "Open with AO", trigger, null, null);
		for (const key of chain) {
			const found = findSubmenuRow(key);
			if (!found) break;
			openSubmenu(key);
		}
		let focusRestored = false;
		if (focusedKey) {
			for (const panel of panels) {
				const row = findItemElement(panel, focusedKey);
				if (row) {
					row.focus({ preventScroll: true });
					revealRow(row);
					focusRestored = true;
					break;
				}
			}
		}
		for (const highlightedKey of highlightedKeys) {
			for (const panel of panels) {
				const row = findItemElement(panel, highlightedKey);
				if (row) {
					setHighlighted(panel, row);
					break;
				}
			}
		}
		if (rootPanelHadFocus) {
			root?.element.focus({ preventScroll: true });
			focusRestored = true;
		}
		if (focusWasInMenu && !focusRestored && root) {
			const deepest = panels[panels.length - 1];
			const opener = deepest && deepest.level > 0 ? deepest.opener : null;
			const openerPanel = opener ? rowPanel(opener) : undefined;
			if (opener && openerPanel) {
				focusRow(openerPanel, opener);
			} else {
				const first = firstEnabledRow(root);
				if (first) focusRow(root, first);
				else root.element.focus({ preventScroll: true });
			}
		}
		if (!root) panels = [];
	}

	function destroy(): void {
		if (destroyed) return;
		close();
		destroyed = true;
	}

	return { open, close, update, openSubmenu, closeSubmenus, isOpen: () => host !== null, destroy };
}
