import { expect, test } from "@playwright/test";
import { installFakeAgent } from "./support/fake-bridge";

test("cockpit refresh, source board mounts and reload remain observational @T0", async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
	const mutations: string[] = [];
	const forbidden: string[] = [];
	await installFakeAgent(page, { projectId: "a", projectName: "Alpha", workers: [] });
	await page.addInitScript(() => {
		type Source = { snapshot: () => Array<Record<string, unknown>> };
		const target = window as unknown as { __aoFakeAgent?: Source };
		function extend(source: Source) {
			const original = source.snapshot.bind(source);
			source.snapshot = () => {
				const [a] = original();
				return [a, { ...a, id: "b", name: "Beta", sessions: [] }];
			};
		}
		let source = target.__aoFakeAgent;
		if (source) extend(source);
		Object.defineProperty(target, "__aoFakeAgent", {
			configurable: true,
			get: () => source,
			set: (next: Source) => { source = next; extend(next); },
		});
	});
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
		if (url.port === "3001") { forbidden.push(request.url()); return route.abort(); }
		if (url.port !== "8080" && !url.pathname.startsWith("/api/")) return route.continue();
		if (request.method() !== "GET") {
			mutations.push(`${request.method()} ${url.pathname}`);
			return route.fulfill({ status: 403, json: {} });
		}
		if (/ensure|restore|resume|spawn|send|conversation/.test(url.pathname)) forbidden.push(url.pathname);
		if (/^\/api\/v1\/projects\/[ab]$/.test(url.pathname)) {
			const id = url.pathname.split("/").at(-1);
			return route.fulfill({ json: { status: "ok", project: { id, name: id === "a" ? "Alpha" : "Beta", path: `/repos/${id}`, kind: "single_repo", config: {} } } });
		}
		if (url.pathname === "/api/v1/reports") {
			const projectId = url.searchParams.get("projectId");
			return route.fulfill({ json: { reports: [{ id: `r-${projectId}`, projectId, sessionId: `${projectId}-1`, state: "done", note: `Claim from ${projectId}`, createdAt: "2026-10-23T00:00:00Z", repeatCount: 1 }] } });
		}
		return route.fulfill({ json: { status: "ok", plans: [], agents: [], notifications: [], unreadCount: 0, hosts: [], jobs: [], rules: [], projects: [], sessions: [], settings: {} } });
	});
	await page.goto("/#/cockpit", { waitUntil: "domcontentloaded" });
	await page.getByRole("checkbox", { name: "Alpha a" }).check();
	await page.getByRole("checkbox", { name: "Beta b" }).check();
	await expect(page.getByText("Claim from a", { exact: true })).toBeVisible();
	await expect(page.getByText("Claim from b", { exact: true })).toBeVisible();
	await expect(page.getByText("Coordinator missing. Nothing has been started.")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("cockpit-dark.png"), fullPage: true });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
	await page.getByRole("region", { name: "Beta", exact: true }).getByRole("link", { name: "Project board" }).click();
	await expect(page).toHaveURL(/#\/projects\/b\?observation=true$/);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page).toHaveURL(/#\/projects\/b\?observation=true$/);
	await expect(page.getByRole("button", { name: "Project cockpit", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Project cockpit", exact: true }).click();
	await expect(page).toHaveURL(/#\/cockpit$/);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByRole("checkbox", { name: "Alpha a" })).toBeChecked();
	await expect(page.getByText("Claim from b", { exact: true })).toBeVisible();
	await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
	await page.locator('[data-slot="titlebar-nav"]').getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await page.setViewportSize({ width: 760, height: 800 });
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("cockpit-light.png"), fullPage: true });
	expect(mutations).toEqual([]);
	expect(forbidden).toEqual([]);
});
