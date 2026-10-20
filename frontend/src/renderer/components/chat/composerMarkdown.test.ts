import { describe, expect, it } from "vitest";
import {
	isComposerCodeFenceAt,
	isComposerOpenCodeFenceAt,
	parseComposerMarkdown,
} from "./composerMarkdown";

describe("parseComposerMarkdown", () => {
	it("recognizes a closed inline span and leaves an incomplete span plain", () => {
		expect(parseComposerMarkdown("run `value`").inlineCode).toEqual([
			{ start: 4, end: 11, kind: "inline" },
		]);
		expect(parseComposerMarkdown("run `value").codeRanges).toEqual([]);
	});

	it("matches equal backtick runs and ignores escaped delimiters", () => {
		const tick = "`";
		const doubleTick = tick.repeat(2);
		const text = `run \\${tick}literal\\${tick} and ${doubleTick}value ${tick} with tick${doubleTick}`;

		expect(parseComposerMarkdown(text).inlineCode).toEqual([
			{
				start: text.indexOf(`${doubleTick}value`),
				end: text.lastIndexOf(doubleTick) + doubleTick.length,
				kind: "inline",
			},
		]);
	});

	it("styles a language-tagged fence and does not reprocess its backticks as inline code", () => {
		const text = "before `inline`\n```ts\nconst value = `inside`;\n```\nafter `again`";
		const analysis = parseComposerMarkdown(text);

		expect(analysis.fencedCode).toEqual([
			{
				start: text.indexOf("```ts"),
				end: text.indexOf("\n```", text.indexOf("```ts")) + 4,
				kind: "fenced",
			},
		]);
		expect(analysis.inlineCode).toEqual([
			{
				start: text.indexOf("`inline`"),
				end: text.indexOf("`inline`") + "`inline`".length,
				kind: "inline",
			},
			{
				start: text.indexOf("`again`"),
				end: text.indexOf("`again`") + "`again`".length,
				kind: "inline",
			},
		]);
	});

	it("recognizes fenced blocks and following inline code in CRLF Markdown", () => {
		const text = "before\r\n```ts\r\nconst value = `inside`;\r\n```\r\nafter `again`";
		const analysis = parseComposerMarkdown(text);

		expect(analysis.fencedCode).toEqual([
			{
				start: text.indexOf("```ts"),
				end: text.indexOf("```\r\n") + "```\r".length,
				kind: "fenced",
			},
		]);
		expect(analysis.inlineCode).toHaveLength(1);
		expect(text.slice(analysis.inlineCode[0].start, analysis.inlineCode[0].end)).toBe("`again`");
	});

	it("activates an open fence only after its opening line is followed by a newline", () => {
		const opening = "```tsx";
		const openBlock = `${opening}\nconst App = () => `;

		expect(parseComposerMarkdown(opening).fencedCode).toEqual([]);
		expect(isComposerCodeFenceAt(opening, opening.length)).toBe(true);
		expect(parseComposerMarkdown(openBlock).fencedCode).toEqual([
			{ start: 0, end: openBlock.length, kind: "fenced" },
		]);
		expect(parseComposerMarkdown(openBlock).inlineCode).toEqual([]);
		expect(isComposerCodeFenceAt(openBlock, openBlock.length)).toBe(true);
	});

	it("stops treating Enter as code input after a matching closing fence", () => {
		const text = "```ts\nconst value = 1;\n```\nprose";
		const closingFence = text.indexOf("\n```") + 1;

		expect(isComposerCodeFenceAt(text, text.indexOf("const"))).toBe(true);
		expect(isComposerOpenCodeFenceAt(text, text.indexOf("const"))).toBe(false);
		expect(isComposerCodeFenceAt(text, closingFence)).toBe(false);
		expect(isComposerCodeFenceAt(text, text.length)).toBe(false);
	});
});
