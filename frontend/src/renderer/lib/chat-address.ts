import type { Root, RootContent, Text } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";

export type AddressDisplay = "full" | "compact";
export type ChatAddressKind = "url" | "path";
export type ChatAddressMatch = { kind: ChatAddressKind; target: string; start: number; end: number };
export const addressDisplay = (value: unknown): AddressDisplay => value === "compact" ? "compact" : "full";
const parser = unified().use(remarkParse).use(remarkGfm);
const START = /https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|~\/|\.{1,2}\/|\/(?!\/)/gi;

function trimPunctuation(value: string): string {
	let end = value.length;
	while (end && /[.,;:!?]/.test(value[end - 1])) end--;
	for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
		let balance = 0;
		for (const char of value.slice(0, end)) balance += char === open ? 1 : char === close ? -1 : 0;
		while (balance < 0 && value[end - 1] === close) { end--; balance++; }
	}
	return value.slice(0, end);
}

function scan(text: string, offset: number, workspacePaths: readonly string[]): ChatAddressMatch[] {
	const matches: ChatAddressMatch[] = [];
	const add = (start: number, target: string, kind: ChatAddressKind) => {
		if (!target || matches.some((match) => start < match.end && start + target.length > match.start)) return;
		matches.push({ kind, target, start, end: start + target.length });
	};
	const standalone = text.trim();
	const starts = [...text.matchAll(START)].filter((match) => match.index === 0 || /[\s(<\["']/.test(text[match.index - 1]));
	if (starts.length === 1 && /\s[^\r\n]*[\\/]/.test(standalone) && !/[\r\n"'`]/.test(standalone) && /^(?:[A-Za-z]:[\\/]|\\\\|~\/|\/[^/\s]+\/)/.test(standalone)) {
		add(offset + text.indexOf(standalone), standalone, "path");
	}
	for (const path of [...workspacePaths].sort((a, b) => b.length - a.length)) {
		if (!path || !/[\\/]/.test(path)) continue;
		let at = text.indexOf(path);
		while (at >= 0) {
			if ((at === 0 || /[\s("']/.test(text[at - 1])) && (at + path.length === text.length || /[\s)"',;!?]/.test(text[at + path.length]))) add(offset + at, path, "path");
			at = text.indexOf(path, at + path.length);
		}
	}
	for (const match of starts) {
		const at = match.index;
		const quote = at > 0 && /["']/.test(text[at - 1]) ? text[at - 1] : undefined;
		const remainder = text.slice(at);
		const web = /^https?:\/\//i.test(remainder);
		let candidate = quote && !web
			? remainder.slice(0, remainder.indexOf(quote) < 0 ? undefined : remainder.indexOf(quote))
			: remainder.match(/^[^\s<>"'`]+/)?.[0] ?? "";
		candidate = trimPunctuation(candidate);
		if (web) {
			try { if (!new URL(candidate).hostname) continue; } catch { continue; }
		} else if (!(quote && /^\/[^/]/.test(candidate)) && !/^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/[^/\s]+[\\/]|\/[^/\s]+\.[^/\s]+)/i.test(candidate)) continue;
		add(offset + at, candidate, web ? "url" : "path");
	}
	return matches.sort((a, b) => a.start - b.start);
}

export function findChatAddresses(source: string, workspacePaths: readonly string[] = []): ChatAddressMatch[] {
	if (!/[\\/:]/.test(source)) return [];
	const matches: ChatAddressMatch[] = [];
	visit(parser.parse(source), (node) => {
		if (["code", "inlineCode", "html", "image", "imageReference", "linkReference", "definition"].includes(node.type)) return SKIP;
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start === undefined || end === undefined) return;
		if (node.type === "link") {
			if (!source.slice(start, end).startsWith("[")) matches.push(...scan(source.slice(start, end), start, workspacePaths));
			return SKIP;
		}
		if (node.type === "text") matches.push(...scan(source.slice(start, end), start, workspacePaths));
		return;
	});
	return matches.sort((a, b) => a.start - b.start);
}

export function addressName(target: string, kind: ChatAddressKind): string {
	if (kind === "url") {
		try { return new URL(target).host; } catch { return target; }
	}
	let path = target;
	if (/^file:\/\//i.test(path)) {
		try { const url = new URL(path); path = decodeURIComponent(url.pathname); } catch { /* Retain malformed escapes verbatim. */ }
	}
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || target;
}

export function addressFileOpenReference(target: string): string {
	return /^file:\/\//i.test(target) ? target : target.replace(/%/g, "%25");
}

export function addressFilePath(target: string): string | undefined {
	if (/^(?:\\\\|\/\/)/.test(target)) return undefined;
	let path = target;
	if (/^file:\/\//i.test(target)) {
		if (/^file:\/\/(?:localhost)?[\\/]{2}/i.test(target)) return undefined;
		try {
			const url = new URL(target);
			if (url.hostname && url.hostname !== "localhost") return undefined;
			path = decodeURIComponent(url.pathname);
			if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
		} catch { return undefined; }
	}
	if (/^[\\/]{2}/.test(path)) return undefined;
	return path.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
}

export function remarkChatAddresses({ workspacePaths = [] }: { workspacePaths?: readonly string[] } = {}) {
	return (tree: Root, file: { value: unknown }) => {
		const source = String(file.value);
		visit(tree, (node, index, parent) => {
			if (["code", "inlineCode", "html", "linkReference", "image", "imageReference", "definition"].includes(node.type)) return SKIP;
			if (node.type === "link") {
				const start = node.position?.start.offset;
				if (start !== undefined && !source.slice(start).startsWith("[") && /^https?:\/\//i.test(node.url)) {
					node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-chat-address": "url", "data-chat-target": node.url } };
				}
				return SKIP;
			}
			if (node.type !== "text" || index === undefined || !parent) return;
			const rawStart = node.position?.start.offset;
			const rawEnd = node.position?.end.offset;
			const raw = rawStart !== undefined && rawEnd !== undefined ? source.slice(rawStart, rawEnd) : node.value;
			const ranges = scan(raw, 0, workspacePaths);
			if (!ranges.length) return;
			const children: RootContent[] = [];
			let cursor = 0;
			for (const match of ranges) {
				const decoded = match.target.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
				const start = node.value.indexOf(decoded, cursor);
				if (start < 0) continue;
				if (start > cursor) children.push({ type: "text", value: node.value.slice(cursor, start) } satisfies Text);
				children.push({ type: "link", url: match.target, children: [{ type: "text", value: node.value.slice(start, start + decoded.length) }], data: { hProperties: { "data-chat-address": match.kind, "data-chat-target": match.target } } });
				cursor = start + decoded.length;
			}
			if (cursor < node.value.length) children.push({ type: "text", value: node.value.slice(cursor) });
			parent.children.splice(index, 1, ...children as Text[]);
			return index + children.length;
		});
	};
}
