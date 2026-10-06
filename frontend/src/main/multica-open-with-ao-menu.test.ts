import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpenWithAoActionUrl, type OpenWithAoPagePayload, type OpenWithAoPageProject, type OpenWithAoPageSession } from "../shared/multica-open-with-ao";
import { createOpenWithAoMenu } from "./multica-open-with-ao-menu";

const MENU_ID = "ao-open-with-ao-menu";
const NONCE = "0123456789abcdef0123456789abcdef";
type MenuStyleTokens = {
	borderWidth: string;
	borderWidthHiDpi: string;
	menuFontSize: string;
	menuStateFontSize: string;
	menuLabelFontSize: string;
	menuFontWeight: string;
	menuLineHeight: string;
	menuMaxHeightPx: number;
};
const DEFAULT_MENU_STYLE: MenuStyleTokens = {
	borderWidth: "1px",
	borderWidthHiDpi: "0.5px",
	menuFontSize: "var(--text-caption, 12px)",
	menuStateFontSize: "var(--text-micro, 11px)",
	menuLabelFontSize: "var(--text-micro, 11px)",
	menuFontWeight: "400",
	menuLineHeight: "20px",
	menuMaxHeightPx: 218,
};

function session(id: string, projectId: string, overrides: Partial<OpenWithAoPageSession> = {}): OpenWithAoPageSession {
	return {
		id,
		projectId,
		label: `Session ${id}`,
		tone: "working",
		stateLabel: "Running",
		detail: "Building changes",
		stale: false,
		terminated: false,
		updatedAt: 1,
		linked: false,
		...overrides,
	};
}

function project(id: string, overrides: Partial<OpenWithAoPageProject> = {}): OpenWithAoPageProject {
	return {
		id,
		name: `Project ${id}`,
		linked: false,
		orchestrator: session(`orch-${id}`, id, { label: "Orchestrator" }),
		sessions: [session(`task-${id}`, id)],
		moreCount: 0,
		...overrides,
	};
}

function payload(overrides: Partial<OpenWithAoPagePayload> & { style?: MenuStyleTokens } = {}): OpenWithAoPagePayload {
	return {
		label: "Multica",
		nonce: NONCE,
		issue: { identifier: "APP-12", title: "Ticket" },
		daemon: "ready",
		stale: false,
		deducedProjectId: null,
		deduction: null,
		projects: [project("alpha")],
		...overrides,
		style: overrides.style ?? DEFAULT_MENU_STYLE,
	};
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
}

function mockGeometry(input?: {
	trigger?: DOMRect;
	panels?: Record<string, DOMRect>;
	rows?: Record<string, DOMRect>;
}): void {
	const triggerRect = input?.trigger ?? rect(40, 20, 150, 30);
	const panelRects = input?.panels ?? { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 100), "2": rect(0, 0, 200, 100) };
	const rowRects = input?.rows ?? {};
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.id === "menu-trigger") return triggerRect;
		if (this.classList.contains("panel")) return panelRects[this.getAttribute("data-level") ?? "0"] ?? rect(0, 0, 200, 100);
		const key = this.getAttribute("data-key");
		if (key && rowRects[key]) return rowRects[key];
		return rect(0, 0, 100, 24);
	});
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
}

function mockCappedPanelGeometry(input?: { trigger?: DOMRect; panels?: Record<string, DOMRect> }): void {
	const triggerRect = input?.trigger ?? rect(40, 20, 150, 30);
	const panelRects = input?.panels ?? { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 100) };
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.id === "menu-trigger") return triggerRect;
		if (this.classList.contains("panel")) {
			const naturalRect = panelRects[this.getAttribute("data-level") ?? "0"] ?? rect(0, 0, 200, 100);
			const maxHeight = Number.parseFloat(this.style.maxHeight);
			const height = Number.isFinite(maxHeight) ? Math.min(naturalRect.height, maxHeight) : naturalRect.height;
			const left = Number.parseFloat(this.style.left);
			const top = Number.parseFloat(this.style.top);
			return rect(
				Number.isFinite(left) ? left : naturalRect.left,
				Number.isFinite(top) ? top : naturalRect.top,
				naturalRect.width,
				height,
			);
		}
		if (this.getAttribute("data-key") === "all-projects" && this.closest(".footer")) {
			const owner = this.closest<HTMLElement>(".panel");
			const ownerRect = owner?.getBoundingClientRect() ?? rect(0, 0, 240, 0);
			return rect(ownerRect.left + 4, ownerRect.bottom - 32, 200, 28);
		}
		return rect(0, 0, 100, 24);
	});
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
}

function mockScrollableMenuGeometry(panelRect = rect(0, 100, 240, 218)): void {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.id === "menu-trigger") return rect(40, 20, 150, 30);
		if (this.classList.contains("panel")) return panelRect;
		const panelElement = this.closest<HTMLElement>(".panel");
		if (this.classList.contains("footer")) {
			const ownerRect = panelElement?.getBoundingClientRect() ?? panelRect;
			const footerRows = Array.from(this.children) as HTMLElement[];
			const footerHeight = footerRows.reduce((height, row) => height + (row.classList.contains("sep") ? 9 : 28), 4);
			return rect(ownerRect.left + 4, ownerRect.bottom - footerHeight, ownerRect.width - 8, footerHeight);
		}
		if (this.matches(".item[data-key]")) {
			const footer = this.closest<HTMLElement>(".footer");
			if (footer) {
				const footerRect = footer.getBoundingClientRect();
				const footerRows = Array.from(footer.children) as HTMLElement[];
				const index = footerRows.indexOf(this);
				const precedingHeight = footerRows.slice(0, index).reduce((height, row) => height + (row.classList.contains("sep") ? 9 : 28), 0);
				return rect(4, footerRect.top + precedingHeight, 200, 28);
			}
			const rows = Array.from(panelElement?.querySelectorAll<HTMLElement>(".item[data-key]") ?? [])
				.filter((row) => !row.closest(".footer"));
			const index = rows.indexOf(this);
			return rect(4, panelRect.top + 4 + index * 28 - (panelElement?.scrollTop ?? 0), 200, 28);
		}
		return rect(0, 0, 100, 24);
	});
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
}

function makeTrigger(): HTMLElement {
	const trigger = document.createElement("button");
	trigger.id = "menu-trigger";
	document.body.appendChild(trigger);
	return trigger;
}

function makeShadowTrigger(): { host: HTMLElement; shadow: ShadowRoot; trigger: HTMLButtonElement } {
	const host = document.createElement("div");
	host.id = "menu-trigger-shadow-host";
	const shadow = host.attachShadow({ mode: "open" });
	const trigger = document.createElement("button");
	trigger.id = "menu-trigger-shadow";
	shadow.appendChild(trigger);
	document.body.appendChild(host);
	return { host, shadow, trigger };
}

function openMenu(
	menuPayload = payload(),
	onAction = vi.fn(),
	openOptions?: { viaKeyboard?: boolean },
	trustedEvents?: (event: Event) => boolean,
	getWorkspaceSlug?: () => string | null,
) {
	const trigger = makeTrigger();
	const menu = createOpenWithAoMenu({
		payload: menuPayload,
		onAction,
		...(trustedEvents ? { isTrustedEvent: trustedEvents } : {}),
		...(getWorkspaceSlug ? { getWorkspaceSlug } : {}),
	});
	menu.open(trigger, openOptions);
	const host = document.getElementById(MENU_ID);
	const shadow = host?.shadowRoot;
	return { menu, trigger, host, shadow, onAction };
}

function allowTestActionEvents(): (event: Event) => boolean {
	return () => true;
}

function menuRows(shadow: ShadowRoot | undefined | null, level = "0"): HTMLElement[] {
	return Array.from(shadow?.querySelectorAll<HTMLElement>(`.panel[data-level="${level}"] .item`) ?? []);
}

afterEach(() => {
	document.querySelectorAll(`#${MENU_ID}, [id^="menu-trigger"], [data-test-outside]`).forEach((element) => element.remove());
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function pointer(row: EventTarget | null | undefined, type: "pointerenter" | "pointerleave"): void {
	row?.dispatchEvent(new Event(type));
}

function key(target: EventTarget | null | undefined, value: string): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: value, bubbles: true, composed: true, cancelable: true });
	target?.dispatchEvent(event);
	return event;
}

function panel(shadow: ShadowRoot | undefined | null, level: number): HTMLElement | null {
	return shadow?.querySelector<HTMLElement>(`.panel[data-level="${level}"]`) ?? null;
}

function openThreeLevelMenu() {
	mockGeometry();
	const state = openMenu(payload({ deducedProjectId: "alpha", projects: [project("alpha"), project("beta")] }));
	state.shadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
	state.shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]')?.click();
	return state;
}

