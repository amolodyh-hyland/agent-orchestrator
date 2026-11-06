import { afterEach, expect, it, vi } from "vitest";
import { openComposerModelPicker, toggleComposerDictation } from "./composer-shortcuts";

afterEach(() => document.body.replaceChildren());

it("routes composer commands to the focused pane", () => {
	const first = document.createElement("section");
	const second = document.createElement("section");
	first.dataset.sessionPane = "a";
	first.dataset.focused = "false";
	second.dataset.sessionPane = "b";
	second.dataset.focused = "true";
	for (const root of [first, second]) {
		root.innerHTML = '<button data-shortcut-target="model-picker"></button><button data-shortcut-target="dictate"></button>';
		document.body.append(root);
	}
	const firstPicker = vi.fn();
	const secondPicker = vi.fn();
	const firstDictate = vi.fn();
	const secondDictate = vi.fn();
	first.children[0].addEventListener("keydown", firstPicker);
	second.children[0].addEventListener("keydown", secondPicker);
	first.children[1].addEventListener("click", firstDictate);
	second.children[1].addEventListener("click", secondDictate);
	openComposerModelPicker();
	toggleComposerDictation();
	expect(firstPicker).not.toHaveBeenCalled();
	expect(firstDictate).not.toHaveBeenCalled();
	expect(secondPicker).toHaveBeenCalledOnce();
	expect(secondDictate).toHaveBeenCalledOnce();
});
