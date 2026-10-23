import { expect, test } from "@playwright/test";
import { installFakeAgent } from "./support/fake-bridge";

test("cockpit refresh, source board mounts and reload remain observational @T0", async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
	const mutations: string[] = [];
	const forbidden: string[] = [];
	const workspaceReads: string[] = [];
	const projects = [
		{ id: "a", name: "Alpha", path: "/repos/a", kind: "single_repo", config: {} },
		{ id: "b", name: "Beta", path: "/repos/b", kind: "single_repo", config: {} },
		{ id: "c", name: "Gamma", path: "/repos/c", kind: "single_repo", config: {} },
	];
	await installFakeAgent(page, { projectId: "a", projectName: "Alpha", workers: [] });
	await page.addInitScript(() => {
		window.localStorage.setItem("ao.sidebar.expanded-projects", JSON.stringify(["a", "b", "c"]));
		type Source = { snapshot: () => Array<Record<string, unknown>> };
		const target = window as unknown as { __aoFakeAgent?: Source };
		function extend(source: Source) {
			const original = source.snapshot.bind(source);
			source.snapshot = () => {
				const [a] = original();
				return [a, { ...a, id: "b", name: "Beta", sessions: [] }, {
					...a, id: "c", name: "Gamma", sessions: [{
						id: "c-stopped", workspaceId: "c", workspaceName: "Gamma", title: "Unselected stopped chat",
						kind: "worker", mode: "chat", provider: "codex", status: "exited", prs: [],
						activity: { state: "exited", lastActivityAt: "2026-10-23T00:00:00Z" },
					}],
				}];
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
		// Intercept every mutating request, regardless of host or endpoint.
		if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
			mutations.push(`${request.method()} ${url.pathname}`);
			return route.fulfill({ status: 403, json: {} });
		}
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
		if (url.port === "3001") { forbidden.push(request.url()); return route.abort(); }
		if (url.port !== "8080" && !url.pathname.startsWith("/api/")) return route.continue();
		if (url.pathname === "/api/v1/projects") {
			workspaceReads.push("projects");
			return route.fulfill({ json: { projects } });
		}
		if (url.pathname === "/api/v1/sessions") {
			workspaceReads.push(`sessions:${url.searchParams.get("readOnly")}`);
			return route.fulfill({ json: { sessions: [{
				id: "c-stopped", projectId: "c", displayName: "Unselected stopped chat", harness: "codex",
				kind: "worker", mode: "chat", status: "exited", isTerminated: false,
				activity: { state: "exited", lastActivityAt: "2026-10-23T00:00:00Z" },
			}] } });
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
	const hoverStoppedSession = async () => {
		await page.getByRole("button", { name: "Open Unselected stopped chat", exact: true }).hover();
		// Wait beyond both the conversation prefetch and provider warm-up delays.
		await page.waitForTimeout(450);
	};
	await page.goto("/#/cockpit", { waitUntil: "domcontentloaded" });
	await page.getByRole("checkbox", { name: "Alpha a" }).check();
	await page.getByRole("checkbox", { name: "Beta b" }).check();
	await expect(page.getByRole("checkbox", { name: "Gamma c" })).not.toBeChecked();
	await hoverStoppedSession();
	await expect(page.getByText("Claim from a", { exact: true })).toBeVisible();
	await expect(page.getByText("Claim from b", { exact: true })).toBeVisible();
	await expect(page.getByText("Coordinator missing. Nothing has been started.").first()).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("cockpit-dark.png"), fullPage: true });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
	await page.getByRole("region", { name: "Beta", exact: true }).getByRole("link", { name: "Project board" }).click();
	await expect(page).toHaveURL(/#\/projects\/b\?observation=true$/);
	await hoverStoppedSession();
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page).toHaveURL(/#\/projects\/b\?observation=true$/);
	await hoverStoppedSession();
	await expect(page.getByRole("button", { name: "Project cockpit", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Project cockpit", exact: true }).click();
	await expect(page).toHaveURL(/#\/cockpit$/);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByRole("checkbox", { name: "Alpha a" })).toBeChecked();
	await expect(page.getByText("Claim from b", { exact: true })).toBeVisible();
	await hoverStoppedSession();
	await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
	await page.locator('[data-slot="titlebar-nav"]').getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await page.setViewportSize({ width: 760, height: 800 });
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("cockpit-light.png"), fullPage: true });
	if (process.env.AO_E2E_REAL_RENDERER === "1") {
		// Proves this run used the API-backed renderer, with no preview-data bypass.
		expect(workspaceReads).toContain("projects");
		expect(workspaceReads).toContain("sessions:true");
	}
	expect(mutations).toEqual([]);
	expect(forbidden).toEqual([]);
});
