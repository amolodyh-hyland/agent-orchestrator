import { expect, type Page } from "@playwright/test";

export async function openSwitchAgentDialog(page: Page) {
	const activeTab = page.getByTestId("topbar-tabs").locator('[data-testid="topbar-tab"][data-active="true"]');
	await activeTab.getByRole("button", { name: "Tab options", exact: true }).click();
	const switchAgent = page.getByRole("menuitem", { name: "Switch agent", exact: true });
	await expect(switchAgent).toBeVisible();
	await switchAgent.click();
	const dialog = page.getByRole("dialog", { name: "Switch agent" });
	await expect(dialog).toBeVisible();
	return dialog;
}
