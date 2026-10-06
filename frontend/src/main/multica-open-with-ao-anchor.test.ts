import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateOpenWithAoAnchor } from "./multica-open-with-ao-anchor";
import type { OpenWithAoAnchor } from "./multica-open-with-ao-anchor";

const issueHeader = readFileSync(join(process.cwd(), "src/main/fixtures/multica-issue-header.html"), "utf8");
const tabStripHeader = readFileSync(join(process.cwd(), "src/main/fixtures/multica-tab-strip-header.html"), "utf8");

beforeEach(() => {
	document.body.innerHTML = "";
});

afterEach(() => {
	document.body.innerHTML = "";
});

function addIssueHeader(): HTMLElement {
	document.body.insertAdjacentHTML("beforeend", issueHeader);
	return document.body.lastElementChild as HTMLElement;
}

function getActions(header: HTMLElement): HTMLElement {
	return header.querySelector("div.flex.items-center.gap-1.shrink-0") as HTMLElement;
}

function getMenuTrigger(header: HTMLElement): HTMLElement {
	return header.querySelector('button[data-slot="dropdown-menu-trigger"]') as HTMLElement;
}

function expectIssueAnchor(anchor: OpenWithAoAnchor | null, header: HTMLElement): asserts anchor is OpenWithAoAnchor {
	expect(anchor).not.toBeNull();
	expect(anchor?.header).toBe(header);
	expect(anchor?.actions).toBe(getActions(header));
	expect(anchor?.layer).toBe(1);
	expect(anchor?.pin).toBe(header.querySelector("button:has(svg.lucide-pin)"));
	expect(anchor?.panelToggle).toBe(header.querySelector("button:has(svg.lucide-panel-right)"));
}

