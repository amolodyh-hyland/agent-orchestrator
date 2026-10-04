import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildLinkedSessionsPillScript,
	MAX_PILL_ENTRIES,
	MULTICA_LINKED_SESSIONS_PILL_ID,
} from "./multica-linked-sessions-pill";

const originalHtmlChildren = Array.from(document.documentElement.children);

function evaluatePill(entries: { label: string; url: string }[], options?: { sendUrl?: string }): unknown {
	return new Function(buildLinkedSessionsPillScript(entries, options))();
}

afterEach(() => {
	document.documentElement.replaceChildren(...originalHtmlChildren);
	vi.restoreAllMocks();
});

describe("multica linked sessions pill", () => {
	it("evaluates as undefined", () => {
		expect(evaluatePill([{ label: "Session", url: "ao://sessions/project/session" }])).toBeUndefined();
	});

	it("adds one pill under the document element with a button for each entry", () => {
		evaluatePill([
			{ label: "Build API", url: "ao://sessions/project/build-api" },
			{ label: "Fix tests", url: "ao://sessions/project/fix-tests" },
		]);

		const pills = document.querySelectorAll(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`);
		const pill = pills[0];
		const buttons = pill?.shadowRoot?.querySelectorAll("button");

		expect(pills).toHaveLength(1);
		expect(pill?.parentElement).toBe(document.documentElement);
		expect(pill?.parentElement).not.toBe(document.body);
		expect(buttons).toHaveLength(2);
		expect(Array.from(buttons ?? [], (button) => button.textContent)).toEqual(["AO · Build API", "AO · Fix tests"]);
	});

	it("renders and opens Send to AO when there are no linked sessions", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const sendUrl = "ao://multica/send-issue";
		evaluatePill([], { sendUrl });

		const pills = document.querySelectorAll(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`);
		const shadow = pills[0]?.shadowRoot;
		const buttons = shadow?.querySelectorAll("button");
		const button = buttons?.[0];
		expect(pills).toHaveLength(1);
		expect(shadow).not.toBeNull();
		expect(buttons).toHaveLength(1);
		expect(button?.textContent).toBe("Send to AO");
		expect(button?.getAttribute("title")).toBe("Create an AO session for this issue");
		expect(button?.getAttribute("class")).toBe("ao-send-to-ao");

		button?.click();

		expect(open).toHaveBeenCalledExactlyOnceWith(sendUrl);
	});

	it("renders Send to AO before linked sessions without changing their URLs", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		evaluatePill(
			[
				{ label: "Build API", url: "ao://sessions/project/build-api" },
				{ label: "Fix tests", url: "ao://sessions/project/fix-tests" },
			],
			{ sendUrl: "ao://multica/send-issue" },
		);

		const shadow = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot;
		const buttons = Array.from(shadow?.querySelectorAll("button") ?? []);
		expect(buttons).toHaveLength(3);
		expect(buttons.map((button) => button.textContent)).toEqual([
			"Send to AO",
			"AO · Build API",
			"AO · Fix tests",
		]);
		expect(shadow?.querySelector(".ao-linked-sessions-more")).toBeNull();

		buttons.forEach((button) => button.click());

		expect(open.mock.calls).toEqual([
			["ao://multica/send-issue"],
			["ao://sessions/project/build-api"],
			["ao://sessions/project/fix-tests"],
		]);
	});

	it("keeps the session cap and overflow count independent of Send to AO", () => {
		const entries = Array.from({ length: MAX_PILL_ENTRIES + 2 }, (_, index) => ({
			label: `Session ${index + 1}`,
			url: `ao://sessions/project/session-${index + 1}`,
		}));
		evaluatePill(entries, { sendUrl: "ao://multica/send-issue" });

		const shadow = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot;
		const buttons = shadow?.querySelectorAll("button");
		expect(buttons).toHaveLength(MAX_PILL_ENTRIES + 1);
		expect(buttons?.[0]?.textContent).toBe("Send to AO");
		expect(shadow?.querySelector(".ao-linked-sessions-more")?.textContent).toBe("+2");
	});

	it("does not render Send to AO without a non-empty send URL", () => {
		evaluatePill([{ label: "Build API", url: "ao://sessions/project/build-api" }], { sendUrl: "" });

		const buttons = document
			.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)
			?.shadowRoot?.querySelectorAll("button");
		expect(buttons).toHaveLength(1);
		expect(buttons?.[0]?.classList.contains("ao-send-to-ao")).toBe(false);
	});

	it("replaces an existing pill when evaluated with Send to AO", () => {
		evaluatePill([{ label: "Original", url: "ao://sessions/project/original" }]);
		const originalPill = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID);

		evaluatePill([], { sendUrl: "ao://multica/send-issue" });

		const pills = document.querySelectorAll(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`);
		expect(pills).toHaveLength(1);
		expect(pills[0]).not.toBe(originalPill);
		expect(pills[0]?.shadowRoot?.querySelector("button")?.textContent).toBe("Send to AO");
	});

	it("keeps script-like send URLs and labels inert", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const label = '<img src=x onerror=alert(1)> "quoted"';
		const sendUrl = 'ao://multica/send-issue/<img src=x onerror=alert(1)>?value="quoted"';
		evaluatePill([{ label, url: "ao://sessions/project/session" }], { sendUrl });

		const shadow = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot;
		const buttons = shadow?.querySelectorAll("button");
		expect(Array.from(buttons ?? [], (button) => button.textContent)).toEqual([
			"Send to AO",
			`AO · ${label}`,
		]);
		expect(buttons?.[1]?.getAttribute("title")).toBe(`Open AO session ${label}`);
		expect(shadow?.querySelector("img")).toBeNull();

		buttons?.[0]?.click();

		expect(open).toHaveBeenCalledExactlyOnceWith(sendUrl);
	});

	it("replaces an existing pill when evaluated again", () => {
		evaluatePill([{ label: "Original", url: "ao://sessions/project/original" }]);
		const originalPill = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID);

		evaluatePill([{ label: "Replacement", url: "ao://sessions/project/replacement" }]);

		const pills = document.querySelectorAll(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`);
		const pill = pills[0];
		expect(pills).toHaveLength(1);
		expect(pill).not.toBe(originalPill);
		expect(pill?.shadowRoot?.querySelector("button")?.textContent).toBe("AO · Replacement");
	});

	it("removes the existing pill when there are no entries", () => {
		evaluatePill([{ label: "Original", url: "ao://sessions/project/original" }]);

		evaluatePill([]);

		expect(document.querySelector(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`)).toBeNull();
	});

	it("renders labels as inert text", () => {
		const labels = ['<img src=x onerror=window.__pwned=1>', '"; alert(1); //'];
		evaluatePill(labels.map((label) => ({ label, url: "ao://sessions/project/session" })));

		const shadow = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot;
		const buttons = shadow?.querySelectorAll("button");
		expect(Array.from(buttons ?? [], (button) => button.textContent)).toEqual(labels.map((label) => `AO · ${label}`));
		expect(shadow?.querySelector("img")).toBeNull();
		expect((window as Window & { __pwned?: number }).__pwned).toBeUndefined();
	});

	it("opens the selected session and prevents the click default", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		evaluatePill([{ label: "Build API", url: "ao://sessions/project/build-api" }]);
		const button = document.querySelector(`#${MULTICA_LINKED_SESSIONS_PILL_ID}`)?.shadowRoot?.querySelector("button");
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });

		button?.dispatchEvent(click);

		expect(open).toHaveBeenCalledExactlyOnceWith("ao://sessions/project/build-api");
		expect(click.defaultPrevented).toBe(true);
	});

	it("limits buttons and shows the remaining entry count", () => {
		const entries = Array.from({ length: MAX_PILL_ENTRIES + 2 }, (_, index) => ({
			label: `Session ${index + 1}`,
			url: `ao://sessions/project/session-${index + 1}`,
		}));
		evaluatePill(entries);

		const shadow = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot;
		expect(shadow?.querySelectorAll("button")).toHaveLength(MAX_PILL_ENTRIES);
		expect(shadow?.querySelector(".ao-linked-sessions-more")?.textContent).toBe("+2");
	});

	it("preserves script-like labels and line separators", () => {
		const label = "Issue </script> \u2028 title";
		const url = "ao://sessions/project/</script>\u2028session";
		evaluatePill([{ label, url }]);

		const button = document.getElementById(MULTICA_LINKED_SESSIONS_PILL_ID)?.shadowRoot?.querySelector("button");
		expect(button?.textContent).toBe(`AO · ${label}`);
		expect(button?.getAttribute("title")).toBe(`Open AO session ${label}`);
	});
});
