import { describe, expect, it } from "vitest";
import type { Element, Root, RootContent } from "hast";
import { canonicalLanguage, highlightAsync, highlightSync, streamingCodeHighlighter, type GrammarName } from "./code-highlight";

function classesIn(tree: Root): string[] {
	const found: string[] = [];
	const walk = (nodes: readonly RootContent[]): void => {
		for (const node of nodes) {
			if (node.type !== "element") continue;
			const className = (node as Element).properties.className;
			if (Array.isArray(className)) found.push(...className.map(String));
			walk((node as Element).children);
		}
	};
	walk(tree.children);
	return found;
}

function textIn(tree: Root): string {
	let text = "";
	const walk = (nodes: readonly RootContent[]): void => {
		for (const node of nodes) {
			if (node.type === "text") text += node.value;
			else if (node.type === "element") walk(node.children);
		}
	};
	walk(tree.children);
	return text;
}

describe("canonicalLanguage", () => {
	it("resolves the labels agents actually write", () => {
		for (const label of ["ts", "tsx", "sh", "zsh", "golang", "yml", "html", "patch", "py", "rs"]) expect(canonicalLanguage(label)).toBe(label);
		expect(canonicalLanguage("console")).toBe("bash");
		expect(canonicalLanguage("udiff")).toBe("diff");
	});

	it("is case-insensitive, because a fence label is free text", () => {
		expect(canonicalLanguage("Go")).toBe("go");
		expect(canonicalLanguage("JSON")).toBe("json");
	});

	it("returns nothing for a label with no grammar", () => {
		expect(canonicalLanguage("brainfuck")).toBeUndefined();
		expect(canonicalLanguage("constructor")).toBeUndefined();
		expect(canonicalLanguage("__proto__")).toBeUndefined();
		for (const label of ["ansi", "text", "plain", "txt", "plaintext", "log"]) expect(canonicalLanguage(label)).toBeUndefined();
		expect(canonicalLanguage(undefined)).toBeUndefined();
	});
});

describe("highlightSync", () => {
	it("tokenizes into AO's syntax classes without changing the code", () => {
		const code = "func main() {\n\t// hi\n\tprintln(\"hi\", 42)\n}";
		const tree = highlightSync(code, "go");
		expect(tree).toBeDefined();
		const classes = classesIn(tree!);
		for (const name of ["hljs-keyword", "hljs-comment", "hljs-string", "hljs-number"]) expect(classes).toContain(name);
		expect(textIn(tree!)).toBe(code);
	});

	it("keeps the source's line endings", () => {
		const code = "a = 1\r\nb = 2\rc = 3\n";
		expect(textIn(highlightSync(code, "python")!)).toBe(code);
	});

	it("degrades to no tree for a grammar it does not have", () => {
		expect(highlightSync("x = 1", "klingon" as GrammarName)).toBeUndefined();
	});

	it("leaves code over a million characters plain", () => {
		expect(highlightSync("const a = 1;\n".repeat(80_000), "typescript")).toBeUndefined();
	});
});

describe("streamingCodeHighlighter", () => {
	it("highlights a fence, and leaves one past the size cap plain", () => {
		expect(streamingCodeHighlighter.highlight({ code: "const a = 1;\n", language: "ts", meta: "", isIncomplete: false })).toContain("var(--ao-code-keyword)");
		const session = streamingCodeHighlighter.createSession!();
		expect(session.highlightLines!({ code: `const s = "${"x".repeat(1_000_000)}";\n`, language: "ts", meta: "", isIncomplete: true })).toBeNull();
		session.dispose();
	});
});

// The composer paints from `highlightAsync`. These run the real seam (no mock) so its
// contract is pinned independently of the composer's timing tests: same tree as the
// synchronous tokenizer, the hljs-* classes the composer maps to colors, and an
// `undefined` (never a rejection) when there is nothing to paint.
describe("highlightAsync", () => {
	it("resolves to the tree highlightSync returns, with the classes the composer reads", async () => {
		const code = "const answer = 42;\n";
		const tree = await highlightAsync(code, "typescript");
		expect(tree).toEqual(highlightSync(code, "typescript"));
		expect(classesIn(tree!)).toEqual(expect.arrayContaining(["hljs-keyword", "hljs-number"]));
		expect(JSON.stringify(tree)).toContain("const");
	});

	it("keeps the source text exactly, line endings included", async () => {
		const code = "a = 1\r\nb = 2\n";
		const tree = await highlightAsync(code, "python");
		const text = (nodes: readonly RootContent[]): string => nodes.map((node) => node.type === "text" ? node.value : node.type === "element" ? text(node.children as RootContent[]) : "").join("");
		expect(text(tree!.children)).toBe(code);
	});

	it("resolves undefined, not a rejection, for input past the size cap", async () => {
		await expect(highlightAsync("x".repeat(1_000_001), "typescript")).resolves.toBeUndefined();
	});
});
