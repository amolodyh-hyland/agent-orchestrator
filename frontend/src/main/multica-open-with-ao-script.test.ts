import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenWithAoPagePayload } from "../shared/multica-open-with-ao";
import { parseOpenWithAoActionUrl } from "../shared/multica-open-with-ao";
import { locateOpenWithAoAnchor, type OpenWithAoAnchor } from "./multica-open-with-ao-anchor";
import { createOpenWithAoMenu, type OpenWithAoMenu } from "./multica-open-with-ao-menu";
import {
	buildOpenWithAoRemoveScript,
	buildOpenWithAoScript,
	createOpenWithAoController,
	OPEN_WITH_AO_CONTROLLER_KEY,
	type OpenWithAoController,
	type OpenWithAoMenuFactoryOptions,
} from "./multica-open-with-ao-script";
import issueHeaderFixture from "./fixtures/multica-issue-header.html?raw";

const NONCE = "open-with-ao-nonce-1234";
const controllers: OpenWithAoController[] = [];

function payload(overrides: Partial<OpenWithAoPagePayload> = {}): OpenWithAoPagePayload {
	return {
		nonce: NONCE,
		issue: { identifier: "SPIK-7", title: "Fix issue" },
		daemon: "ready",
		stale: false,
		deducedProjectId: "project-1",
		deduction: "only-project",
		projects: [
			{
				id: "project-1",
				name: "Project One",
				linked: false,
				orchestrator: null,
				sessions: [
					{
					id: "task-1",
					projectId: "project-1",
					label: "Build API",
					tone: "working",
					stateLabel: "Working",
					detail: "Building",
					stale: false,
					terminated: false,
					updatedAt: 1,
					linked: false,
				},
				],
				moreCount: 0,
			},
		],
		...overrides,
	};
}

function evaluateScript(nextPayload = payload()): unknown {
	return new Function(buildOpenWithAoScript(nextPayload))();
}

function controllerFromWindow(): OpenWithAoController | undefined {
	return (window as unknown as Record<string, OpenWithAoController>)[OPEN_WITH_AO_CONTROLLER_KEY];
}

function setControllerOnWindow(value: unknown): void {
	(window as unknown as Record<string, unknown>)[OPEN_WITH_AO_CONTROLLER_KEY] = value;
}

function mountIssueHeader(): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.innerHTML = issueHeaderFixture;
	const header = wrapper.firstElementChild as HTMLElement;
	document.body.appendChild(header);
	return header;
}

function getActions(header = document.querySelector("header")): HTMLElement {
	const actions = header?.querySelector("div.flex.items-center.gap-1.shrink-0");
	if (!(actions instanceof HTMLElement)) throw new Error("fixture actions cluster missing");
	return actions;
}

function getHeaderTrigger(): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>('button[data-ao-open-with-ao="trigger"]');
}

function makeStubMenu(): OpenWithAoMenu {
	return {
		open: vi.fn(),
		close: vi.fn(),
		update: vi.fn(),
		openSubmenu: vi.fn(),
		closeSubmenus: vi.fn(),
		isOpen: vi.fn(() => false),
		destroy: vi.fn(),
	} as unknown as OpenWithAoMenu;
}

function createDirectController(
	nextPayload: OpenWithAoPagePayload,
	locate: () => OpenWithAoAnchor | null,
	createMenu: (options: OpenWithAoMenuFactoryOptions) => OpenWithAoMenu = () => makeStubMenu(),
): OpenWithAoController {
	const controller = createOpenWithAoController({ payload: nextPayload, version: "test", locate, createMenu });
	controllers.push(controller);
	return controller;
}

async function flushDebounce(): Promise<void> {
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(32);
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = "";
	const existing = controllerFromWindow();
	existing?.destroy();
	delete (window as unknown as Record<string, unknown>)[OPEN_WITH_AO_CONTROLLER_KEY];
	controllers.length = 0;
});

