/**
 * ⌘⇧M: opens the chat composer's model menu, on a session's chat and on the new
 * chat page alike. Closing the menu hands focus back to the composer
 * (TurnSettingsBar's restoreComposerFocus reads the mark set here).
 */
export function openComposerModelPicker(): void {
	const picker = document.querySelector<HTMLElement>("[data-shortcut-target='model-picker']:not([disabled])");
	if (!picker) return;
	// Radix menu triggers open on pointerdown or Enter, never on a synthetic click.
	picker.dataset.shortcutOpened = "";
	picker.focus();
	picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

/** Dictate (⌥D on macOS): starts or finishes dictation in the focused chat composer, else the first one on screen. */
export function toggleComposerDictation(): void {
	const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-shortcut-target='dictate']:not([disabled])")).filter((button) => {
		for (let node: HTMLElement | null = button; node; node = node.parentElement) {
			if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
			const style = getComputedStyle(node);
			if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
		}
		return true;
	});
	const active = document.activeElement;
	(buttons.find((button) => active && button.closest("form")?.contains(active)) ?? buttons[0])?.click();
}
