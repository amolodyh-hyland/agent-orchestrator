import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { expect, it } from "vitest";
import { addressDisplay, addressFilePath, addressName, findChatAddresses, remarkChatAddresses } from "./chat-address";

it.each([
	["See https://example.test/a_(b)?q=%2F#c.", "https://example.test/a_(b)?q=%2F#c"],
	["(https://example.test/a_(b)).", "https://example.test/a_(b)"],
	['Open "C:\\Project Files\\résumé.txt" please', "C:\\Project Files\\résumé.txt"],
	['Open "\\\\server\\Team Files\\資料" please', "\\\\server\\Team Files\\資料"],
	['Open "/Users/Alex/My Files/résumé.txt" please', "/Users/Alex/My Files/résumé.txt"],
	["Open ~/Documents/file.txt now", "~/Documents/file.txt"],
	["Open file://server/share/My%20Files/a%2520.txt now", "file://server/share/My%20Files/a%2520.txt"],
	["Open file:///C:/Project/file.txt now", "file:///C:/Project/file.txt"],
	["C:\\Project Files\\résumé.txt", "C:\\Project Files\\résumé.txt"],
	["/Users/Alex/My Files/résumé.txt", "/Users/Alex/My Files/résumé.txt"],
	['Open "/tmp" please', "/tmp"],
])("recognizes a target without rewriting its source: %s", (source, target) => {
	const matches = findChatAddresses(source);
	expect(matches.map((match) => match.target)).toEqual([target]);
	expect(source.slice(matches[0].start, matches[0].end)).toBe(target);
});

it("skips authored links, inline/fenced code, images, commands and ordinary prose", () => {
	expect(findChatAddresses('[My title](https://example.test/a) `https://example.test/b`\n```\nC:\\Files\\data.txt\n```\n![image](https://example.test/image) /help word/word')).toEqual([]);
});

it("uses existing context for relative and space-containing workspace paths", () => {
	const source = "Check src/My File.ts and src/other.ts please";
	expect(findChatAddresses(source, ["src/My File.ts", "src/other.ts"]).map((match) => match.target)).toEqual(["src/My File.ts", "src/other.ts"]);
	expect(findChatAddresses("unknown/file.txt")).toEqual([]);
});

it.each([
	["/tmp/one.txt", "/tmp/two.txt"],
	["C:\\work\\one.txt", "D:\\work\\two.txt"],
	["\\\\server\\share\\one.txt", "\\\\other\\share\\two.txt"],
])("keeps separate path targets and intervening prose: %s and %s", (first, second) => {
	const source = `${first} and ${second}`;
	const matches = findChatAddresses(source);
	expect(matches.map((match) => match.target)).toEqual([first, second]);
	expect(source.slice(matches[0].end, matches[1].start)).toBe(" and ");
	for (const match of matches) expect(source.slice(match.start, match.end)).toBe(match.target);
});

it("derives labels without changing authority or interpreting literal path escapes", () => {
	expect(addressName("https://example.test/a?q=1#b", "url")).toBe("example.test");
	expect(addressName("C:\\Project Files\\résumé.txt", "path")).toBe("résumé.txt");
	expect(addressName("\\\\server\\share\\folder\\", "path")).toBe("folder");
	expect(addressName("/tmp/a%20.txt", "path")).toBe("a%20.txt");
	expect(addressName("file://server/share/a%2520.txt", "path")).toBe("a%20.txt");
	for (const value of [undefined, null, "invalid", "full"]) expect(addressDisplay(value)).toBe("full");
	expect(addressDisplay("compact")).toBe("compact");
	expect(addressFilePath("file:///C:/Project/a%2520.txt")).toBe("C:/Project/a%20.txt");
	expect(addressFilePath("/tmp/a%20.txt")).toBe("/tmp/a%20.txt");
	expect(addressFilePath("file://server/share/file.txt")).toBeUndefined();
	expect(addressFilePath("\\\\server\\share\\file.txt")).toBeUndefined();
	for (const target of ["file:////server/share/a.txt", "file://localhost//server/share/a.txt", "file:///%2Fserver/share/a.txt", "file:///%5Cserver/share/a.txt"]) expect(addressFilePath(target)).toBeUndefined();
});


it.each([
	{ kind: "UNC", target: "\\\\server\\share\\資料.txt", display: "\\server\\share\\資料.txt", inside: "share\\資料.txt" },
	{ kind: "Windows escape", target: "C:\\work\\_scratch.txt", display: "C:\\work_scratch.txt", inside: "scratch.txt" },
])("keeps canonical Markdown label text separate from the exact raw action target: $kind", ({ target, display }) => {
	const source = `😀 BEFORE "${target}" AFTER尾`;
	const parser = unified().use(remarkParse).use(remarkGfm).use(remarkChatAddresses);
	const tree = parser.runSync(parser.parse(source), { value: source }) as Root;
	const paragraph = tree.children[0];
	if (paragraph.type !== "paragraph") throw new Error("Expected one paragraph");
	const links = paragraph.children.filter((node) => node.type === "link");
	expect(links).toHaveLength(1);
	expect(links[0].url).toBe(target);
	expect(links[0].data?.hProperties?.["data-chat-target"]).toBe(target);
	expect(links[0].children).toEqual([{ type: "text", value: display }]);
	expect(findChatAddresses(source).map((match) => match.target)).toEqual([target]);
	expect(paragraph.children.map((node) => node.type === "text" ? node.value : node.type === "link" ? node.children.map((child) => child.type === "text" ? child.value : "").join("") : "").join("")).toBe(`😀 BEFORE "${display}" AFTER尾`);
});
