import type { BrowserRect } from "../../main/browser-view-host";

// Keep the shell tint clear over every visible native page, including concurrent session panes.
const browserHoles = new Map<string, BrowserRect>();

export function publishBrowserHole(viewId: string, rect: BrowserRect | null): void {
	const root = document.documentElement;
	if (rect && root.dataset.windowTranslucent === "true") browserHoles.set(viewId, rect);
	else browserHoles.delete(viewId);
	if (browserHoles.size) root.dataset.browserHole = "true";
	else delete root.dataset.browserHole;
	const shell = document.querySelector<HTMLElement>(".app-shell-root");
	if (!shell) return;
	if (!browserHoles.size) {
		shell.style.removeProperty("--browser-hole-mask");
		return;
	}
	// Union the hole layers first, then exclude that union from the full tint plate.
	// Non-inheriting storage on the shell keeps animated bounds from restyling the app.
	const holes = [...browserHoles.values()].map(({ x, y, width, height }) =>
		`linear-gradient(#000 0 0) ${x}px ${y}px / ${width}px ${height}px no-repeat add`);
	shell.style.setProperty("--browser-hole-mask", ["linear-gradient(#000 0 0) 0 0 / 100% 100% no-repeat exclude", ...holes].join(", "));
}