describe("locateOpenWithAoAnchor", () => {
	it("finds the issue header actions and inserts before the pin", () => {
		const header = addIssueHeader();
		const anchor = locateOpenWithAoAnchor();

		expectIssueAnchor(anchor, header);
		expect(anchor.insertBefore).toBe(anchor.pin);
		expect(anchor.actions.className).toBe("flex items-center gap-1 shrink-0");
	});

	it("ignores the tab strip pin decoy and returns null for the tab strip alone", () => {
		document.body.innerHTML = `${tabStripHeader}${issueHeader}`;
		const headers = document.body.querySelectorAll("header");
		const issue = headers[1] as HTMLElement;
		expectIssueAnchor(locateOpenWithAoAnchor(), issue);

		document.body.innerHTML = tabStripHeader;
		expect(locateOpenWithAoAnchor()).toBeNull();
	});

	it("falls back to the menu wrapper when the pin is removed and recognizes pin-off", () => {
		const header = addIssueHeader();
		const actions = getActions(header);
		const pin = actions.querySelector("button:has(svg.lucide-pin)");
		pin?.remove();

		let anchor = locateOpenWithAoAnchor();
		expect(anchor?.pin).toBeNull();
		expect(anchor?.insertBefore).toBe(anchor?.menuWrapper);

		const replacement = document.createElement("button");
		replacement.innerHTML = '<svg class="lucide lucide-pin-off"></svg>';
		actions.insertBefore(replacement, anchor?.menuWrapper ?? null);
		anchor = locateOpenWithAoAnchor();
		expect(anchor?.pin).toBe(replacement);
		expect(anchor?.insertBefore).toBe(replacement);
	});

	it("supports the peek header without a panel toggle", () => {
		const header = addIssueHeader();
		getActions(header).querySelector("button:has(svg.lucide-panel-right)")?.remove();

		const anchor = locateOpenWithAoAnchor();
		expect(anchor?.header).toBe(header);
		expect(anchor?.panelToggle).toBeNull();
	});

	it("uses layer two when the ellipsis icon class is unavailable", () => {
		const header = addIssueHeader();
		getMenuTrigger(header).querySelector("svg")?.classList.remove("lucide-ellipsis");

		const anchor = locateOpenWithAoAnchor();
		expect(anchor?.header).toBe(header);
		expect(anchor?.layer).toBe(2);
	});

	it("uses the trigger itself when the wrapper span is absent", () => {
		const header = addIssueHeader();
		const trigger = getMenuTrigger(header);
		trigger.parentElement?.replaceWith(trigger);

		const anchor = locateOpenWithAoAnchor();
		expect(anchor?.menuTrigger).toBe(trigger);
		expect(anchor?.menuWrapper).toBe(trigger);
		expect(anchor?.actions).toBe(getActions(header));
	});

	it.each([
		["aria-hidden", (header: HTMLElement) => header.setAttribute("aria-hidden", "true")],
		["hidden ancestor", (header: HTMLElement) => header.parentElement?.setAttribute("hidden", "")],
		["display-none ancestor", (header: HTMLElement) => header.parentElement?.setAttribute("style", "display: none")],
	])("skips a hidden first header (%s)", (_label, hide) => {
		document.body.innerHTML = `<div>${issueHeader}</div>${issueHeader}`;
		const headers = Array.from(document.body.querySelectorAll("header")) as HTMLElement[];
		hide(headers[0]);

		expect(locateOpenWithAoAnchor()?.header).toBe(headers[1]);
	});

	it("keeps the first header when visible areas tie and picks the largest area", () => {
		document.body.innerHTML = `${issueHeader}${issueHeader}`;
		const headers = Array.from(document.body.querySelectorAll("header")) as HTMLElement[];
		expect(locateOpenWithAoAnchor()?.header).toBe(headers[0]);

		(headers[0] as HTMLElement).getBoundingClientRect = () =>
			({ width: 10, height: 10 } as DOMRect);
		(headers[1] as HTMLElement).getBoundingClientRect = () =>
			({ width: 20, height: 10 } as DOMRect);
		expect(locateOpenWithAoAnchor()?.header).toBe(headers[1]);
	});

	it("returns null when every candidate header is hidden", () => {
		document.body.innerHTML = `<div hidden>${issueHeader}</div><div style="display: none">${issueHeader}</div>`;
		expect(locateOpenWithAoAnchor()).toBeNull();
	});

	it("ignores extra chips before the pin", () => {
		const header = addIssueHeader();
		const actions = getActions(header);
		const chip = document.createElement("button");
		chip.textContent = "Agent";
		actions.insertBefore(chip, actions.firstElementChild);

		const anchor = locateOpenWithAoAnchor();
		expect(anchor?.header).toBe(header);
		expect(anchor?.insertBefore).toBe(anchor?.pin);
	});

	it("rejects an actions cluster containing only the trigger", () => {
		const header = addIssueHeader();
		const actions = getActions(header);
		Array.from(actions.querySelectorAll("button")).forEach((button) => {
			if (button !== getMenuTrigger(header)) button.remove();
		});
		expect(locateOpenWithAoAnchor()).toBeNull();
	});

	it("returns null when there is no header", () => {
		document.body.innerHTML = "<main></main>";
		expect(locateOpenWithAoAnchor()).toBeNull();
	});

	it("does not mutate the document", () => {
		addIssueHeader();
		const before = document.body.innerHTML;
		locateOpenWithAoAnchor();
		expect(document.body.innerHTML).toBe(before);
	});

	it("works after serialization with Function.prototype.toString", () => {
		const rebuilt = new Function(`return (${locateOpenWithAoAnchor.toString()});`)() as typeof locateOpenWithAoAnchor;
		const header = addIssueHeader();
		const anchor = rebuilt();

		expectIssueAnchor(anchor, header);
		expect(anchor.insertBefore).toBe(anchor.pin);

		document.body.innerHTML = "";
		const renamedIconHeader = addIssueHeader();
		getMenuTrigger(renamedIconHeader).querySelector("svg")?.classList.remove("lucide-ellipsis");
		const renamedIconAnchor = rebuilt();
		expect(renamedIconAnchor?.header).toBe(renamedIconHeader);
		expect(renamedIconAnchor?.layer).toBe(2);

		document.body.innerHTML = "";
		const unwrappedHeader = addIssueHeader();
		const trigger = getMenuTrigger(unwrappedHeader);
		trigger.parentElement?.replaceWith(trigger);
		const unwrappedAnchor = rebuilt();
		expect(unwrappedAnchor?.header).toBe(unwrappedHeader);
		expect(unwrappedAnchor?.menuWrapper).toBe(trigger);
		expect(unwrappedAnchor?.menuTrigger).toBe(trigger);
	});
});