describe("multica Open in AO menu", () => {
	it("renders list mode projects as submenu rows in an open shadow root", () => {
		mockGeometry();
		const menuPayload = payload({ projects: [project("alpha"), project("beta")] });
		const { menu, trigger, host, shadow } = openMenu(menuPayload);

		expect(menu.isOpen()).toBe(true);
		expect(host?.parentElement).toBe(document.body);
		expect(host?.shadowRoot?.mode).toBe("open");
		expect(shadow?.querySelectorAll("style")).toHaveLength(1);
		expect(host?.getAttribute("style")).toContain("z-index: 2147483000");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(Array.from(menuRows(shadow), (row) => [row.getAttribute("data-key"), row.textContent])).toEqual([
			["project:alpha", "Project alpha"],
			["project:beta", "Project beta"],
		]);
		expect(menuRows(shadow).every((row) => row.getAttribute("aria-haspopup") === "menu")).toBe(true);
		expect(shadow?.querySelector('.panel[role="menu"][data-level="0"]')?.getAttribute("aria-label")).toBe(menuPayload.label);
	});

	it("updates the root aria-label from the latest payload and has no hard-coded root label", () => {
		mockGeometry();
		const { menu, shadow } = openMenu(payload({ label: "Initial label" }));
		const root = panel(shadow, 0);

		expect(root?.getAttribute("aria-label")).toBe("Initial label");
		expect(createOpenWithAoMenu.toString()).not.toContain("Open in AO");

		menu.update(payload({ label: "Updated label" }));
		expect(panel(shadow, 0)?.getAttribute("aria-label")).toBe("Updated label");
	});

	it("renders deduced project content before All projects and opens its nested project panel", () => {
		mockGeometry();
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha", projects: [project("alpha"), project("beta")] }));

		expect(Array.from(menuRows(shadow), (row) => row.getAttribute("data-key"))).toEqual([
			"orchestrator:orch-alpha",
			"task:task-alpha",
			"new-task:alpha",
			"all-projects",
		]);
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		allProjects?.click();
		expect(allProjects?.getAttribute("aria-expanded")).toBe("true");
		expect(menuRows(shadow, "1").map((row) => row.getAttribute("data-key"))).toEqual(["project:alpha", "project:beta"]);
		expect(shadow?.querySelector('.panel[data-level="1"]')?.getAttribute("aria-label")).toBe("All projects");
	});

	it("groups trailing project actions in sticky footers only when a panel has them", () => {
		mockGeometry();
		const listMenu = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const listRoot = panel(listMenu.shadow, 0);
		expect(listRoot?.querySelector(".footer")).toBeNull();
		listMenu.shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		const projectFooter = panel(listMenu.shadow, 1)?.querySelector<HTMLElement>(".footer");
		expect(Array.from(projectFooter?.children ?? [], (row) => row.getAttribute("data-key") ?? row.getAttribute("role"))).toEqual([
			"separator",
			"new-task:alpha",
		]);
		listMenu.menu.close();

		const deducedMenu = openMenu(payload({ deducedProjectId: "alpha" }));
		const deducedFooter = panel(deducedMenu.shadow, 0)?.querySelector<HTMLElement>(".footer");
		expect(Array.from(deducedFooter?.children ?? [], (row) => row.getAttribute("data-key") ?? row.getAttribute("role"))).toEqual([
			"separator",
			"new-task:alpha",
			"separator",
			"all-projects",
		]);
		deducedMenu.menu.close();

		const infoMenu = openMenu(payload({ daemon: "stopped" }));
		expect(panel(infoMenu.shadow, 0)?.querySelector(".footer")).toBeNull();
	});

	it("shows focus rings only in keyboard navigation mode across all open panels", () => {
		mockGeometry();
		const { shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const root = panel(shadow, 0);
		const style = shadow?.querySelector("style")?.textContent ?? "";
		expect(style).toContain(".panel:focus { outline: none; }");
		expect(style).toContain('.panel[data-nav="keyboard"] .item:focus-visible');
		expect(style).toContain("box-shadow: inset 0 0 0 1px var(--ring, #a1a1aa);");
		expect(style).not.toContain("\n.item:focus-visible {");
		expect(root?.getAttribute("data-nav")).toBe("pointer");

		key(root, "ArrowDown");
		expect(panel(shadow, 0)?.getAttribute("data-nav")).toBe("keyboard");
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		expect(panel(shadow, 1)?.getAttribute("data-nav")).toBe("keyboard");
		panel(shadow, 1)?.dispatchEvent(new Event("pointermove", { bubbles: true }));
		expect(Array.from(shadow?.querySelectorAll<HTMLElement>(".panel") ?? []).every((entry) => entry.getAttribute("data-nav") === "pointer")).toBe(true);
	});

	it("uses compact Multica menu typography, width, and icon sizing", () => {
		mockGeometry();
		const { shadow } = openMenu();
		const style = shadow?.querySelector("style")?.textContent ?? "";
		const projectRow = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');

		expect(style).toContain("min-width: 8rem;");
		expect(style).toContain("width: max-content;");
		expect(style).toContain("border-radius: 8px;");
		expect(style).toContain("border-radius: 6px;");
		expect(style).toContain("padding: 4px 6px;");
		expect(style).toContain("var(--menu-shadow,");
		expect(style).toContain("font: 400 var(--text-caption, 12px)/20px var(--font-sans, system-ui, sans-serif)");
		expect(style).toContain("font-size: var(--text-caption, 12px);");
		expect(style).toContain("font-weight: 400;");
		expect(style).toContain("line-height: 20px;");
		expect(style).toContain(".state { font-size: var(--text-micro, 11px);");
		expect(style).toContain(".label { padding: 4px 6px; font-size: var(--text-micro, 11px); font-weight: 500;");
		expect(style).toContain(".chev { width: 14px; height: 14px; flex: 0 0 14px; }");
		expect(style).toContain(".icon { width: 12px; height: 12px; flex: 0 0 12px; }");
		expect(projectRow?.querySelector("svg.chev")?.getAttribute("width")).toBe("14");
		expect(projectRow?.querySelector("svg.chev")?.getAttribute("height")).toBe("14");
	});

	it("builds hairline and typography CSS from payload style tokens", () => {
		mockGeometry();
		const menuStyle: MenuStyleTokens = {
			borderWidth: "2px",
			borderWidthHiDpi: "1px",
			menuFontSize: "13px",
			menuStateFontSize: "12px",
			menuLabelFontSize: "11px",
			menuFontWeight: "400",
			menuLineHeight: "20px",
			menuMaxHeightPx: 150,
		};
		const { menu, shadow } = openMenu(payload({ style: menuStyle }));
		const styleElement = shadow?.querySelector("style");
		const style = styleElement?.textContent ?? "";
		const itemRule = style.match(/\.item \{([\s\S]*?)\n\}/)?.[1] ?? "";

		expect(style).toContain("box-shadow: 0 0 0 2px var(--surface-border");
		expect(style).toContain("font: 400 13px/20px var(--font-sans");
		expect(style).toContain("font-size: 13px;");
		expect(style).toContain(".state { font-size: 12px;");
		expect(style).toContain(".label { padding: 4px 6px; font-size: 11px; font-weight: 500;");
		expect(style).toContain(".sep { height: 2px; margin: 4px -4px; background: var(--border");
		expect(style).toContain("@media (min-resolution: 2dppx)");
		expect(style).toContain("box-shadow: 0 0 0 1px var(--surface-border");
		expect(style).toContain(".sep { height: 1px; }");
		expect(itemRule).not.toContain("border:");
		expect(itemRule).not.toContain("box-shadow:");
		expect(panel(shadow, 0)?.style.maxHeight).toBe("150px");

		menu.update(payload({ style: { ...menuStyle, borderWidth: "3px", menuFontSize: "14px", menuMaxHeightPx: 160 } }));
		expect(styleElement?.textContent).toContain("box-shadow: 0 0 0 3px var(--surface-border");
		expect(styleElement?.textContent).toContain("font: 400 14px/20px var(--font-sans");
		expect(panel(shadow, 0)?.style.maxHeight).toBe("160px");
	});

	it("renders project content, disabled empty states, overflow, and conditionally includes New task", () => {
		mockGeometry();
		const empty = project("empty", { orchestrator: null, sessions: [], moreCount: 3 });
		const { shadow } = openMenu(payload({ projects: [empty], issue: null }));
		shadow?.querySelector<HTMLElement>('[data-key="project:empty"]')?.click();
		const rows = menuRows(shadow, "1");

		expect(rows.map((row) => row.textContent)).toEqual([
			"No orchestrator running",
			"No tasks in this project yet.",
			"+3 more in AO",
		]);
		expect(rows.every((row) => row.getAttribute("aria-disabled") === "true")).toBe(true);
		expect(rows[0]?.getAttribute("data-key")).toBe("orchestrator:none");
		expect(shadow?.querySelector(".label")?.textContent).toBeUndefined();
		expect(shadow?.querySelector('[data-key^="new-task:"]')).toBeNull();
	});

	it.each([
		["unknown", "AO is not connected."],
		["starting", "AO is starting…"],
		["stopped", "AO is offline. Start AO and try again."],
		["error", "AO is offline. Start AO and try again."],
	] as const)("shows the daemon message for %s", (daemon, message) => {
		mockGeometry();
		const { shadow } = openMenu(payload({ daemon }));
		expect(menuRows(shadow).map((row) => row.textContent)).toEqual([message]);
		expect(menuRows(shadow)[0]?.getAttribute("aria-disabled")).toBe("true");
	});

	it("shows the empty projects message", () => {
		mockGeometry();
		const { shadow } = openMenu(payload({ projects: [] }));
		expect(menuRows(shadow).map((row) => row.textContent)).toEqual(["No AO projects yet."]);
		expect(menuRows(shadow)[0]?.getAttribute("aria-disabled")).toBe("true");
	});

	it("does not activate orchestrator, task, or new-task rows from synthetic clicks by default", () => {
		mockGeometry();
		const { menu, shadow, trigger, onAction } = openMenu(payload({ deducedProjectId: "alpha" }));

		for (const keyValue of ["orchestrator:orch-alpha", "task:task-alpha", "new-task:alpha"]) {
			shadow?.querySelector<HTMLElement>('[data-key="' + keyValue + '"]')?.click();
			expect(menu.isOpen()).toBe(true);
			expect(trigger.getAttribute("aria-expanded")).toBe("true");
		}

		expect(onAction).not.toHaveBeenCalled();
	});

	it("does not activate focused action rows from synthetic Enter or Space by default", () => {
		mockGeometry();
		const onAction = vi.fn();
		const { menu, shadow, trigger } = openMenu(payload({ deducedProjectId: "alpha" }), onAction, { viaKeyboard: true });
		const task = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]');
		task?.focus();
		key(task, "Enter");
		expect(menu.isOpen()).toBe(true);

		const newTask = shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');
		newTask?.focus();
		key(newTask, " ");
		expect(menu.isOpen()).toBe(true);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(onAction).not.toHaveBeenCalled();
	});

	it("keeps hover, ArrowRight, and Escape navigation available for synthetic events", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { menu, shadow } = openMenu(payload({ projects: [project("alpha")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');

		pointer(alpha, "pointerenter");
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");

		alpha?.focus();
		key(alpha, "ArrowRight");
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");
		key(shadow?.activeElement, "Escape");
		expect(panel(shadow, 1)).toBeNull();
		expect(menu.isOpen()).toBe(true);
		key(shadow?.activeElement, "Escape");
		expect(menu.isOpen()).toBe(false);
	});

	it("renders session tone, link, stale, termination, state, and full title attributes", () => {
		mockGeometry();
		const target = project("alpha", {
			linked: true,
			orchestrator: session("orch", "alpha", { tone: "ready", linked: true }),
			sessions: [session("task", "alpha", { linked: true, stale: true, terminated: true })],
		});
		const { shadow } = openMenu(payload({ projects: [target] }));
		const projectRow = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		projectRow?.click();
		const task = shadow?.querySelector<HTMLElement>('[data-key="task:task"]');
		const orchestrator = shadow?.querySelector<HTMLElement>('[data-key="orchestrator:orch"]');

		expect(projectRow?.getAttribute("data-linked")).toBe("true");
		expect(projectRow?.querySelector("svg.link")).not.toBeNull();
		expect(projectRow?.querySelector("svg.chev")?.getAttribute("width")).toBe("14");
		expect(task?.getAttribute("data-tone")).toBe("working");
		expect(task?.querySelector('.dot[aria-hidden="true"]')?.getAttribute("data-tone")).toBe("working");
		expect(task?.getAttribute("data-linked")).toBe("true");
		expect(task?.querySelector("svg.link")?.getAttribute("aria-hidden")).toBe("true");
		expect(task?.querySelector("svg.link")?.getAttribute("width")).toBe("12");
		expect(task?.querySelector(".sr")?.textContent).toBe("Linked");
		expect(task?.getAttribute("data-stale")).toBe("true");
		expect(task?.getAttribute("data-terminated")).toBe("true");
		expect(task?.getAttribute("title")).toBe("Session task\nRunning\nBuilding changes");
		expect(orchestrator?.getAttribute("title")).toBe("Orchestrator\nRunning\nBuilding changes");
		expect(orchestrator?.getAttribute("data-tone")).toBe("ready");
	});

	it("emits encoded action URLs and closes with trigger focus restored", () => {
		mockGeometry();
		const encoded = project("project α", {
			orchestrator: null,
			sessions: [session("task one", "project α", { label: "Task one" })],
		});
		const { menu, shadow, trigger, onAction } = openMenu(payload({ projects: [encoded] }), vi.fn(), undefined, allowTestActionEvents());
		shadow?.querySelector<HTMLElement>('[data-key="project:project α"]')?.click();
		shadow?.querySelector<HTMLElement>('[data-key="task:task one"]')?.click();

		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			`ao://multica/open-with-ao/open/${encodeURIComponent("project α")}/${encodeURIComponent("task one")}?n=${NONCE}`,
		);
		expect(parseOpenWithAoActionUrl(vi.mocked(onAction).mock.calls[0]?.[0])).toEqual({
			kind: "open",
			projectId: "project α",
			sessionId: "task one",
			nonce: NONCE,
		});
		expect(menu.isOpen()).toBe(false);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
	});

	it.each(["orchestrator:orch-alpha", "task:task-alpha"])("adds a valid workspace slug to the %s action URL", (rowKey) => {
		mockGeometry();
		const { shadow, onAction } = openMenu(
			payload(),
			vi.fn(),
			undefined,
			allowTestActionEvents(),
			() => "acme",
		);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		shadow?.querySelector<HTMLElement>(`[data-key="${rowKey}"]`)?.click();

		const sessionId = rowKey === "orchestrator:orch-alpha" ? "orch-alpha" : "task-alpha";
		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			`ao://multica/open-with-ao/open/alpha/${sessionId}?n=${NONCE}&w=acme`,
		);
	});

	it.each([
		["null", (): string | null => null],
		["invalid", (): string | null => "Acme"],
		["throwing", (): string | null => { throw new Error("workspace lookup failed"); }],
	] as const)("omits an absent, invalid, or throwing workspace slug (%s)", (_name, getWorkspaceSlug) => {
		mockGeometry();
		const { shadow, onAction } = openMenu(payload(), vi.fn(), undefined, allowTestActionEvents(), getWorkspaceSlug);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]')?.click();

		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			`ao://multica/open-with-ao/open/alpha/task-alpha?n=${NONCE}`,
		);
	});

	it("activates New task with the expected action URL", () => {
		mockGeometry();
		const getWorkspaceSlug = vi.fn(() => "acme");
		const { shadow, onAction, menu } = openMenu(
			payload({ deducedProjectId: "alpha" }),
			vi.fn(),
			undefined,
			allowTestActionEvents(),
			getWorkspaceSlug,
		);
		shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]')?.click();

		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			`ao://multica/open-with-ao/new-task/alpha?n=${NONCE}`,
		);
		expect(parseOpenWithAoActionUrl(vi.mocked(onAction).mock.calls[0]?.[0])).toEqual({
			kind: "new-task",
			projectId: "alpha",
			nonce: NONCE,
		});
		expect(getWorkspaceSlug).not.toHaveBeenCalled();
		expect(menu.isOpen()).toBe(false);
	});

	it("opens a project submenu on click and replaces sibling panels", () => {
		mockGeometry();
		const { shadow, menu } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		const beta = shadow?.querySelector<HTMLElement>('[data-key="project:beta"]');
		alpha?.click();
		expect(shadow?.querySelector('.panel[data-level="1"]')?.getAttribute("aria-label")).toBe("Project alpha");
		expect(alpha?.getAttribute("aria-expanded")).toBe("true");
		beta?.click();
		expect(alpha?.getAttribute("aria-expanded")).toBe("false");
		expect(beta?.getAttribute("aria-expanded")).toBe("true");
		expect(shadow?.querySelectorAll('.panel[data-level="1"]')).toHaveLength(1);
		menu.closeSubmenus(1);
		expect(shadow?.querySelector('.panel[data-level="1"]')).toBeNull();
		expect(beta?.getAttribute("aria-expanded")).toBe("false");
	});

	it("closes descendants and cancels deeper hover timers when a parent panel scrolls", () => {
		vi.useFakeTimers();
		const { shadow } = openThreeLevelMenu();
		const root = panel(shadow, 0);
		const levelOne = panel(shadow, 1);
		const alpha = shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]');
		const beta = shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:beta"]');
		pointer(beta, "pointerenter");
		expect(vi.getTimerCount()).toBe(1);

		levelOne?.dispatchEvent(new Event("scroll"));

		expect(panel(shadow, 0)).toBe(root);
		expect(panel(shadow, 1)).toBe(levelOne);
		expect(panel(shadow, 2)).toBeNull();
		expect(shadow?.querySelector('[data-key="all-projects"]')?.getAttribute("aria-expanded")).toBe("true");
		expect(alpha?.getAttribute("aria-expanded")).toBe("false");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 2)).toBeNull();
	});

	it("closes all descendants when the root panel scrolls", () => {
		const { shadow } = openThreeLevelMenu();
		const root = panel(shadow, 0);
		root?.dispatchEvent(new Event("scroll"));

		expect(panel(shadow, 0)).toBe(root);
		expect(panel(shadow, 1)).toBeNull();
		expect(panel(shadow, 2)).toBeNull();
		expect(shadow?.querySelector('[data-key="all-projects"]')?.getAttribute("aria-expanded")).toBe("false");
	});

	it("returns focus to the first closed panel opener when scrolling removes focused descendants", () => {
		const { shadow } = openThreeLevelMenu();
		const levelOne = panel(shadow, 1);
		const opener = shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]');
		const task = shadow?.querySelector<HTMLElement>('.panel[data-level="2"] [data-key="task:task-alpha"]');
		task?.focus();

		levelOne?.dispatchEvent(new Event("scroll"));

		expect(panel(shadow, 2)).toBeNull();
		expect(shadow?.activeElement).toBe(opener);
	});

	it("keeps the deepest panel and its ancestors open when it scrolls", () => {
		const { shadow } = openThreeLevelMenu();
		const root = panel(shadow, 0);
		const levelOne = panel(shadow, 1);
		const deepest = panel(shadow, 2);
		deepest?.dispatchEvent(new Event("scroll"));

		expect(panel(shadow, 0)).toBe(root);
		expect(panel(shadow, 1)).toBe(levelOne);
		expect(panel(shadow, 2)).toBe(deepest);
	});

	it("removes panel scroll handlers when panels close", () => {
		const addPanelEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
		const removePanelEventListener = vi.spyOn(HTMLElement.prototype, "removeEventListener");
		const { menu, shadow, trigger } = openThreeLevelMenu();
		const oldRoot = panel(shadow, 0);
		const oldLevelOne = panel(shadow, 1);
		const scrollHandlers = addPanelEventListener.mock.calls
			.filter(([type]) => type === "scroll")
			.map(([, listener]) => listener);
		expect(scrollHandlers).toHaveLength(3);
		expect(addPanelEventListener.mock.calls.filter(([type]) => type === "scroll").map(([, , options]) => options)).toEqual([
			{ passive: true },
			{ passive: true },
			{ passive: true },
		]);

		menu.closeSubmenus(1);
		const removedScrollHandlers = removePanelEventListener.mock.calls
			.filter(([type]) => type === "scroll")
			.map(([, listener]) => listener);
		expect(removedScrollHandlers).toContain(scrollHandlers[1]);
		expect(removedScrollHandlers).toContain(scrollHandlers[2]);

		menu.openSubmenu("all-projects");
		menu.openSubmenu("project:alpha");
		oldLevelOne?.dispatchEvent(new Event("scroll"));
		expect(panel(shadow, 2)).not.toBeNull();

		const reopenedScrollHandlers = addPanelEventListener.mock.calls
			.filter(([type]) => type === "scroll")
			.map(([, listener]) => listener)
			.slice(3);
		menu.close();
		const allRemovedScrollHandlers = removePanelEventListener.mock.calls
			.filter(([type]) => type === "scroll")
			.map(([, listener]) => listener);
		for (const handler of reopenedScrollHandlers) {
			expect(allRemovedScrollHandlers).toContain(handler);
		}

		menu.open(trigger);
		const reopenedShadow = document.getElementById(MENU_ID)?.shadowRoot;
		reopenedShadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
		reopenedShadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]')?.click();
		oldRoot?.dispatchEvent(new Event("scroll"));
		expect(panel(reopenedShadow, 2)).not.toBeNull();
	});

	it("opens hovered submenus after 100 ms, replaces siblings, and moves the highlight", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		const beta = shadow?.querySelector<HTMLElement>('[data-key="project:beta"]');
		const root = panel(shadow, 0);
		expect(shadow?.activeElement).toBe(root);

		pointer(alpha, "pointerenter");
		expect(alpha?.getAttribute("data-highlighted")).toBe("true");
		expect(beta?.hasAttribute("data-highlighted")).toBe(false);
		expect(shadow?.activeElement).toBe(alpha);
		vi.advanceTimersByTime(99);
		expect(panel(shadow, 1)).toBeNull();
		vi.advanceTimersByTime(1);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");

		pointer(beta, "pointerenter");
		expect(alpha?.hasAttribute("data-highlighted")).toBe(false);
		expect(beta?.getAttribute("data-highlighted")).toBe("true");
		vi.advanceTimersByTime(99);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");
		vi.advanceTimersByTime(1);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project beta");
	});

	it("cancels a pending submenu open when the pointer leaves its row before 100 ms", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		pointer(alpha, "pointerenter");
		expect(vi.getTimerCount()).toBe(1);
		pointer(alpha, "pointerleave");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 1)).toBeNull();
	});

	it("cancels a sibling hover open when the pointer enters the existing submenu", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { menu, shadow } = openMenu(payload({ deducedProjectId: "alpha", projects: [project("alpha"), project("beta")] }));
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		allProjects?.click();
		const alpha = shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]');
		const beta = shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:beta"]');
		alpha?.click();
		pointer(beta, "pointerenter");
		pointer(allProjects, "pointerleave");
		expect(vi.getTimerCount()).toBe(2);
		pointer(panel(shadow, 2), "pointerenter");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 2)?.getAttribute("aria-label")).toBe("Project alpha");
		menu.close();
	});

	it("cancels pending hover opens when keyboard navigation takes over", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		pointer(alpha, "pointerenter");
		expect(vi.getTimerCount()).toBe(1);
		key(alpha, "ArrowDown");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 1)).toBeNull();
	});

	it("closes deeper panels after 150 ms on a plain row and cancels the close when entering a submenu panel", () => {
		vi.useFakeTimers();
		mockGeometry();
		const deduced = payload({ deducedProjectId: "alpha", projects: [project("alpha"), project("beta")] });
		const { shadow } = openMenu(deduced);
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		const task = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]');
		allProjects?.click();
		const submenu = panel(shadow, 1);
		pointer(allProjects, "pointerleave");
		pointer(submenu, "pointerenter");
		vi.advanceTimersByTime(150);
		expect(panel(shadow, 1)).not.toBeNull();

		pointer(task, "pointerenter");
		vi.advanceTimersByTime(149);
		expect(panel(shadow, 1)).not.toBeNull();
		vi.advanceTimersByTime(1);
		expect(panel(shadow, 1)).toBeNull();
	});

	it("supports wrapped arrow navigation, Home/End, disabled-row skipping, and submenu keyboard focus", () => {
		mockGeometry();
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha", projects: [project("alpha", { orchestrator: null, sessions: [] })] }), vi.fn(), { viaKeyboard: true });
		const root = panel(shadow, 0);
		const disabled = shadow?.querySelector<HTMLElement>('[data-key="orchestrator:none"]');
		const action = shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		expect(shadow?.activeElement).toBe(action);

		root?.focus();
		key(root, "ArrowDown");
		expect(shadow?.activeElement).toBe(action);
		root?.focus();
		key(root, "ArrowUp");
		expect(shadow?.activeElement).toBe(allProjects);
		disabled?.focus();
		key(disabled, "ArrowDown");
		expect(shadow?.activeElement).toBe(action);
		key(action, "ArrowDown");
		expect(shadow?.activeElement).toBe(allProjects);
		key(allProjects, "ArrowDown");
		expect(shadow?.activeElement).toBe(action);
		key(action, "ArrowUp");
		expect(shadow?.activeElement).toBe(allProjects);
		key(allProjects, "Home");
		expect(shadow?.activeElement).toBe(action);
		key(action, "End");
		expect(shadow?.activeElement).toBe(allProjects);
		expect(action?.getAttribute("data-highlighted")).toBeNull();
		expect(allProjects?.getAttribute("data-highlighted")).toBe("true");

		key(allProjects, "ArrowRight");
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("All projects");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
		key(shadow?.activeElement ?? null, "ArrowLeft");
		expect(panel(shadow, 1)).toBeNull();
		expect(shadow?.activeElement).toBe(allProjects);
		expect(allProjects?.getAttribute("data-highlighted")).toBe("true");
	});

	it("reveals keyboard-focused rows within a tall scrollable panel", () => {
		const projects = ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => project(id));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.id === "menu-trigger") return rect(40, 20, 150, 30);
			if (this.classList.contains("panel")) return rect(0, 100, 240, 60);
			if (this.matches(".item[data-key]")) {
				const panelElement = this.parentElement;
				const index = Array.from(panelElement?.querySelectorAll<HTMLElement>(".item[data-key]") ?? []).indexOf(this);
				return rect(4, 104 + index * 24 - (panelElement?.scrollTop ?? 0), 200, 24);
			}
			return rect(0, 0, 100, 24);
		});
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
		const { shadow } = openMenu(payload({ projects }), vi.fn(), { viaKeyboard: true });
		const root = panel(shadow, 0);
		const last = shadow?.querySelector<HTMLElement>('[data-key="project:epsilon"]');
		key(last, "End");
		expect(shadow?.activeElement).toBe(last);
		expect(root?.querySelector(".footer")).toBeNull();
		expect(root?.scrollTop).toBe(68);
		key(last, "Home");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
		expect(root?.scrollTop).toBe(0);
	});

	it("keeps the sticky footer visible at End and reveals the previous task on ArrowUp", () => {
		const tasks = Array.from({ length: 24 }, (_, index) => session(`task-alpha-${index}`, "alpha"));
		mockScrollableMenuGeometry();
		const { shadow } = openMenu(
			payload({ deducedProjectId: "alpha", projects: [project("alpha", { sessions: tasks })] }),
			vi.fn(),
			{ viaKeyboard: true },
		);
		const root = panel(shadow, 0);
		const footer = root?.querySelector<HTMLElement>(".footer");
		const newTask = shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		expect(root?.style.maxHeight).toBe("218px");
		expect(shadow?.querySelector("style")?.textContent).toMatch(/\.footer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*-4px;/);

		key(newTask, "End");
		expect(shadow?.activeElement).toBe(allProjects);
		expect(root?.scrollTop).toBe(0);

		newTask?.focus();
		key(newTask, "ArrowUp");
		const lastTask = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha-23"]');
		expect(shadow?.activeElement).toBe(lastTask);
		expect(root?.scrollTop).toBeGreaterThan(0);
		expect(lastTask?.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer?.getBoundingClientRect().top ?? 0);
	});

	it("keeps focused rows above the sticky footer while ArrowDown passes through the last tasks", () => {
		const tasks = Array.from({ length: 24 }, (_, index) => session(`task-alpha-${index}`, "alpha"));
		mockScrollableMenuGeometry();
		const { shadow } = openMenu(
			payload({ deducedProjectId: "alpha", projects: [project("alpha", { sessions: tasks })] }),
			vi.fn(),
			{ viaKeyboard: true },
		);
		const root = panel(shadow, 0);
		const footer = root?.querySelector<HTMLElement>(".footer");
		let focused = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha-20"]') ?? null;
		focused?.focus({ preventScroll: true });

		for (const index of [21, 22, 23]) {
			key(focused, "ArrowDown");
			focused = shadow?.querySelector<HTMLElement>(`[data-key="task:task-alpha-${index}"]`) ?? null;
			expect(shadow?.activeElement).toBe(focused);
			expect(focused?.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer?.getBoundingClientRect().top ?? 0);
		}
	});

	it("restores a focused task above the sticky footer after update", () => {
		const tasks = Array.from({ length: 24 }, (_, index) => session(`task-alpha-${index}`, "alpha"));
		mockScrollableMenuGeometry();
		const initialPayload = payload({ deducedProjectId: "alpha", projects: [project("alpha", { sessions: tasks })] });
		const { menu, shadow } = openMenu(initialPayload);
		shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha-23"]')?.focus({ preventScroll: true });

		menu.update(payload({ deducedProjectId: "alpha", projects: [project("alpha", { sessions: tasks })] }));

		const root = panel(shadow, 0);
		const footer = root?.querySelector<HTMLElement>(".footer");
		const restoredTask = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha-23"]');
		expect(shadow?.activeElement).toBe(restoredTask);
		expect(root?.scrollTop).toBeGreaterThan(0);
		expect(restoredTask?.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer?.getBoundingClientRect().top ?? 0);
	});

	it("keeps a keyboard-opened submenu through the queued reveal scroll and closes it on a genuine scroll", () => {
		const projects = ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => project(id));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.id === "menu-trigger") return rect(40, 20, 150, 30);
			if (this.classList.contains("panel")) return rect(0, 100, 240, 60);
			if (this.matches(".item[data-key]")) {
				const panelElement = this.parentElement;
				const index = Array.from(panelElement?.querySelectorAll<HTMLElement>(".item[data-key]") ?? []).indexOf(this);
				return rect(4, 104 + index * 24 - (panelElement?.scrollTop ?? 0), 200, 24);
			}
			return rect(0, 0, 100, 24);
		});
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
		const { shadow } = openMenu(payload({ projects }), vi.fn(), { viaKeyboard: true });
		const root = panel(shadow, 0);
		const last = shadow?.querySelector<HTMLElement>('[data-key="project:epsilon"]');

		key(last, "End");
		expect(root?.scrollTop).toBe(68);
		key(last, "ArrowRight");
		const submenu = panel(shadow, 1);
		expect(submenu?.getAttribute("aria-label")).toBe("Project epsilon");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("orchestrator:orch-epsilon");

		root?.dispatchEvent(new Event("scroll"));
		expect(panel(shadow, 1)).toBe(submenu);
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("orchestrator:orch-epsilon");

		if (root) root.scrollTop = 88;
		root?.dispatchEvent(new Event("scroll"));
		expect(panel(shadow, 1)).toBeNull();
	});

	it("keeps an updated submenu open after restoring and revealing its focused parent row", () => {
		const projects = ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => project(id));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.id === "menu-trigger") return rect(40, 20, 150, 30);
			if (this.classList.contains("panel")) return rect(0, 100, 240, 60);
			if (this.matches(".item[data-key]")) {
				const panelElement = this.parentElement;
				const index = Array.from(panelElement?.querySelectorAll<HTMLElement>(".item[data-key]") ?? []).indexOf(this);
				return rect(4, 104 + index * 24 - (panelElement?.scrollTop ?? 0), 200, 24);
			}
			return rect(0, 0, 100, 24);
		});
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
		const { shadow, menu } = openMenu(payload({ projects }));
		const epsilon = shadow?.querySelector<HTMLElement>('[data-key="project:epsilon"]');
		menu.openSubmenu("project:epsilon");
		epsilon?.focus();

		menu.update(payload({ projects }));

		const root = panel(shadow, 0);
		const submenu = panel(shadow, 1);
		expect(root?.scrollTop).toBe(68);
		expect(submenu?.getAttribute("aria-label")).toBe("Project epsilon");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:epsilon");
		root?.dispatchEvent(new Event("scroll"));
		expect(panel(shadow, 1)).toBe(submenu);
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:epsilon");
	});

	it("clears pending reveal scrolls on close so a new menu handles user scrolling normally", () => {
		const projects = ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => project(id));
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.id === "menu-trigger") return rect(40, 20, 150, 30);
			if (this.classList.contains("panel")) return rect(0, 100, 240, 60);
			if (this.matches(".item[data-key]")) {
				const panelElement = this.parentElement;
				const index = Array.from(panelElement?.querySelectorAll<HTMLElement>(".item[data-key]") ?? []).indexOf(this);
				return rect(4, 104 + index * 24 - (panelElement?.scrollTop ?? 0), 200, 24);
			}
			return rect(0, 0, 100, 24);
		});
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
		const first = openMenu(payload({ projects }), vi.fn(), { viaKeyboard: true });
		const oldRoot = panel(first.shadow, 0);
		const last = first.shadow?.querySelector<HTMLElement>('[data-key="project:epsilon"]');
		key(last, "End");
		expect(oldRoot?.scrollTop).toBe(68);
		first.menu.close();

		const second = openMenu(payload({ projects }));
		const newRoot = panel(second.shadow, 0);
		second.menu.openSubmenu("project:alpha");
		oldRoot?.dispatchEvent(new Event("scroll"));
		expect(panel(second.shadow, 1)).not.toBeNull();
		if (newRoot) newRoot.scrollTop = 1;
		newRoot?.dispatchEvent(new Event("scroll"));
		expect(panel(second.shadow, 1)).toBeNull();
	});

	it("prevents default and propagation only for handled keyboard keys", () => {
		mockGeometry();
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha" }), vi.fn(), { viaKeyboard: true });
		const action = shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');
		const bubbled = vi.fn();
		document.addEventListener("keydown", bubbled);
		const handled = key(action, "ArrowDown");
		expect(handled.defaultPrevented).toBe(true);
		expect(bubbled).not.toHaveBeenCalled();
		const ignored = key(shadow?.activeElement ?? null, "x");
		expect(ignored.defaultPrevented).toBe(false);
		expect(bubbled).toHaveBeenCalledTimes(1);
		document.removeEventListener("keydown", bubbled);
	});

	it("handles Escape in submenu-first order and returns focus to the trigger after the root closes", () => {
		mockGeometry();
		const { menu, shadow, trigger } = openMenu(payload({ projects: [project("alpha"), project("beta")] }), vi.fn(), { viaKeyboard: true });
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		key(alpha, "ArrowRight");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("orchestrator:orch-alpha");
		const submenuEscape = key(shadow?.activeElement ?? null, "Escape");
		expect(submenuEscape.defaultPrevented).toBe(true);
		expect(panel(shadow, 1)).toBeNull();
		expect(shadow?.activeElement).toBe(alpha);
		key(alpha, "Escape");
		expect(menu.isOpen()).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	it("keeps the menu open when its shadow-root trigger receives focus", () => {
		mockGeometry();
		const { trigger } = makeShadowTrigger();
		const menu = createOpenWithAoMenu({ payload: payload(), onAction: vi.fn() });
		menu.open(trigger);
		trigger.focus();
		expect(menu.isOpen()).toBe(true);
	});

	it("handles keyboard navigation originating from a shadow-root trigger", () => {
		mockGeometry();
		const { trigger } = makeShadowTrigger();
		const menu = createOpenWithAoMenu({ payload: payload(), onAction: vi.fn() });
		menu.open(trigger);
		trigger.focus();
		const event = key(trigger, "ArrowDown");
		const shadow = document.getElementById(MENU_ID)?.shadowRoot;
		expect(event.defaultPrevented).toBe(true);
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
		menu.destroy();
	});

	it("keeps a shadow-root trigger menu open through pointerdown and focus until the click toggle", () => {
		mockGeometry();
		const { trigger } = makeShadowTrigger();
		const menu = createOpenWithAoMenu({ payload: payload(), onAction: vi.fn() });
		menu.open(trigger);
		trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
		expect(menu.isOpen()).toBe(true);
		trigger.focus();
		expect(menu.isOpen()).toBe(true);
		trigger.click();
		if (menu.isOpen()) menu.close();
		else menu.open(trigger);
		expect(menu.isOpen()).toBe(false);
	});

	it("activates submenu and action rows with Enter and Space", () => {
		mockGeometry();
		const onAction = vi.fn();
		const { menu, shadow, trigger } = openMenu(
			payload({ deducedProjectId: "alpha" }),
			onAction,
			{ viaKeyboard: true },
			allowTestActionEvents(),
		);
		const allProjects = shadow?.querySelector<HTMLElement>('[data-key="all-projects"]');
		allProjects?.focus();
		key(allProjects, "Enter");
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("All projects");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
		menu.close();
		trigger.remove();

		const secondTrigger = makeTrigger();
		const second = createOpenWithAoMenu({
			payload: payload({ deducedProjectId: "alpha" }),
			onAction,
			isTrustedEvent: allowTestActionEvents(),
		});
		second.open(secondTrigger, { viaKeyboard: true });
		const secondShadow = document.getElementById(MENU_ID)?.shadowRoot;
		const newTask = secondShadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');
		newTask?.focus();
		const enter = key(newTask, "Enter");
		expect(enter.defaultPrevented).toBe(true);
		expect(onAction).toHaveBeenLastCalledWith(`ao://multica/open-with-ao/new-task/alpha?n=${NONCE}`);
		secondTrigger.remove();

		const third = createOpenWithAoMenu({ payload: payload(), onAction, isTrustedEvent: allowTestActionEvents() });
		const thirdTrigger = document.createElement("button");
		thirdTrigger.id = "menu-trigger-2";
		document.body.appendChild(thirdTrigger);
		third.open(thirdTrigger, { viaKeyboard: true });
		const thirdShadow = document.getElementById(MENU_ID)?.shadowRoot;
		const projectRow = thirdShadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		key(projectRow, "Enter");
		const task = thirdShadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]');
		task?.focus();
		const space = key(task, " ");
		expect(space.defaultPrevented).toBe(true);
		expect(onAction).toHaveBeenLastCalledWith(`ao://multica/open-with-ao/open/alpha/task-alpha?n=${NONCE}`);
	});

	it("Tab closes without preventing default or restoring trigger focus", () => {
		mockGeometry();
		const { menu, shadow, trigger } = openMenu(payload(), vi.fn(), { viaKeyboard: true });
		const focused = shadow?.activeElement;
		const event = key(focused, "Tab");
		expect(menu.isOpen()).toBe(false);
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).not.toBe(trigger);
	});

	it("closes on outside pointerdown, focusin, and scroll while ignoring trigger and menu interactions", () => {
		mockGeometry();
		const { menu, host, shadow, trigger } = openMenu();
		const inside = new Event("pointerdown", { bubbles: true, composed: true });
		menuRows(shadow)[0]?.dispatchEvent(inside);
		expect(menu.isOpen()).toBe(true);
		trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
		expect(menu.isOpen()).toBe(true);

		const outside = document.createElement("button");
		outside.setAttribute("data-test-outside", "true");
		document.body.appendChild(outside);
		outside.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
		expect(menu.isOpen()).toBe(false);
		expect(document.activeElement).not.toBe(trigger);
		void host;

		const focusMenu = openMenu();
		const focusOutside = document.createElement("button");
		focusOutside.setAttribute("data-test-outside", "true");
		document.body.appendChild(focusOutside);
		focusOutside.focus();
		expect(focusMenu.menu.isOpen()).toBe(false);

		const scrollMenu = openMenu();
		panel(scrollMenu.shadow, 0)?.dispatchEvent(new Event("scroll", { bubbles: true, composed: true }));
		expect(scrollMenu.menu.isOpen()).toBe(true);
		window.dispatchEvent(new Event("scroll", { bubbles: true, composed: true }));
		expect(scrollMenu.menu.isOpen()).toBe(false);
	});

	it("removes listeners and clears hover timers on close and destroy", () => {
		vi.useFakeTimers();
		mockGeometry();
		const removeDocument = vi.spyOn(document, "removeEventListener");
		const removeWindow = vi.spyOn(window, "removeEventListener");
		const { menu, shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		pointer(shadow?.querySelector('[data-key="project:alpha"]') ?? null, "pointerenter");
		expect(vi.getTimerCount()).toBe(1);
		menu.close();
		expect(vi.getTimerCount()).toBe(0);
		expect(removeDocument).toHaveBeenCalledWith("keydown", expect.any(Function), true);
		expect(removeDocument).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
		expect(removeDocument).toHaveBeenCalledWith("focusin", expect.any(Function), true);
		expect(removeWindow).toHaveBeenCalledWith("scroll", expect.any(Function), true);
		const before = vi.getTimerCount();
		vi.advanceTimersByTime(500);
		expect(vi.getTimerCount()).toBe(before);

		const reopened = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		pointer(reopened.shadow?.querySelector('[data-key="project:alpha"]') ?? null, "pointerenter");
		reopened.menu.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("places a normal root panel below a trigger near the top and aligns it to the trigger right edge", () => {
		mockGeometry({ trigger: rect(650, 30, 120, 30), panels: { "0": rect(0, 0, 240, 120) } });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
		const { shadow } = openMenu();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		expect(root?.style.left).toBe("530px");
		expect(root?.style.top).toBe("64px");
		expect(root?.style.maxHeight).toBe("218px");
		expect(root?.getAttribute("data-placement")).toBe("below");
	});

	it("places the root panel above a trigger near the bottom", () => {
		mockGeometry({ trigger: rect(40, 530, 150, 30), panels: { "0": rect(0, 0, 240, 120) } });
		const { shadow } = openMenu();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		expect(root?.style.top).toBe("406px");
		expect(root?.style.maxHeight).toBe("218px");
		expect(root?.getAttribute("data-placement")).toBe("above");
	});

	it("scrolls a root panel that is taller than both sides above the trigger when there is more room above", () => {
		mockGeometry({ trigger: rect(40, 400, 150, 30), panels: { "0": rect(0, 0, 240, 700) } });
		const { shadow } = openMenu();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		expect(root?.style.top).toBe("178px");
		expect(root?.style.maxHeight).toBe("218px");
		expect(root?.getAttribute("data-placement")).toBe("above");
		expect(shadow?.querySelector("style")?.textContent).toContain("overflow-y: auto");
	});

	it("scrolls a root panel that is taller than both sides below the trigger when there is more room below", () => {
		mockGeometry({ trigger: rect(40, 150, 150, 30), panels: { "0": rect(0, 0, 240, 700) } });
		const { shadow } = openMenu();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		expect(root?.style.top).toBe("184px");
		expect(root?.style.maxHeight).toBe("218px");
		expect(root?.getAttribute("data-placement")).toBe("below");
		expect(shadow?.querySelector("style")?.textContent).toContain("overflow-y: auto");
	});

	it("re-evaluates root panel placement on resize", () => {
		mockGeometry({ trigger: rect(40, 150, 150, 30), panels: { "0": rect(0, 0, 240, 120) } });
		const { shadow } = openMenu();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		expect(root?.getAttribute("data-placement")).toBe("below");
		expect(root?.style.top).toBe("184px");
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 250 });
		window.dispatchEvent(new Event("resize"));
		expect(root?.getAttribute("data-placement")).toBe("above");
		expect(root?.style.top).toBe("26px");
		expect(root?.style.maxHeight).toBe("138px");
	});

	it("places submenus to the right, flips left near the edge, and clamps vertically", () => {
		mockGeometry({
			trigger: rect(50, 30, 100, 30),
			panels: { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 140) },
			rows: { "project:alpha": rect(200, 100, 120, 28), "project:beta": rect(700, 570, 80, 24) },
		});
		const { shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		let submenu = shadow?.querySelector<HTMLElement>('.panel[data-level="1"]');
		expect(submenu?.style.left).toBe("320px");
		expect(submenu?.style.top).toBe("96px");
		shadow?.querySelector<HTMLElement>('[data-key="project:beta"]')?.click();
		submenu = shadow?.querySelector<HTMLElement>('.panel[data-level="1"]');
		expect(submenu?.style.left).toBe("500px");
		expect(submenu?.style.top).toBe("452px");
		expect(submenu?.style.maxHeight).toBe("218px");
	});

	it.each([
		[1320, 860],
		[1000, 700],
	])("caps tall root panels and submenus at 218px in a %ipx by %ipx viewport", (width, height) => {
		mockGeometry({ panels: { "0": rect(0, 0, 240, 500), "1": rect(0, 0, 200, 400) } });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
		const { shadow } = openMenu();
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		const root = panel(shadow, 0);
		const submenu = panel(shadow, 1);

		expect(root?.style.maxHeight).toBe("218px");
		expect(submenu?.style.maxHeight).toBe("218px");
		for (const openedPanel of [root, submenu]) {
			const left = Number.parseFloat(openedPanel?.style.left ?? "0");
			const top = Number.parseFloat(openedPanel?.style.top ?? "0");
			const maxHeight = Number.parseFloat(openedPanel?.style.maxHeight ?? "0");
			expect(left).toBeGreaterThanOrEqual(8);
			expect(left + (openedPanel?.getBoundingClientRect().width ?? 0)).toBeLessThanOrEqual(width - 8);
			expect(top + maxHeight).toBeLessThanOrEqual(height - 8);
		}
	});

	it("keeps a short root panel at its natural height under the max-height cap", () => {
		mockCappedPanelGeometry({ panels: { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 140) } });
		const { shadow } = openMenu();
		const root = panel(shadow, 0);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		const submenu = panel(shadow, 1);

		const rootMaxHeight = Number.parseFloat(root?.style.maxHeight ?? "0");
		const submenuMaxHeight = Number.parseFloat(submenu?.style.maxHeight ?? "0");
		expect(Math.min(120, rootMaxHeight)).toBe(120);
		expect(Math.min(140, submenuMaxHeight)).toBe(140);
	});

	it("repositions a tall deduced-project submenu within a resized viewport", () => {
		const projects = [project("alpha"), ...Array.from({ length: 20 }, (_, index) => project(`project-${index}`))];
		mockCappedPanelGeometry({
			trigger: rect(40, 760, 150, 30),
			panels: { "0": rect(0, 0, 240, 500), "1": rect(0, 0, 200, 500) },
		});
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 860 });
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha", projects }));
		shadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
		const submenu = panel(shadow, 1);

		Object.defineProperty(window, "innerHeight", { configurable: true, value: 150 });
		window.dispatchEvent(new Event("resize"));
		let top = Number.parseFloat(submenu?.style.top ?? "0");
		let height = submenu?.getBoundingClientRect().height ?? 0;
		expect(submenu?.style.maxHeight).toBe("134px");
		expect(top + height).toBeLessThanOrEqual(window.innerHeight - 8);

		Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
		window.dispatchEvent(new Event("resize"));
		top = Number.parseFloat(submenu?.style.top ?? "0");
		height = submenu?.getBoundingClientRect().height ?? 0;
		expect(submenu?.style.maxHeight).toBe("218px");
		expect(top + height).toBeLessThanOrEqual(window.innerHeight - 8);
	});

	it("flips a capped root panel above a trigger near the bottom", () => {
		mockGeometry({ trigger: rect(40, 760, 150, 30), panels: { "0": rect(0, 0, 240, 700) } });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 860 });
		const { shadow } = openMenu();
		const root = panel(shadow, 0);

		expect(root?.getAttribute("data-placement")).toBe("above");
		expect(root?.style.top).toBe("538px");
		expect(root?.style.maxHeight).toBe("218px");
	});

	it("bounds root and submenu heights to the available space in a tiny viewport", () => {
		mockGeometry({ panels: { "0": rect(0, 0, 240, 500), "1": rect(0, 0, 200, 400) } });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 120 });
		const { shadow } = openMenu();
		const root = panel(shadow, 0);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		const submenu = panel(shadow, 1);

		expect(root?.style.maxHeight).toBe("58px");
		expect(parseFloat(root?.style.top ?? "0") + Math.min(500, Number.parseFloat(root?.style.maxHeight ?? "0"))).toBeLessThanOrEqual(112);
		expect(submenu?.style.maxHeight).toBe("104px");
		expect(parseFloat(submenu?.style.top ?? "0") + Math.min(400, Number.parseFloat(submenu?.style.maxHeight ?? "0"))).toBeLessThanOrEqual(112);
	});

	it("keeps deeper cascades on the flipped left side without overlapping the root", () => {
		mockGeometry({
			trigger: rect(650, 20, 120, 30),
			panels: { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 140), "2": rect(0, 0, 200, 140) },
			rows: { "all-projects": rect(700, 100, 80, 28), "project:alpha": rect(520, 130, 80, 28) },
		});
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha" }));
		shadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
		shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]')?.click();

		const root = panel(shadow, 0);
		const levelOne = panel(shadow, 1);
		const levelTwo = panel(shadow, 2);
		expect(root?.style.left).toBe("530px");
		expect(levelOne?.style.left).toBe("500px");
		expect(levelTwo?.style.left).toBe("320px");
		expect(parseFloat(levelTwo?.style.left ?? "0") + 200).toBeLessThanOrEqual(parseFloat(root?.style.left ?? "0"));
	});

	it("falls back to the right for a deeper cascade when the parent's left side has no room", () => {
		mockGeometry({
			trigger: rect(650, 20, 120, 30),
			panels: { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 140), "2": rect(0, 0, 200, 140) },
			rows: { "all-projects": rect(700, 100, 80, 28), "project:alpha": rect(100, 130, 80, 28) },
		});
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha" }));
		shadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
		shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]')?.click();

		expect(panel(shadow, 1)?.style.left).toBe("500px");
		expect(panel(shadow, 2)?.style.left).toBe("180px");
	});

	it("keeps the existing rightward cascade when level one opens to the right", () => {
		mockGeometry({
			panels: { "0": rect(0, 0, 240, 120), "1": rect(0, 0, 200, 140), "2": rect(0, 0, 200, 140) },
			rows: { "all-projects": rect(300, 100, 80, 28), "project:alpha": rect(450, 130, 80, 28) },
		});
		const { shadow } = openMenu(payload({ deducedProjectId: "alpha" }));
		shadow?.querySelector<HTMLElement>('[data-key="all-projects"]')?.click();
		shadow?.querySelector<HTMLElement>('.panel[data-level="1"] [data-key="project:alpha"]')?.click();

		expect(panel(shadow, 1)?.style.left).toBe("380px");
		expect(panel(shadow, 2)?.style.left).toBe("530px");
	});

	it("uses scrollable panel styles and repositions every open level on resize", () => {
		mockGeometry({ rows: { "project:alpha": rect(200, 100, 120, 28) } });
		const { shadow } = openMenu();
		const projectRow = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		projectRow?.click();
		const root = shadow?.querySelector<HTMLElement>('.panel[data-level="0"]');
		const submenu = shadow?.querySelector<HTMLElement>('.panel[data-level="1"]');
		expect(shadow?.querySelector("style")?.textContent).toContain("overflow-y: auto");
		expect(shadow?.querySelector("style")?.textContent).toContain("overscroll-behavior: contain");
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
		window.dispatchEvent(new Event("resize"));
		expect(root?.style.left).toBe("40px");
		expect(submenu?.style.left).toBe("8px");
	});

	it("updates payload, preserves the open submenu chain and restores the focused row key", () => {
		vi.useFakeTimers();
		mockGeometry();
		const initial = payload({ projects: [project("alpha"), project("beta")] });
		const { shadow, menu } = openMenu(initial);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		const task = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]');
		task?.focus();
		task?.setAttribute("data-highlighted", "true");
		menu.update(payload({ projects: [project("alpha", { sessions: [session("task-alpha", "alpha", { label: "Updated task" })] }), project("beta")] }));

		expect(shadow?.querySelector('.panel[data-level="1"]')?.getAttribute("aria-label")).toBe("Project alpha");
		expect(shadow?.querySelector('[data-key="task:task-alpha"] .name')?.textContent).toBe("Updated task");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("task:task-alpha");
		expect(shadow?.querySelector('[data-key="task:task-alpha"]')?.getAttribute("data-highlighted")).toBe("true");

		const beta = shadow?.querySelector<HTMLElement>('[data-key="project:beta"]');
		pointer(beta, "pointerenter");
		expect(vi.getTimerCount()).toBe(1);
		menu.update(payload({ projects: [project("alpha"), project("beta")] }));
		expect(vi.getTimerCount()).toBe(0);
		expect(shadow?.querySelector('.panel[data-level="1"]')?.getAttribute("aria-label")).toBe("Project alpha");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:beta");
		expect(shadow?.querySelector('[data-key="project:beta"]')?.getAttribute("data-highlighted")).toBe("true");
		expect(shadow?.querySelector('[data-key="task:task-alpha"]')?.getAttribute("data-highlighted")).toBe("true");
		menu.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops submenu keys that disappear after update", () => {
		mockGeometry();
		const { shadow, menu } = openMenu(payload());
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		menu.update(payload({ projects: [project("beta")] }));
		expect(shadow?.querySelector('.panel[data-level="1"]')).toBeNull();
	});

	it("recovers focus to the surviving submenu opener when the focused task is removed", () => {
		mockGeometry();
		const { shadow, menu } = openMenu();
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();
		shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]')?.focus();
		menu.update(payload({ projects: [project("alpha", { sessions: [] })] }));
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
	});

	it("recovers focus to the first root row when the focused project and submenu disappear", () => {
		mockGeometry();
		const { shadow, menu } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		alpha?.click();
		alpha?.focus();
		menu.update(payload({ projects: [project("beta")] }));
		expect(panel(shadow, 1)).toBeNull();
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("project:beta");
	});

	it("recovers focus to the root panel when an update leaves only disabled rows", () => {
		mockGeometry();
		const { shadow, menu } = openMenu();
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.focus();
		menu.update(payload({ daemon: "stopped" }));
		expect(shadow?.activeElement).toBe(panel(shadow, 0));
	});

	it("does not steal focus during update when focus is outside the menu", () => {
		mockGeometry();
		const { shadow, menu, trigger } = openMenu();
		trigger.focus();
		menu.update(payload({ projects: [project("beta")] }));
		expect(shadow?.activeElement).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("opens only once, supports keyboard initial focus, and closes/reset attributes", () => {
		mockGeometry();
		const trigger = makeTrigger();
		const menu = createOpenWithAoMenu({ payload: payload(), onAction: vi.fn() });
		menu.open(trigger, { viaKeyboard: true });
		const originalHost = document.getElementById(MENU_ID);
		menu.open(trigger);
		expect(document.querySelectorAll(`#${MENU_ID}`)).toHaveLength(1);
		expect(document.getElementById(MENU_ID)).toBe(originalHost);
		expect(originalHost?.shadowRoot?.activeElement?.getAttribute("data-key")).toBe("project:alpha");
		menu.close();
		expect(document.getElementById(MENU_ID)).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(menu.isOpen()).toBe(false);
	});

	it("destroy closes and makes subsequent calls no-ops", () => {
		mockGeometry();
		const { menu, trigger } = openMenu();
		menu.destroy();
		menu.open(trigger);
		menu.update(payload({ projects: [] }));
		menu.openSubmenu("project:alpha");
		menu.closeSubmenus(1);
		expect(menu.isOpen()).toBe(false);
		expect(document.getElementById(MENU_ID)).toBeNull();
	});

	it("works when reconstructed from its serialized function body", () => {
		vi.useFakeTimers();
		mockGeometry();
		const rebuilt = new Function(`return (${createOpenWithAoMenu.toString()});`)() as typeof createOpenWithAoMenu;
		const onAction = vi.fn();
		const standalone = rebuilt({ payload: payload(), onAction, isTrustedEvent: allowTestActionEvents() });
		const trigger = makeTrigger();
		standalone.open(trigger);
		const shadow = document.getElementById(MENU_ID)?.shadowRoot;
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		pointer(alpha, "pointerenter");
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");
		key(alpha, "ArrowRight");
		expect(shadow?.activeElement?.getAttribute("data-key")).toBe("orchestrator:orch-alpha");
		const enter = key(shadow?.activeElement ?? null, "Enter");
		expect(enter.defaultPrevented).toBe(true);
		expect(onAction).toHaveBeenCalledWith(`ao://multica/open-with-ao/open/alpha/orch-alpha?n=${NONCE}`);
		standalone.destroy();
	});

	it("does not let synthetic action clicks activate task, orchestrator, or new-task rows", () => {
		mockGeometry();
		const onAction = vi.fn();
		const { menu, shadow } = openMenu(payload(), onAction);
		shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]')?.click();

		for (const keyValue of ["orchestrator:orch-alpha", "task:task-alpha", "new-task:alpha"]) {
			shadow?.querySelector<HTMLElement>(`[data-key="${keyValue}"]`)?.click();
			expect(onAction).not.toHaveBeenCalled();
			expect(menu.isOpen()).toBe(true);
		}
	});

	it("does not let synthetic Enter or Space activate a focused action row", () => {
		mockGeometry();
		const onAction = vi.fn();
		const { menu, shadow } = openMenu(payload({ deducedProjectId: "alpha" }), onAction, { viaKeyboard: true });
		const task = shadow?.querySelector<HTMLElement>('[data-key="task:task-alpha"]');
		const newTask = shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]');

		task?.focus();
		key(task, "Enter");
		expect(onAction).not.toHaveBeenCalled();
		expect(menu.isOpen()).toBe(true);

		newTask?.focus();
		key(newTask, " ");
		expect(onAction).not.toHaveBeenCalled();
		expect(menu.isOpen()).toBe(true);
	});

	it("keeps synthetic hover, ArrowRight, and Escape submenu navigation available", () => {
		vi.useFakeTimers();
		mockGeometry();
		const { menu, shadow } = openMenu(payload({ projects: [project("alpha"), project("beta")] }));
		const alpha = shadow?.querySelector<HTMLElement>('[data-key="project:alpha"]');
		pointer(alpha, "pointerenter");
		vi.advanceTimersByTime(100);
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");

		menu.closeSubmenus(1);
		alpha?.focus();
		key(alpha, "ArrowRight");
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");
		key(alpha, "Escape");
		expect(panel(shadow, 1)).toBeNull();
		expect(menu.isOpen()).toBe(true);

		alpha?.click();
		expect(panel(shadow, 1)?.getAttribute("aria-label")).toBe("Project alpha");
	});

	it("allows an action when the injected trust check accepts the event", () => {
		mockGeometry();
		const onAction = vi.fn();
		const { menu, shadow } = openMenu(payload({ deducedProjectId: "alpha" }), onAction, undefined, allowTestActionEvents());
		shadow?.querySelector<HTMLElement>('[data-key="new-task:alpha"]')?.click();

		expect(onAction).toHaveBeenCalledExactlyOnceWith(`ao://multica/open-with-ao/new-task/alpha?n=${NONCE}`);
		expect(menu.isOpen()).toBe(false);
	});
});