afterEach(() => {
	controllerFromWindow()?.destroy();
	for (const controller of controllers) controller.destroy();
	delete (window as unknown as Record<string, unknown>)[OPEN_WITH_AO_CONTROLLER_KEY];
	document.body.innerHTML = "";
	vi.clearAllTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("multica Open with AO page controller script", () => {
	it.each([
		["valid workspace", JSON.stringify({ state: { activeWorkspaceSlug: "Acme_Workspace-2" } }), "acme_workspace-2"],
		["missing workspace", null, null],
		["bad JSON", "{", null],
		["bad slug", JSON.stringify({ state: { activeWorkspaceSlug: "bad slug" } }), null],
	])("provides a workspace slug reader for %s", (_label, storedValue, expectedSlug) => {
		vi.stubGlobal("localStorage", { getItem: vi.fn(() => storedValue) });
		const createMenu = vi.fn((_options: OpenWithAoMenuFactoryOptions) => makeStubMenu());
		createDirectController(payload(), () => null, createMenu);

		const menuOptions = createMenu.mock.calls[0]?.[0];
		expect(menuOptions?.getWorkspaceSlug).toEqual(expect.any(Function));
		expect(menuOptions?.getWorkspaceSlug?.()).toBe(expectedSlug);
	});

	it("evaluates to undefined and installs the controller", () => {
		expect(evaluateScript()).toBeUndefined();
		expect(controllerFromWindow()).toBeDefined();
		expect(controllerFromWindow()?.version).toMatch(/^[0-9a-f]{8}$/);
	});

	it("reuses the controller and trigger for the same code while updating an open menu", () => {
		mountIssueHeader();
		evaluateScript(payload());
		const controller = controllerFromWindow();
		const trigger = getHeaderTrigger();
		trigger?.click();
		const host = document.getElementById("ao-open-with-ao-menu");
		expect(host?.shadowRoot?.querySelector('.item[data-kind="task"] .name')?.textContent).toBe("Build API");

		evaluateScript(payload({
			projects: [
				{
					...payload().projects[0]!,
					sessions: [{ ...payload().projects[0]!.sessions[0]!, label: "Updated task" }],
				},
			],
		}));

		expect(controllerFromWindow()).toBe(controller);
		expect(getHeaderTrigger()).toBe(trigger);
		expect(host?.shadowRoot?.querySelector('.item[data-kind="task"] .name')?.textContent).toBe("Updated task");
	});

	it("destroys an older version controller before replacing it", () => {
		const destroy = vi.fn();
		setControllerOnWindow({ version: "older", destroy });

		evaluateScript();

		expect(destroy).toHaveBeenCalledOnce();
		expect(controllerFromWindow()).toBeDefined();
		expect(controllerFromWindow()?.version).not.toBe("older");
	});

	it("keeps a no-issue payload empty without observers or timers", () => {
		const noIssue = payload({ issue: null });
		evaluateScript(noIssue);

		expect(controllerFromWindow()?.getState()).toBe("NO_ISSUE");
		expect(document.querySelector('[data-ao-open-with-ao="trigger"]')).toBeNull();
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("inserts a native-class trigger immediately before pin without copying neighbor attributes", () => {
		const header = mountIssueHeader();
		const actions = getActions(header);
		const menuTrigger = actions.querySelector<HTMLElement>('button[data-slot="dropdown-menu-trigger"]')!;
		const pin = actions.querySelector<HTMLElement>("button:has(svg.lucide-pin)")!;
		evaluateScript();
		const trigger = getHeaderTrigger();

		expect(trigger?.parentElement).toBe(actions);
		expect(trigger?.nextElementSibling).toBe(pin);
		expect(trigger?.className).toBe(menuTrigger.className);
		expect(trigger?.type).toBe("button");
		expect(trigger?.getAttribute("aria-label")).toBe("Open with AO");
		expect(trigger?.getAttribute("title")).toBe("Open with AO");
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(trigger?.hasAttribute("id")).toBe(false);
		expect(trigger?.hasAttribute("data-slot")).toBe(false);
		expect(trigger?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
		expect(trigger?.querySelector("svg")?.className.baseVal ?? "").not.toMatch(/size-/);
		expect(trigger?.querySelector("span")?.textContent).toBe("Open with AO");
		expect(trigger?.style.width).toBe("auto");
		expect(trigger?.style.height).toBe("var(--button-height-sm, 28px)");
	});

	it("toggles the menu from click and opens it from ArrowDown", () => {
		mountIssueHeader();
		evaluateScript();
		const trigger = getHeaderTrigger()!;
		trigger.click();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();
		trigger.click();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();

		trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();
	});

	it("shows fallback after 1500 ms and moves it into a later header", async () => {
		evaluateScript();
		const controller = controllerFromWindow()!;
		await vi.advanceTimersByTimeAsync(1499);
		expect(controller.getState()).toBe("WAIT");
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		const fallback = document.getElementById("ao-open-with-ao-fallback");
		expect(controller.getState()).toBe("FALLBACK");
		expect(fallback?.parentElement).toBe(document.documentElement);
		expect(fallback?.getAttribute("style")).toContain("right: 16px");
		expect(fallback?.getAttribute("style")).toContain("z-index: 2147483000");
		expect(fallback?.shadowRoot?.querySelector("style")?.textContent).toContain("var(--surface-raised, #fff)");
		expect(
			(document.querySelectorAll('[data-ao-open-with-ao="trigger"]').length ?? 0) +
			(fallback?.shadowRoot?.querySelectorAll('[data-ao-open-with-ao="trigger"]').length ?? 0),
		).toBe(1);
		fallback?.shadowRoot?.querySelector<HTMLButtonElement>('[data-ao-open-with-ao="trigger"]')?.click();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();

		mountIssueHeader();
		await flushDebounce();
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();
		expect(controller.getState()).toBe("ANCHORED");
		expect(getHeaderTrigger()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps the open menu anchored when re-inserting the same trigger after an actions replacement", async () => {
		const header = mountIssueHeader();
		const pristineActions = getActions(header).cloneNode(true) as HTMLElement;
		evaluateScript();
		const originalTrigger = getHeaderTrigger();
		originalTrigger?.click();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();
		getActions(header).replaceWith(pristineActions.cloneNode(true));
		await flushDebounce();

		const newActions = getActions(header);
		expect(getHeaderTrigger()).toBe(originalTrigger);
		expect(originalTrigger?.isConnected).toBe(true);
		expect(originalTrigger?.parentElement).toBe(newActions);
		expect(originalTrigger?.nextElementSibling).toBe(newActions.querySelector("button:has(svg.lucide-pin)"));
		expect(originalTrigger?.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();
	});

	it("revalidates the located anchor after unrelated mutations", async () => {
		mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		const controller = createDirectController(payload(), locate);
		expect(controller.getState()).toBe("ANCHORED");
		expect(locate).toHaveBeenCalledOnce();

		document.body.appendChild(document.createElement("aside"));
		await flushDebounce();
		expect(locate).toHaveBeenCalledTimes(2);
	});

	it("closes an open header menu when the actions cluster disappears into a gap", async () => {
		const header = mountIssueHeader();
		const actions = getActions(header);
		const pristineActions = actions.cloneNode(true) as HTMLElement;
		const nextSibling = actions.nextSibling;
		evaluateScript();
		getHeaderTrigger()?.click();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();

		actions.remove();
		await flushDebounce();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();
		expect(getHeaderTrigger()).toBeNull();

		header.insertBefore(pristineActions, nextSibling);
		await flushDebounce();
		expect(getHeaderTrigger()).not.toBeNull();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
	});

	it("falls back when a hidden header is observed and restores it on the validity interval", async () => {
		const header = mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		const controller = createDirectController(payload(), locate);
		header.style.display = "none";
		const style = document.createElement("style");
		style.textContent = "header { display: none; }";
		document.body.appendChild(style);

		await flushDebounce();
		await vi.advanceTimersByTimeAsync(1500);
		expect(controller.getState()).toBe("FALLBACK");
		expect(document.getElementById("ao-open-with-ao-fallback")).not.toBeNull();

		header.style.removeProperty("display");
		style.remove();
		await vi.advanceTimersByTimeAsync(468);
		expect(controller.getState()).toBe("ANCHORED");
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		expect(getHeaderTrigger()?.parentElement).toBe(getActions(header));
	});

	it("detects attribute-only hiding on the 2000 ms validity interval", async () => {
		const header = mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		const controller = createDirectController(payload(), locate);
		header.style.display = "none";

		await vi.advanceTimersByTimeAsync(1999);
		expect(locate).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(locate).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1500);

		expect(controller.getState()).toBe("FALLBACK");
		expect(document.getElementById("ao-open-with-ao-fallback")).not.toBeNull();
	});

	it("keeps fallback state and recovers after an attribute-only header restore", async () => {
		const header = mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		const controller = createDirectController(payload(), locate);
		header.style.display = "none";

		await vi.advanceTimersByTimeAsync(1500);
		await vi.advanceTimersByTimeAsync(2000);
		await flushDebounce();

		const fallback = document.getElementById("ao-open-with-ao-fallback");
		const fallbackTrigger = fallback?.shadowRoot?.querySelector('[data-ao-open-with-ao="trigger"]');
		expect(controller.getState()).toBe("FALLBACK");
		expect(fallback).not.toBeNull();
		expect(document.querySelectorAll('[data-ao-open-with-ao="trigger"]').length + (fallbackTrigger ? 1 : 0)).toBe(1);
		const fallbackTimerCount = vi.getTimerCount();
		expect(fallbackTimerCount).toBe(1);

		controller.update(payload({ stale: true }));
		expect(controller.getState()).toBe("FALLBACK");
		expect(vi.getTimerCount()).toBe(fallbackTimerCount);

		document.body.appendChild(document.createElement("aside"));
		await flushDebounce();
		expect(controller.getState()).toBe("FALLBACK");
		expect(vi.getTimerCount()).toBe(fallbackTimerCount);

		header.style.removeProperty("display");
		await vi.advanceTimersByTimeAsync(468);

		expect(controller.getState()).toBe("ANCHORED");
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		expect(getHeaderTrigger()?.parentElement).toBe(getActions(header));
		expect(document.querySelectorAll('[data-ao-open-with-ao="trigger"]').length).toBe(1);

		controller.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("runs a throttled observer tick during a continuous mutation stream", async () => {
		mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		createDirectController(payload(), locate);
		const stream = window.setInterval(() => {
			document.body.appendChild(document.createElement("aside"));
		}, 10);

		await vi.advanceTimersByTimeAsync(50);
		window.clearInterval(stream);

		expect(locate).toHaveBeenCalledTimes(2);
	});

	it("switches to fallback after six relocations inside one second", async () => {
		const header = mountIssueHeader();
		const pristineActions = getActions(header).cloneNode(true) as HTMLElement;
		const controller = createDirectController(payload(), locateOpenWithAoAnchor);
		for (let index = 0; index < 6; index += 1) {
			getActions(header).replaceWith(pristineActions.cloneNode(true));
			await flushDebounce();
		}

		expect(controller.getState()).toBe("FALLBACK");
		expect(document.getElementById("ao-open-with-ao-fallback")).not.toBeNull();
		expect(getHeaderTrigger()).toBeNull();
	});

	it("escapes unsafe payload text and restores it without breaking the script", () => {
		const specialTitle = "A < B \u2028 C \u2029 </script>";
		const source = buildOpenWithAoScript(payload({ issue: { identifier: "SPIK-7", title: specialTitle } }));
		const payloadStart = source.indexOf("const payload = ") + "const payload = ".length;
		const payloadEnd = source.indexOf(";\n\tconst version", payloadStart);
		const embeddedPayload = source.slice(payloadStart, payloadEnd);

		expect(embeddedPayload).not.toContain("<");
		expect(embeddedPayload).not.toContain("\u2028");
		expect(embeddedPayload).not.toContain("\u2029");
		expect(embeddedPayload).toContain("\\u003c");
		expect(embeddedPayload).toContain("\\u2028");
		expect(embeddedPayload).toContain("\\u2029");
		mountIssueHeader();
		expect(() => new Function(source)()).not.toThrow();
		expect(controllerFromWindow()).toBeDefined();
	});

	it("opens a valid action URL with the current payload nonce", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		mountIssueHeader();
		createDirectController(payload(), () => locateOpenWithAoAnchor(), (menuOptions) =>
			createOpenWithAoMenu({ ...menuOptions, isTrustedEvent: () => true }),
		);
		getHeaderTrigger()?.click();
		const menu = document.getElementById("ao-open-with-ao-menu")?.shadowRoot;
		menu?.querySelector<HTMLElement>('.item[data-kind="task"]')?.click();

		expect(open).toHaveBeenCalledOnce();
		const action = parseOpenWithAoActionUrl(open.mock.calls[0]?.[0]);
		expect(action).toEqual({ kind: "open", projectId: "project-1", sessionId: "task-1", nonce: NONCE });
	});

	it("does not call window.open for a synthetic action click in the composed script", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		mountIssueHeader();
		evaluateScript(payload());
		getHeaderTrigger()?.click();
		const menu = document.getElementById("ao-open-with-ao-menu")?.shadowRoot;
		menu?.querySelector<HTMLElement>('.item[data-kind="task"]')?.click();

		expect(open).not.toHaveBeenCalled();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();
	});

	it("removes placement and disconnects the observer when issue becomes null", async () => {
		mountIssueHeader();
		const locate = vi.fn(() => locateOpenWithAoAnchor());
		const menu = makeStubMenu();
		const controller = createDirectController(payload(), locate, () => menu);
		controller.update(payload({ issue: null }));
		const callsAfterUpdate = locate.mock.calls.length;
		document.body.appendChild(document.createElement("aside"));
		await flushDebounce();

		expect(controller.getState()).toBe("NO_ISSUE");
		expect(getHeaderTrigger()).toBeNull();
		expect(document.getElementById("ao-open-with-ao-fallback")).toBeNull();
		expect(locate).toHaveBeenCalledTimes(callsAfterUpdate);
		expect(menu.update).toHaveBeenCalledTimes(1);
		expect(menu.close).toHaveBeenCalledWith({ restoreFocus: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears fallback, debounce, and cooldown timers on destroy", async () => {
		const controller = createDirectController(payload(), () => null);
		document.body.appendChild(document.createElement("aside"));
		await Promise.resolve();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		controller.destroy();
		expect(vi.getTimerCount()).toBe(0);
		controller.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the validity interval on destroy", () => {
		mountIssueHeader();
		const controller = createDirectController(payload(), locateOpenWithAoAnchor);
		expect(vi.getTimerCount()).toBe(1);

		controller.destroy();

		expect(vi.getTimerCount()).toBe(0);
	});

	it("remove script destroys the controller and removes its DOM", () => {
		mountIssueHeader();
		evaluateScript();
		getHeaderTrigger()?.click();
		expect(document.getElementById("ao-open-with-ao-menu")).not.toBeNull();

		expect(new Function(buildOpenWithAoRemoveScript())()).toBeUndefined();
		expect(controllerFromWindow()).toBeUndefined();
		expect(getHeaderTrigger()).toBeNull();
		expect(document.getElementById("ao-open-with-ao-menu")).toBeNull();
	});

	it("rebuilds from createOpenWithAoController.toString with injected dependencies", () => {
		const factory = new Function(`return (${createOpenWithAoController.toString()});`)() as typeof createOpenWithAoController;
		const controller = factory({
			payload: payload(),
			version: "reconstructed",
			locate: () => null,
			createMenu: () => makeStubMenu(),
		});
		controllers.push(controller);

		expect(controller.version).toBe("reconstructed");
		expect(controller.getState()).toBe("WAIT");
		controller.destroy();
	});
});
