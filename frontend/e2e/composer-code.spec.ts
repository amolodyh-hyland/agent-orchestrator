import { expect, test } from "@playwright/test";

test("an empty formatted block accepts native typing between its hidden fences", async ({ page }) => {
	await page.goto("/e2e/composer-code/harness.html?text=");
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await field.click();
	await page.getByRole("button", { name: "Code block", exact: true }).click();
	await expect(field.locator(".chat-composer-code-block")).toBeVisible();
	await field.pressSequentially("hello");
	await expect(page.getByTestId("wire")).toHaveText("```\nhello\n```");
});

test("typing an open fence keeps Enter as code input until the closing fence", async ({ page }) => {
	await page.goto("/e2e/composer-code/harness.html?text=");
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await field.click();
	await field.pressSequentially("```ts");
	await field.press("Enter");
	await expect(page.getByTestId("sent")).toBeEmpty();
	await field.pressSequentially("const value = 1;");
	await field.press("Enter");
	await field.pressSequentially("```");
	await expect(page.getByTestId("wire")).toHaveText("```ts\nconst value = 1;\n```");
	await field.press("Enter");
	await expect(page.getByTestId("sent")).toHaveText("```ts\nconst value = 1;\n```");
});

test("code markers stay hidden while native typing and code-edge deletion preserve Markdown", async ({ page }) => {
	await page.goto("/e2e/composer-code/harness.html?text=");
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await field.click();
	await field.pressSequentially("run `value`");
	await expect(page.getByTestId("wire")).toHaveText("run `value`");
	await expect(field.locator(".chat-composer-inline-code")).toHaveText("`value`");
	await expect(field).toHaveJSProperty("innerText", "run value");
	await field.press("ArrowLeft");
	await field.press("Backspace");
	await expect(page.getByTestId("wire")).toHaveText("run `valu`");
	for (let index = 0; index < 4; index += 1) await field.press("ArrowLeft");
	await field.press("Backspace");
	await expect(page.getByTestId("wire")).toHaveText("run valu");
});

test("block controls preserve the source and keep their keyboard events out of the editor", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					(window as unknown as { copiedCode: string }).copiedCode = text;
				},
			},
		});
	});
	const source = "```custom\n" + "line\n".repeat(24) + "```";
	await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await expect(field.locator('[style="display: none;"]')).toHaveCount(2);
	const language = page.getByRole("combobox", { name: "Code language" });
	await language.focus();
	await language.press("Enter");
	await page.getByRole("option", { name: "custom", exact: true }).press("Escape");
	await expect(page.getByTestId("sent")).toBeEmpty();
	await language.click();
	await page.getByRole("option", { name: "python", exact: true }).click();
	await expect(page.getByTestId("wire")).toHaveText(source.replace("custom", "python"));
	await page.getByRole("button", { name: "Copy code" }).press("Enter");
	await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { copiedCode: string }).copiedCode)).toBe(
		"line\n".repeat(24).slice(0, -1),
	);
	await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
	await page.getByRole("button", { name: "Show more" }).press("Enter");
	await expect(field.locator(".chat-composer-code-body")).toHaveCSS("max-height", "none");
	await page.getByRole("button", { name: "Show less" }).press("Space");
	await expect(field.locator(".chat-composer-code-body")).toHaveCSS("max-height", "160px");
	await expect(page.getByTestId("sent")).toBeEmpty();
	await field.click();
	await field.press("ControlOrMeta+End");
	await field.press("Enter");
	await expect(page.getByTestId("sent")).toHaveText(source.replace("custom", "python"));
});
