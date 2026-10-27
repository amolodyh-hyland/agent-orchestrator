import { expect, test, type Locator } from "@playwright/test";

async function selectVisibleText(field: Locator, start: number, end: number, endAtNextText = false) {
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
			for (const [index, offset] of offsets.positions.entries()) {
				const point = points.find(
					(point) =>
						offset >= point.start &&
						(offset < point.end || (!(index === 1 && offsets.endAtNextText) && offset === point.end)),
				)!;
				if (index === 0) range.setStart(point.node, offset - point.start);
				else range.setEnd(point.node, offset - point.start);
			}
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
		},
		{ positions: [start, end], endAtNextText },
	);
}

for (const edge of ["start", "end"] as const) {
	for (const shift of [false, true]) {
		test(`inline code ${edge} has an outside caret with ${shift ? "Shift+arrow" : "arrow"}`, async ({ page }) => {
			await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent("`value`"));
			const field = page.getByRole("combobox", { name: "Message", exact: true });
			await expect(field).toHaveJSProperty("innerText", "value");
			const offset = edge === "start" ? 0 : 5;
			const exit = edge === "start" ? "ArrowLeft" : "ArrowRight";
			const enter = edge === "start" ? "ArrowRight" : "ArrowLeft";
			await selectVisibleText(field, offset, offset);
			await field.press(shift ? `Shift+${exit}` : exit);
			await field.press(shift ? `Shift+${enter}` : enter);
			await field.pressSequentially("I");
			await expect(page.getByTestId("wire")).toHaveText(edge === "start" ? "`Ivalue`" : "`valueI`");
			await selectVisibleText(field, edge === "start" ? 0 : 6, edge === "start" ? 0 : 6);
			await field.press(shift ? `Shift+${exit}` : exit);
			await field.pressSequentially("!");
			await expect(page.getByTestId("wire")).toHaveText(edge === "start" ? "!`Ivalue`" : "`valueI`!");
			await expect(field.locator(".chat-composer-inline-code")).toHaveText(edge === "start" ? "`Ivalue`" : "`valueI`");
			await expect(field.locator(".chat-composer-markdown-code").filter({ hasText: "!" })).toHaveCount(0);
		});
	}
}

for (const action of ["send", "clear"]) {
	test(`${action} from inline code starts the next draft as plain text`, async ({ page }) => {
		await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent("`value`"));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		await expect(field).toHaveJSProperty("innerText", "value");
		await selectVisibleText(field, 5, 5);
		if (action === "send") {
			await field.press("Enter");
			await expect(page.getByTestId("sent")).toHaveText("`value`");
		} else await page.getByRole("button", { name: "Clear", exact: true }).click();
		await expect(page.getByTestId("wire")).toBeEmpty();
		await field.pressSequentially("new draft");
		await expect(page.getByTestId("wire")).toHaveText("new draft");
		await expect(field.locator(".chat-composer-markdown-code, .chat-composer-inline-code")).toHaveCount(0);
		await field.press("Enter");
		await expect(page.getByTestId("sent")).toHaveText("new draft");
	});
}

for (const example of [
	{
		name: "after inline code",
		source: "A `abcd` Z",
		start: 6,
		end: 8,
		typed: "A `abcd`X",
		cut: "A `abcd`",
		copied: " Z",
	},
	{
		name: "before inline code",
		source: "A `abcd` Z",
		start: 0,
		end: 2,
		typed: "X`abcd` Z",
		cut: "`abcd` Z",
		copied: "A ",
		endAtNextText: true,
	},
	{
		name: "after fenced code",
		source: "A\n```ts\nabcd\n```\nZ",
		start: 5,
		end: 6,
		typed: "A\n```ts\nabcd\n```\nX",
		cut: "A\n```ts\nabcd\n```",
		copied: "\nZ",
	},
	{
		name: "before fenced code",
		source: "A\n```ts\nabcd\n```\nZ",
		start: 0,
		end: 1,
		typed: "X\n```ts\nabcd\n```\nZ",
		cut: "```ts\nabcd\n```\nZ",
		copied: "A\n",
		endAtNextText: true,
	},
]) {
	test(`native typing, paste and cut at the exact edge ${example.name} keep the markers`, async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(example.source));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		await expect(page.getByTestId("wire")).toHaveText(example.source);
		for (const action of ["type", "paste", "cut"]) {
			await selectVisibleText(field, example.start, example.end, example.endAtNextText);
			if (action === "type") await field.pressSequentially("X");
			else if (action === "paste") {
				await page.evaluate(() => navigator.clipboard.writeText("X"));
				await field.press("ControlOrMeta+v");
			} else await field.press("ControlOrMeta+x");
			await expect(page.getByTestId("wire")).toHaveText(action === "cut" ? example.cut : example.typed);
			await expect(field.locator(".chat-composer-inline-code, .chat-composer-code-block")).toHaveCount(1);
			if (action === "cut")
				await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(example.copied);
			await field.press("ControlOrMeta+z");
			await expect(page.getByTestId("wire")).toHaveText(example.source);
		}
	});
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

