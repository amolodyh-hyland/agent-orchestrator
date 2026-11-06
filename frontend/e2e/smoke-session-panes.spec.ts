import { expect, test } from "@playwright/test";

// Renderer smoke with the existing dev:web fixture; no real daemon or PTY.
test.afterEach(async ({ page }, info) => {
	if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath("session-panes-failure.png") });
});
test("renderer: selected sessions split, resize, persist and close @T0 @PANES", async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.addInitScript(() => {
		localStorage.setItem("ao.topbarTabs.v1", JSON.stringify({
			version: 1,
			groups: [{
				id: "ao-demo", collapsed: false,
				head: { sessionId: "ao-demo-orchestrator", mode: "persistent", lastActiveAt: 0 },
				tabs: ["demo-working", "demo-needs-input"].map((sessionId) => ({ sessionId, mode: "persistent", lastActiveAt: 0 })),
			}],
		}));
	});
	await page.goto("/#/projects/ao-demo/sessions/demo-working");
	await expect(page.getByTestId("session-detail")).toBeVisible();
	const firstTab = page.locator('[data-testid="topbar-tab"][data-session-id="demo-working"]');
	const secondTab = page.locator('[data-testid="topbar-tab"][data-session-id="demo-needs-input"]');
	await firstTab.getByRole("tab").click();
	await secondTab.getByRole("tab").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
	await expect(firstTab).toHaveAttribute("data-selected", "true");
	await expect(secondTab).toHaveAttribute("data-selected", "true");
	await secondTab.click({ button: "right" });
	await page.getByRole("menuitem", { name: "View split panes" }).click();
	const panes = page.locator("[data-session-pane]");
	await expect(panes).toHaveCount(2);
	await expect(panes.nth(0).getByTestId("session-detail")).toBeVisible();
	await expect(panes.nth(1).getByTestId("session-detail")).toBeVisible();
	await panes.nth(1).locator("div").first().click();
	await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
	await expect(page).toHaveURL(/demo-needs-input$/);
	const divider = page.getByRole("separator", { name: "Resize panes" });
	const before = await divider.getAttribute("aria-valuenow");
	await divider.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(divider).not.toHaveAttribute("aria-valuenow", before!);
	const sizes = await page.evaluate(() => JSON.parse(sessionStorage.getItem("ao.sessionPanes.v1")!).sizes);
	await page.reload();
	await expect(panes).toHaveCount(2);
	await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("ao.sessionPanes.v1")!).sizes)).toEqual(sizes);
	await panes.nth(1).getByRole("button", { name: "Close pane", exact: true }).click();
	await expect(page.getByTestId("session-panes")).toHaveCount(0);
	await expect(page.getByTestId("session-detail")).toBeVisible();
});

test("renderer: new panes retain existing views and enforce the pane limit @T0 @PANES", async ({ page }) => {
	await page.setViewportSize({ width: 1800, height: 1000 });
	await page.goto("/#/projects/ao-demo/sessions/demo-working");
	await expect(page.getByTestId("session-detail")).toBeVisible();
	const tab = page.locator('[data-testid="topbar-tab"][data-session-id="demo-working"]').first();
	await tab.getByRole("button", { name: "Tab options" }).click();
	await page.getByRole("menuitem", { name: "New pane to the right" }).click();
	const panes = page.locator("[data-session-pane]");
	await expect(panes).toHaveCount(2);
	await expect(page.locator('[role="menu"]')).toHaveCount(0);
	await expect(panes.nth(1).getByTestId("session-terminal")).toBeVisible();
	await panes.nth(0).getByTestId("session-detail").evaluate((element) => { element.dataset.retained = "yes"; });
	for (const count of [3, 4]) {
		await panes.nth(0).locator('[data-testid="topbar-tab"][data-session-id="demo-working"]').getByRole("button", { name: "Tab options" }).click();
		await page.getByRole("menuitem", { name: "New pane to the right" }).click();
		await expect(panes).toHaveCount(count);
		await expect(page.locator('[role="menu"]')).toHaveCount(0);
		await expect(panes.nth(0).getByTestId("session-detail")).toHaveAttribute("data-retained", "yes");
	}
	await panes.nth(0).locator('[data-testid="topbar-tab"][data-session-id="demo-working"]').click({ button: "right" });
	await expect(page.getByRole("menuitem", { name: "New pane to the right" })).toHaveAttribute("aria-disabled", "true");
	await page.keyboard.press("Escape");
	await expect(panes.nth(0).locator('[data-testid="topbar-tab"][data-selected="true"]')).toHaveCount(0);
});
