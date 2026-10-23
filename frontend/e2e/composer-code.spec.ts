import { expect, test, type Locator } from "@playwright/test";

async function selectVisibleText(field: Locator, start: number, end: number) {
	await field.focus();
	await field.evaluate(
		(root, offsets) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
				acceptNode(node) {
				const element = node.parentElement?.closest("[data-lexical-text]");
				return element && getComputedStyle(element).display !== "none"
						? NodeFilter.FILTER_ACCEPT
						: NodeFilter.FILTER_REJECT;
				},
			});
			const points: { node: Node; start: number; end: number }[] = [];
			let length = 0;
			while (walker.nextNode()) {
				const node = walker.currentNode;
				points.push({ node, start: length, end: length + node.textContent!.length });
				length += node.textContent!.length;
			}
			const range = document.createRange();
			for (const [index, offset] of offsets.entries()) {
				const point = points.find((point) => offset >= point.start && offset <= point.end)!;
				if (index === 0) range.setStart(point.node, offset - point.start);
				else range.setEnd(point.node, offset - point.start);
			}
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
		},
		[start, end],
	);
}

test("native replacement across a code boundary keeps the remaining code and undoes in one step", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const source = "A `abcd` Z";
	await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await expect(field).toHaveJSProperty("innerText", "A abcd Z");
	await selectVisibleText(field, 0, 4);
	await field.pressSequentially("X");
	await expect(page.getByTestId("wire")).toHaveText("X`cd` Z");
	await expect(field).toHaveJSProperty("innerText", "Xcd Z");
	await field.press("ControlOrMeta+z");
	await expect(page.getByTestId("wire")).toHaveText(source);
	await field.press("ControlOrMeta+Shift+z");
	await expect(page.getByTestId("wire")).toHaveText("X`cd` Z");
	await field.press("ControlOrMeta+z");
	await expect(page.getByTestId("wire")).toHaveText(source);
	await selectVisibleText(field, 0, 4);
	await page.evaluate(() => navigator.clipboard.writeText("pasted"));
	await field.press("ControlOrMeta+v");
	await expect(page.getByTestId("wire")).toHaveText("pasted`cd` Z");
	await expect(field).toHaveJSProperty("innerText", "pastedcd Z");
	await field.press("ControlOrMeta+z");
	await expect(page.getByTestId("wire")).toHaveText(source);
	await selectVisibleText(field, 0, 4);
	await field.press("ControlOrMeta+x");
	await expect(page.getByTestId("wire")).toHaveText("`cd` Z");
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("A `ab`");
	await expect(field).toHaveJSProperty("innerText", "cd Z");
});

test("ordinary native typing in a draft with code has no presentation-only undo step", async ({ page }) => {
	const source = "A `abcd` Z";
	await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
	const field = page.getByRole("combobox", { name: "Message", exact: true });
	await expect(field).toHaveJSProperty("innerText", "A abcd Z");
	await selectVisibleText(field, 1, 1);
	await field.pressSequentially("xyz");
	await expect(page.getByTestId("wire")).toHaveText("Axyz `abcd` Z");
	await field.press("ControlOrMeta+z");
	await expect(page.getByTestId("wire")).toHaveText(source);
});

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
