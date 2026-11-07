import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// Exercise the shared native-page mask in Chromium without launching native views.
test("renderer: native Browser holes compose, overlap, resize and remove @T0 @PANES", async ({ page }) => {
	const css = readFileSync("src/renderer/styles.css", "utf8");
	const maskCSS = css.slice(css.indexOf("/* Native pages sit below the shell."), css.indexOf("/* Nightly build-info"));
	await page.route("**/__browser-mask-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }));
	await page.goto("/__browser-mask-fixture");
	await page.setViewportSize({ width: 1000, height: 400 });
	await page.addStyleTag({ content: `${maskCSS}
		body { margin: 0; background: white; }
		.plate { width: 480px; height: 300px; position: relative; background: rgb(0, 0, 255); }
		.app-shell-root::before { content: ""; position: absolute; inset: 0; background: rgb(255, 0, 0); }
		#reference { background: rgb(255, 0, 0); }
		#reference > div { position: absolute; background: rgb(0, 0, 255); }
	` });
	await page.evaluate(() => {
		document.documentElement.dataset.windowTranslucent = "true";
		document.body.innerHTML = '<div class="plate app-shell-root"><div class="browser-panel" data-browser-native-page="live"></div></div><div class="plate" id="reference"></div>';
	});
	const rects = [
		{ x: 10, y: 20, width: 100, height: 80 },
		{ x: 140, y: 20, width: 100, height: 80 },
		{ x: 270, y: 20, width: 100, height: 80 },
		{ x: 320, y: 60, width: 100, height: 80 },
	];
	const check = async (visible: typeof rects) => {
		await page.evaluate(async (rectangles) => {
			// Vite serves the production composition boundary; no copied mask generator.
			const { publishBrowserHole } = await import(/* @vite-ignore */ "/src/renderer/lib/browser-hole-mask.ts");
			for (let index = 0; index < 4; index++) publishBrowserHole(`fixture-${index}`, rectangles[index] ?? null);
			const reference = document.getElementById("reference")!;
			reference.replaceChildren(...rectangles.map(({ x, y, width, height }) => {
				const hole = document.createElement("div");
				Object.assign(hole.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
				return hole;
			}));
		}, visible);
		expect(await page.locator(".app-shell-root").screenshot()).toEqual(await page.locator("#reference").screenshot());
	};
	await check(rects.slice(0, 2));
	await check(rects);
	await check([{ ...rects[0], width: 180 }, ...rects.slice(1)]);
	await check(rects.slice(1));
	await check([]);
});
