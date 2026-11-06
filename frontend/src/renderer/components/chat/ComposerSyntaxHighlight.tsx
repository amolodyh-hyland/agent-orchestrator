import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, $isTextNode, type LexicalEditor, type LexicalNode } from "lexical";
import type { Root, RootContent } from "hast";
import { useEffect, useId } from "react";
import { canonicalLanguage, highlightInWorker, type GrammarName } from "../../lib/code-highlight";
import { CODE_TOKEN_COLORS, type CodeTokenKind } from "../../lib/code-style";
import { useUiStore } from "../../stores/ui-store";
import { ComposerCodeNode } from "./ComposerCode";
import { composerCodeRegions } from "./composerMarkdown";

const DEBOUNCE_MS = 80;
const MAX_CHARS = 100_000;
const MAX_REGIONS = 32;
const MAX_RANGES = 10_000;
type TextPart = { node: Text; text: string; start: number; end: number };
type CodeRegion = { code: string; language: GrammarName; parts: TextPart[]; start: number };

function codeRegions(editor: LexicalEditor, blockLanguage: string, inlineLanguage: string): CodeRegion[] {
	return editor.getEditorState().read(() => {
		const regions: CodeRegion[] = [];
		let chars = 0;
		const visit = (node: LexicalNode) => {
			if (node instanceof ComposerCodeNode) {
				const source = node.getTextContent();
				chars += source.length;
				if (chars > MAX_CHARS || regions.length >= MAX_REGIONS) return;
				const region = composerCodeRegions(source)[0];
				if (!region) return;
				const language = canonicalLanguage(region.kind === "inline" ? inlineLanguage : region.language || blockLanguage);
				if (!language) return;
				const parts: TextPart[] = [];
				let offset = 0;
				const collect = (child: LexicalNode) => {
					if ($isElementNode(child)) {
						child.getChildren().forEach(collect);
						return;
					}
					const dom = $isTextNode(child) ? editor.getElementByKey(child.getKey()) : null;
					if (dom && dom.textContent === child.getTextContent()) {
						const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
						let text: Node | null;
						let position = offset;
						while ((text = walker.nextNode())) {
							const end = position + (text as Text).length;
							if (end > region.contentStart && position < region.contentEnd) parts.push({ node: text as Text, text: (text as Text).data, start: position, end });
							position = end;
						}
					}
					offset += child.getTextContentSize();
				};
				node.getChildren().forEach(collect);
				regions.push({ code: source.slice(region.contentStart, region.contentEnd), language, parts, start: region.contentStart });
			} else if ($isElementNode(node)) node.getChildren().forEach(visit);
		};
		visit($getRoot());
		return regions;
	});
}

function tokenRanges(tree: Root, region: CodeRegion, ranges: Map<CodeTokenKind, Range[]>, budget: { remaining: number }) {
	if (region.parts.some((part) => !part.node.isConnected || part.node.data !== part.text)) return;
	let offset = region.start;
	let partIndex = 0;
	const visit = (node: RootContent, kind: CodeTokenKind) => {
		if (budget.remaining <= 0) return;
		if (node.type === "element") {
			const classes = node.properties.className;
			const tokenKind = Array.isArray(classes) ? classes.find((name) => String(name).startsWith("hljs-")) : undefined;
			const role = String(tokenKind).slice(5);
			const nextKind = Object.hasOwn(CODE_TOKEN_COLORS, role) ? role as CodeTokenKind : kind;
			node.children.forEach((child) => visit(child, nextKind));
		} else if (node.type === "text") {
			const end = offset + node.value.length;
			while (partIndex < region.parts.length && region.parts[partIndex].end <= offset) partIndex += 1;
			for (let index = partIndex; index < region.parts.length; index += 1) {
				const part = region.parts[index];
				if (part.start >= end) break;
				if (!part.node.isConnected) continue;
				const startOffset = Math.max(offset, part.start) - part.start;
				const endOffset = Math.min(end, part.end) - part.start;
				const list = ranges.get(kind) ?? [];
				const previous = list.at(-1);
				if (previous?.endContainer === part.node && previous.endOffset === startOffset) {
					previous.setEnd(part.node, endOffset);
				} else {
					if (budget.remaining <= 0) return;
					const range = part.node.ownerDocument.createRange();
					range.setStart(part.node, startOffset);
					range.setEnd(part.node, endOffset);
					list.push(range);
					ranges.set(kind, list);
					budget.remaining -= 1;
				}
			}
			offset = end;
		}
	};
	tree.children.forEach((node) => visit(node, "foreground"));
}

export function ComposerSyntaxHighlight() {
	const [editor] = useLexicalComposerContext();
	const blockLanguage = useUiStore((state) => state.defaultCodeBlockLanguage);
	const inlineLanguage = useUiStore((state) => state.defaultInlineCodeLanguage);
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const prefix = `ao-composer-${id}-`;
	useEffect(() => {
		if (typeof Highlight === "undefined" || !globalThis.CSS?.highlights) return;
		let revision = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let composing = false;
		let disposed = false;
		const clear = () => {
			for (const kind of Object.keys(CODE_TOKEN_COLORS)) CSS.highlights.delete(prefix + kind);
		};
		const paint = async () => {
			timer = undefined;
			if (disposed || composing || editor.isComposing()) return;
			running = true;
			const version = revision;
			try {
				const regions = codeRegions(editor, blockLanguage, inlineLanguage);
				const trees = await Promise.all(regions.map((region) => highlightInWorker(region.code, region.language)));
				if (disposed || composing || editor.isComposing() || version !== revision) return;
				const ranges = new Map<CodeTokenKind, Range[]>();
				const budget = { remaining: MAX_RANGES };
				trees.forEach((tree, index) => { if (tree) tokenRanges(tree, regions[index], ranges, budget); });
				clear();
				for (const [kind, values] of ranges) {
					const highlight = new Highlight();
					for (const range of values) highlight.add(range);
					CSS.highlights.set(prefix + kind, highlight);
				}
			} finally {
				running = false;
				if (!disposed && version !== revision) schedule();
			}
		};
		const schedule = () => {
			revision += 1;
			clearTimeout(timer);
			if (!running && !disposed && !composing) timer = setTimeout(() => { void paint(); }, DEBOUNCE_MS);
		};
		const compositionStart = () => { composing = true; clear(); schedule(); };
		const compositionEnd = () => { composing = false; schedule(); };
		const removeRoot = editor.registerRootListener((root, previous) => {
			previous?.removeEventListener("compositionstart", compositionStart);
			previous?.removeEventListener("compositionend", compositionEnd);
			root?.addEventListener("compositionstart", compositionStart);
			root?.addEventListener("compositionend", compositionEnd);
			schedule();
		});
		const removeUpdate = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
			if (dirtyElements.size || dirtyLeaves.size) schedule();
		});
		return () => {
			disposed = true;
			revision += 1;
			clearTimeout(timer);
			removeRoot();
			removeUpdate();
			clear();
		};
	}, [editor, blockLanguage, inlineLanguage, prefix]);
	return <style>{Object.entries(CODE_TOKEN_COLORS).map(([kind, color]) => `::highlight(${prefix + kind}) { color: ${color}; }`).join("\n")}</style>;
}