for (const source of ["`value`", "```ts\nvalue\n```"]) {
	for (const edge of [0, 5]) {
		test(`native Space stays in code at ${edge}: ${JSON.stringify(source)}`, async ({ page }) => {
			await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
			const field = page.getByRole("combobox", { name: "Message", exact: true });
			await expect(page.getByTestId("wire")).toHaveText(source);
			await selectVisibleText(field, edge, edge);
			await field.pressSequentially(" X");
			const offset = source.indexOf("value") + edge;
			await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", source.slice(0, offset) + " X" + source.slice(offset));
			await expect(field.locator(".chat-composer-markdown-code").filter({ hasText: "X" })).toHaveCount(1);
		});
	}
}

for (const example of [
	{ source: "`value`", offset: 2, key: "Tab", expected: "`value`!" },
	{ source: "```ts\nvalue\n```", offset: 2, key: "Tab", expected: "```ts\nvalue\n```\n!" },
	{ source: "```ts\nvalue\n```", offset: 0, key: "ArrowUp", expected: "!\n```ts\nvalue\n```" },
	{ source: "```ts\nvalue\n```", offset: 5, key: "ArrowDown", expected: "```ts\nvalue\n```\n!" },
]) {
	test(`native ${example.key} leaves code for plain typing: ${JSON.stringify(example.source)}`, async ({ page }) => {
		await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(example.source));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		await expect(page.getByTestId("wire")).toHaveText(example.source);
		await selectVisibleText(field, example.offset, example.offset);
		await field.press(example.key);
		await expect(field).toBeFocused();
		await field.pressSequentially("!");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", example.expected);
		await expect(field.locator(".chat-composer-markdown-code").filter({ hasText: "!" })).toHaveCount(0);
	});
}


for (const source of ["`@src`", "```ts\n@src\n```"]) {
	test(`an OPEN completion popup owns arrows and Tab inside code: ${JSON.stringify(source)}`, async ({ page }) => {
		await page.goto("/e2e/composer-code/harness.html?popup=1&text=" + encodeURIComponent(source));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		const first = page.getByRole("option", { name: "src/first.ts" });
		const second = page.getByRole("option", { name: "src/second.ts" });
		await expect(page.getByRole("listbox", { name: "Files" })).toBeVisible();
		await selectVisibleText(field, 4, 4);
		await field.press("ArrowUp");
		await expect(second).toHaveAttribute("aria-selected", "true");
		await field.press("ArrowDown");
		await expect(first).toHaveAttribute("aria-selected", "true");
		await field.press("ArrowDown");
		await expect(second).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", source);
		await field.press("Tab");
		await expect(field.locator('[data-composer-token="file"]')).toHaveAttribute("data-value", "src/second.ts");
		await expect(page.getByRole("listbox")).toHaveCount(0);
		await expect(field).toBeFocused();
	});
}

for (const example of [
	{ key: "Tab", offset: 2 },
	{ key: "ArrowDown", offset: 5 },
	{ key: "ArrowUp", offset: 6 },
]) {
	test(`native ${example.key} between adjacent blocks keeps sent Markdown and undo balanced`, async ({ page }) => {
		const source = "```ts\nfirst\n```\n```js\nsecond\n```";
		const separated = "```ts\nfirst\n```\n\n```js\nsecond\n```";
		const expected = "```ts\nfirst\n```\n!\n```js\nsecond\n```";
		await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		await expect(field.locator(".chat-composer-code-block")).toHaveCount(2);
		await selectVisibleText(field, example.offset, example.offset);
		await field.press(example.key);
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", separated);
		await field.pressSequentially("!");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", expected);
		await expect(field.locator(".chat-composer-code-block")).toHaveCount(2);
		await field.press("ControlOrMeta+z");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", separated);
		await field.press("ControlOrMeta+z");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", source);
		await expect(field.locator(".chat-composer-code-block")).toHaveCount(2);
		await field.press("ControlOrMeta+Shift+z");
		await field.press("ControlOrMeta+Shift+z");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", expected);
		await field.press("Enter");
		await expect(page.getByTestId("sent")).toHaveJSProperty("textContent", expected);
	});
}

for (const source of ["```\n", "```\nvalue\n", "```\nvalue\n\n"]) {
	test(`Tab exits from the empty final line of an open fence: ${JSON.stringify(source)}`, async ({ page }) => {
		await page.goto("/e2e/composer-code/harness.html?text=" + encodeURIComponent(source));
		const field = page.getByRole("combobox", { name: "Message", exact: true });
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", source);
		await field.press("Tab");
		await expect(field).toBeFocused();
		await field.pressSequentially("!");
		await expect(page.getByTestId("wire")).toHaveJSProperty("textContent", source + "\n```\n!");
	});
}
