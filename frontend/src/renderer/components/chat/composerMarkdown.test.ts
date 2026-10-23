import { describe, expect, it } from "vitest";
import {
	composerCodeRegions,
	createComposerMarkdownRangeCursor,
	isComposerCodeFenceAt,
	isComposerOpenCodeFenceAt,
	parseComposerMarkdown,
} from "./composerMarkdown";

describe("composer code content boundaries", () => {
	it.each([
		["before ``a ` b`` after", "a ` b", undefined],
		["```ts\nvalue\n```", "value", "ts"],
		["  ````custom info\r\nfirst\r\n\r\n`````  ", "first\r\n", "custom info"],
		["```\n\n```", "", ""],
		["```\n", "", ""],
		["```python\nvalue", "value", "python"],
	])("separates hidden syntax from content without normalizing source: %s", (source, content, language) => {
		const [region] = composerCodeRegions(source);
		expect(source.slice(region.contentStart, region.contentEnd)).toBe(content);
		expect(region.language).toBe(language);
		expect(source.slice(0, region.contentStart) + content + source.slice(region.contentEnd)).toBe(source);
	});
});

describe("parseComposerMarkdown", () => {
	it("recognizes a closed inline span and leaves an incomplete span plain", () => {
		expect(parseComposerMarkdown("run `value`").inlineCode).toEqual([
			{ start: 4, end: 11, kind: "inline" },
		]);
		expect(parseComposerMarkdown("run `value").codeRanges).toEqual([]);
	});

	it("keeps a same-line triple-backtick span inline instead of opening a fence", () => {
		const text = "```inline```";
		const analysis = parseComposerMarkdown(text);

		expect(analysis.fencedCode).toEqual([]);
		expect(analysis.inlineCode).toEqual([
			{ start: 0, end: text.length, kind: "inline" },
		]);
		expect(isComposerOpenCodeFenceAt(text, text.length)).toBe(false);
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

	it("maps 10,000 inline spans with work bounded by the number of spans and text parts", () => {
		const spanCount = 10_000;
		const draft = "x`a`".repeat(spanCount);
		let rangePropertyReads = 0;
		const ranges = parseComposerMarkdown(draft).codeRanges.map((range) => new Proxy(range, {
			get(target, property, receiver) {
				if (property === "start" || property === "end") rangePropertyReads += 1;
				return Reflect.get(target, property, receiver);
			},
		}));
		const cursor = createComposerMarkdownRangeCursor(ranges);
		const boundaries = [0, ...cursor.splitOffsets(0, draft.length), draft.length];
		let mappedSpanCount = 0;
		let textPartCount = 0;

		for (let index = 0; index < boundaries.length - 1; index += 1) {
			const start = boundaries[index];
			const end = boundaries[index + 1];
			if (cursor.coveringRange(start, end)) mappedSpanCount += 1;
			textPartCount += 1;
			cursor.advanceTo(end);
		}

		expect(draft.length).toBe(40_000);
		expect(ranges).toHaveLength(spanCount);
		expect(mappedSpanCount).toBe(spanCount);
		expect(rangePropertyReads).toBeLessThanOrEqual(
			8 * (ranges.length + textPartCount),
		);
	});
});
