import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$addUpdateTag,
	$createRangeSelectionFromDom,
	$createRangeSelection,
	$setSelection,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$createParagraphNode,
	$createLineBreakNode,
	$isLineBreakNode,
	$createTextNode,
	CLEAR_HISTORY_COMMAND,
	COMMAND_PRIORITY_HIGH,
	DecoratorNode,
	getDOMSelectionFromTarget,
	HISTORIC_TAG,
	HISTORY_PUSH_TAG,
	HISTORY_MERGE_TAG,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	KEY_TAB_COMMAND,
	KEY_BACKSPACE_COMMAND,
	KEY_DELETE_COMMAND,
	KEY_ARROW_LEFT_COMMAND,
	KEY_ARROW_RIGHT_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ARROW_DOWN_COMMAND,
	SELECTION_CHANGE_COMMAND,
	CONTROLLED_TEXT_INSERTION_COMMAND,
	BEFORE_INPUT_COMMAND,
	DELETE_CHARACTER_COMMAND,
	PASTE_COMMAND,
	CUT_COMMAND,
	CUT_TAG,
	type EditorConfig,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type RangeSelection,
	type SerializedLexicalNode,
	type Spread,
} from "lexical";
import {
	createContext,
	forwardRef,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ClipboardEvent,
	type JSX,
	type KeyboardEvent,
} from "react";
import { Box, Image as ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { composerFileIcon } from "./composerFileIcon";
import { composerCodeRegions, createComposerGraphemeNavigator, isComposerOpenCodeFenceAt } from "./composerMarkdown";
import { COMPOSER_CODE_LANGUAGE_TAG, ComposerCodeNode, ComposerCodePlaceholderNode, ComposerCodePlugin } from "./ComposerCode";
import { findActiveTrigger, type TriggerKind } from "./composerSuggest";
import { attachmentName, isInlineImagePath, splitAttachmentPaths } from "./messageAttachments";
import { AttachmentPathChip, AttachmentPathMenu } from "./AttachmentPathChip";

export type ComposerTrigger = {
	kind: TriggerKind;
	sigil?: "$";
	key: string;
	nodeKey: string;
	start: number;
	end: number;
	query: string;
};

export type ComposerEditorSnapshot = {
	text: string;
	hasText: boolean;
	trigger?: ComposerTrigger;
};

export type ComposerPromptSuggestion = { id: string; text: string; onDismiss?: () => void };

export type ComposerEditorHandle = {
	focus(): void;
	insertText(text: string): void;
	clear(): void;
	/** Replaces the text with the caret at its end, or at its start when asked. */
	setText(text: string, caret?: "start" | "end"): void;
	/** Where a collapsed caret sits relative to the whole text; undefined for a range. */
	caretBoundary(): { atStart: boolean; atEnd: boolean } | undefined;
	wrapInlineCode(): boolean;
	wrapCodeBlock(): boolean;
	insertToken(trigger: ComposerTrigger, value: string): void;
	/** Inserts a file reference chip at the caret (or the end) that sends `wire`. */
	insertReference(path: string, display: string, wire: string): void;
	/**
	 * Hold the caret's place for images still being staged. Returns a reservation
	 * for fillImages, so the chips land where the user pasted, not wherever the
	 * caret has moved by the time staging finishes.
	 */
	reserveImages(): string | undefined;
	reserveAttachments(): string | undefined;
	/** Replace a reservation with one chip per staged image path (none removes it). */
	fillImages(reservation: string, paths: string[]): void;
	fillAttachments(reservation: string, paths: string[]): void;
	removeAttachment(path: string): void;
	pruneAttachments(attached: string[]): void;
	/** Drop every inline chip for an image that left the attachment list. */
	removeImage(path: string): void;
	/**
	 * Drop chips whose image is not in `attached` (an undo can restore a chip
	 * after its image was removed). Typed text is never touched.
	 */
	pruneImages(attached: string[]): void;
	getSnapshot(): ComposerEditorSnapshot;
};

/** What an inline image chip shows for a staged path; the path itself is the wire text. */
export type ComposerImage = { path: string; name: string; src?: string };

const ComposerAttachments = createContext<{ path: string; folder?: boolean }[]>([]);

const ComposerImages = createContext<ComposerImage[]>([]);

/** An empty path is a reservation whose image is still being staged. */
function ComposerImageChip({ path }: { path: string }) {
	const images = useContext(ComposerImages);
	const image = images.find((candidate) => candidate.path === path);
	if (!path) {
		return (
			<span
				data-composer-token="image-pending"
				contentEditable={false}
				className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-1.5 py-0.5 align-middle text-[0.9em] leading-none text-muted-foreground select-none"
			>
				<ImageIcon aria-hidden="true" className="size-3 shrink-0" />
				…
			</span>
		);
	}
	return (
		<AttachmentPathMenu path={path}><span
			tabIndex={0}
			role="button"
			aria-label={path}
			data-composer-token="image"
			data-value={path}
			contentEditable={false}
			title={path}
			className="mx-0.5 inline-flex max-w-48 items-center gap-1 rounded-md border border-border-strong bg-interactive-hover py-0.5 pl-0.5 pr-1.5 align-middle text-[0.9em] leading-none text-foreground select-none"
		>
			{image?.src ? (
				<img src={image.src} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
			) : (
				<ImageIcon aria-hidden="true" className="size-3 shrink-0" />
			)}
			<span className="truncate">
				{attachmentName(image?.name ?? path)}
			</span>
		</span></AttachmentPathMenu>
	);
}

function ComposerAttachmentChip({ path }: { path: string }) {
	const attachments = useContext(ComposerAttachments);
	return <AttachmentPathChip path={path} composer folder={attachments.find((item) => item.path === path)?.folder} />;
}

type TokenKind = "skill" | "file" | "image" | "attachment";

const completionHandledEvents = new WeakSet<Event>();
const PROGRAMMATIC_TEXT_UPDATE_TAG = "ao:composer-programmatic-text";
const COMPOSER_MARKDOWN_FORMAT_TAG = "ao:composer-markdown-format";
const COMPOSER_CODE_BLOCK_STYLE =
	"background-color: var(--card); border-radius: var(--radius-sm); padding-inline: 0.25rem";

type SerializedComposerTokenNode = Spread<
	{
		kind: TokenKind;
		value: string;
		display: string;
		wire: string;
	},
	SerializedLexicalNode
>;

class ComposerTokenNode extends DecoratorNode<JSX.Element> {
	__kind: TokenKind;
	__value: string;
	__display: string;
	__wire: string;

	static getType(): string {
		return "composer-token";
	}

	static clone(node: ComposerTokenNode): ComposerTokenNode {
		return new ComposerTokenNode(
			node.__kind,
			node.__value,
			node.__display,
			node.__wire,
			node.__key,
		);
	}

	static importJSON(serialized: SerializedComposerTokenNode): ComposerTokenNode {
		return new ComposerTokenNode(
			serialized.kind,
			serialized.value,
			serialized.display,
			serialized.wire,
		);
	}

	constructor(kind: TokenKind, value: string, display: string, wire: string, key?: NodeKey) {
		super(key);
		this.__kind = kind;
		this.__value = value;
		this.__display = display;
		this.__wire = wire;
	}

	exportJSON(): SerializedComposerTokenNode {
		return {
			...super.exportJSON(),
			type: "composer-token",
			version: 1,
			kind: this.__kind,
			value: this.__value,
			display: this.__display,
			wire: this.__wire,
		};
	}

	createDOM(_config: EditorConfig): HTMLElement {
		return document.createElement("span");
	}

	updateDOM(): false {
		return false;
	}

	isInline(): true {
		return true;
	}

	isKeyboardSelectable(): false {
		return false;
	}

	getTextContent(): string {
		return this.__wire;
	}

	decorate(): JSX.Element {
		if (this.__kind === "image") return <ComposerImageChip path={this.__value} />;
		if (this.__kind === "attachment") return <ComposerAttachmentChip path={this.__value} />;
		if (this.__kind === "file") return <AttachmentPathChip path={this.__value} display={this.__display} composer />;
		const Icon = this.__kind === "skill" ? Box : composerFileIcon(this.__value);
		return (
			<span
				data-composer-token={this.__kind}
				data-value={this.__value}
				contentEditable={false}
				className={cn(
					"mx-0.5 inline-flex items-center gap-1 rounded-md border border-border-strong bg-interactive-hover px-1.5 py-0.5 align-middle text-[0.9em] leading-none select-none",
					this.__kind === "skill"
						? "text-logo-accent"
						: "text-foreground",
				)}
			>
				<Icon aria-hidden="true" className="size-3 shrink-0" />
				{this.__display}
			</span>
		);
	}
}

function $createComposerTokenNode(kind: TokenKind, value: string): ComposerTokenNode {
	if (kind === "image" || kind === "attachment") return new ComposerTokenNode(kind, value, value, value);
	const wire = kind === "skill" ? (/^[/$]/.test(value) ? value : `/${value}`) : /\s/.test(value) ? `"${value}"` : value;
	const display = kind === "skill" ? wire : attachmentName(value);
	return new ComposerTokenNode(kind, value, display, wire);
}

function $insertComposerReference(path: string, display: string, wire: string): void {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) {
		$getRoot().selectEnd();
		selection = $getSelection();
	}
	if (!$isRangeSelection(selection)) return;
	selection.insertNodes([new ComposerTokenNode("file", path, display, wire), $createTextNode(" ")]);
}

function $serializeComposer(): string {
	return $getRoot()
		.getChildren()
		.map((child) => child.getTextContent())
		.join("\n");
}

const COMPOSER_MARKER_STYLE = "display: none";
const adjacentComposerGrapheme = createComposerGraphemeNavigator();

function $composerLeaves(): LexicalNode[] {
	const leaves: LexicalNode[] = [];
	const visit = (node: LexicalNode) => {
		if ($isElementNode(node)) node.getChildren().forEach(visit);
		else leaves.push(node);
	};
	visit($getRoot());
	return leaves;
}

function $selectComposerOffset(offset: number, point: RangeSelection["anchor"], raw = false): void {
	const positioned: { node: LexicalNode; start: number }[] = [];
	let cursor = 0;
	const visit = (node: LexicalNode) => {
		if ($isElementNode(node) && node.getChildrenSize()) node.getChildren().forEach(visit);
		else {
			positioned.push({ node, start: cursor });
			cursor += node.getTextContentSize();
		}
	};
	for (const paragraph of $getRoot().getChildren()) {
		visit(paragraph);
		cursor += 1;
	}
	for (const { node, start } of positioned) {
		const end = start + node.getTextContentSize();
		if (offset <= end) {
			if ($isElementNode(node)) {
				point.set(node.getKey(), 0, "element");
				return;
			}
			const parent = node.getParentOrThrow();
			const index = node.getIndexWithinParent();
			if (!raw && $isTextNode(node) && node.getStyle() === COMPOSER_MARKER_STYLE) {
				const region = parent instanceof ComposerCodeNode ? parent : null;
				const opening = node.getPreviousSiblings().every((sibling) => $isTextNode(sibling) && sibling.getStyle() === COMPOSER_MARKER_STYLE);
				if (region && ((index === 0 && offset === start) || (!opening && offset === end && !node.getNextSibling()))) {
					point.set(region.getParentOrThrow().getKey(), region.getIndexWithinParent() + (index > 0 ? 1 : 0), "element");
				} else {
					const visible = opening ? node.getNextSibling() : node.getPreviousSibling();
					if ($isTextNode(visible)) point.set(visible.getKey(), opening ? 0 : visible.getTextContentSize(), "text");
					else point.set(parent.getKey(), index + (opening ? 1 : 0), "element");
				}
			} else if ($isTextNode(node)) point.set(node.getKey(), Math.max(0, offset - start), "text");
			else point.set(parent.getKey(), index + (offset === end ? 1 : 0), "element");
			return;
		}
	}
}

function $formatComposerMarkdown(): void {
	const source = $serializeComposer();
	const regions = composerCodeRegions(source);
	const selection = $getSelection();
	const offsets = $isRangeSelection(selection)
		? [
				$documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset),
				$documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset),
			]
		: undefined;
	const previous = new Map<number, ComposerCodeNode>();
	let previousOffset = 0;
	const collect = (node: LexicalNode) => {
		if (node instanceof ComposerCodeNode) previous.set(previousOffset, node);
		if ($isElementNode(node)) node.getChildren().forEach(collect);
		else previousOffset += node.getTextContentSize();
	};
	const root = $getRoot();
	const paragraphs = root.getChildren();
	const first = paragraphs[0];
	const last = paragraphs[paragraphs.length - 1];
	const leadingEmpty = paragraphs.length > 1 && $isElementNode(first) && first.isEmpty();
	let contentParagraphs = leadingEmpty ? paragraphs.slice(1) : paragraphs;
	if (contentParagraphs.length > 1 && $isElementNode(last) && last.isEmpty() && !isComposerOpenCodeFenceAt(source, source.length)) contentParagraphs = contentParagraphs.slice(0, -1);
	paragraphs.forEach((node, index) => {
		collect(node);
		if (index < paragraphs.length - 1) previousOffset += 1;
	});
	if (!regions.length && !previous.size) return;
	const structureStable =
		contentParagraphs.length === 1 &&
		previous.size === regions.length &&
		regions.every((region) => {
			const block = previous.get(region.start);
			return block?.__kind === region.kind && block.getTextContentSize() === region.end - region.start;
		});

	const leaves: LexicalNode[] = [];
	contentParagraphs.forEach((paragraph, index) => {
		const visit = (node: LexicalNode) => {
			if ($isElementNode(node)) node.getChildren().forEach(visit);
			else leaves.push(node);
		};
		visit(paragraph);
		if (index < contentParagraphs.length - 1) leaves.push($createLineBreakNode());
	});
	const paragraph = $isElementNode(contentParagraphs[0]) ? contentParagraphs[0] : $createParagraphNode();
	if (!structureStable) {
		paragraph.append(...leaves);
		for (const child of paragraph.getChildren()) if ($isElementNode(child)) child.remove();
		for (const extra of contentParagraphs.slice(1)) extra.remove();
		if (!paragraph.isAttached()) root.append(paragraph);
	}

	const boundaries = regions.flatMap((region) => [region.start, region.contentStart, region.contentEnd, region.end]);
	let offset = leadingEmpty ? 1 : 0;
	const parts: { node: LexicalNode; start: number; end: number }[] = [];
	let boundaryIndex = 0;
	for (const leaf of leaves) {
		const end = offset + leaf.getTextContentSize();
		while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= offset) boundaryIndex += 1;
		const splits: number[] = [];
		while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] < end)
			splits.push(boundaries[boundaryIndex++] - offset);
		const nodes = $isTextNode(leaf) ? leaf.splitText(...splits) : [leaf];
		for (const node of nodes) {
			const partEnd = offset + node.getTextContentSize();
			parts.push({ node, start: offset, end: partEnd });
			offset = partEnd;
		}
	}
	let regionIndex = 0;
	let wrapper: ComposerCodeNode | undefined;
	const emptyBlocks: { wrapper: ComposerCodeNode; contentOffset: number }[] = [];
	for (const part of parts) {
		while (regionIndex < regions.length && part.start >= regions[regionIndex].end) {
			regionIndex += 1;
			wrapper = undefined;
		}
		const region = regions[regionIndex];
		const inRegion = region && part.start >= region.start && part.end <= region.end;
		const marker =
			inRegion && part.end > part.start && (part.end <= region.contentStart || part.start >= region.contentEnd);
		let node = part.node;
		if (node instanceof ComposerCodePlaceholderNode && (!inRegion || region.contentStart !== region.contentEnd)) {
			node.remove();
			continue;
		}
		if (marker && $isLineBreakNode(node)) node = node.replace($createTextNode(node.getTextContent()));
		if ($isTextNode(node)) {
			if (node.hasFormat("code") !== Boolean(inRegion)) node.toggleFormat("code");
			const style = marker
				? COMPOSER_MARKER_STYLE
				: inRegion && region.kind === "fenced"
					? COMPOSER_CODE_BLOCK_STYLE
					: "";
			if (node.getStyle() !== style) node.setStyle(style);
		}
		if (inRegion) {
			if (!wrapper) {
				const old = previous.get(region.start);
				wrapper = old?.__kind === region.kind ? old : new ComposerCodeNode(region.kind);
				if (!structureStable) node.insertBefore(wrapper);
				if (region.kind === "fenced" && region.contentStart === region.contentEnd) {
					emptyBlocks.push({ wrapper, contentOffset: region.contentStart - region.start });
				}
			}
			if (!structureStable) wrapper.append(node);
		}
	}
	for (const { wrapper: block, contentOffset } of emptyBlocks) {
		if (block.getChildren().some((node) => node instanceof ComposerCodePlaceholderNode)) continue;
		let offset = 0;
		for (const child of block.getChildren()) {
			offset += child.getTextContentSize();
			if (offset !== contentOffset) continue;
			child.insertAfter(new ComposerCodePlaceholderNode());
			break;
		}
	}
	if (!structureStable && $isRangeSelection(selection) && offsets?.[0] !== undefined && offsets[1] !== undefined) {
		const restored = $createRangeSelection();
		$setSelection(restored);
		$selectComposerOffset(offsets[0], restored.anchor);
		$selectComposerOffset(offsets[1], restored.focus);
		const anchor = restored.anchor.getNode();
		if ($isTextNode(anchor)) {
			restored.format = anchor.getFormat();
			restored.style = anchor.getStyle();
		}
	}
}

function $exitComposerCode(event: globalThis.KeyboardEvent, direction: -1 | 1, atBoundary = false): boolean {
	const selection = $getSelection();
	if (
		!$isRangeSelection(selection) || !selection.isCollapsed() || event.defaultPrevented ||
		event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey
	) return false;
	let node: LexicalNode | null = selection.focus.getNode();
	while (node && !(node instanceof ComposerCodeNode)) node = node.getParent();
	if (!(node instanceof ComposerCodeNode)) return false;
	const offset = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	if (offset === undefined) return false;
	const source = $serializeComposer();
	const regions = composerCodeRegions(source);
	const region = regions.find((candidate) => offset >= candidate.contentStart && offset <= candidate.contentEnd);
	if (!region) return false;
	if (atBoundary) {
		if (region.kind === "fenced") {
			const remaining = direction < 0 ? source.slice(region.contentStart, offset) : source.slice(offset, region.contentEnd);
			if (remaining.includes("\n")) return false;
		} else if (offset !== (direction < 0 ? region.contentStart : region.contentEnd)) return false;
	}
	let target = direction < 0 ? region.start : region.end;
	const parent = node.getParentOrThrow();
	const index = node.getIndexWithinParent() + (direction > 0 ? 1 : 0);
	selection.anchor.set(parent.getKey(), index, "element");
	selection.focus.set(parent.getKey(), index, "element");
	selection.format = 0;
	selection.style = "";
	if (region.kind === "fenced") {
		if (direction < 0) {
			if (source[target - 1] === "\n") {
				const newline = source[target - 2] === "\r" ? "\r\n" : "\n";
				if (regions.some((candidate) => candidate.kind === "fenced" && /^\r?\n$/.test(source.slice(candidate.end, target)))) {
					$addUpdateTag(HISTORY_PUSH_TAG);
					selection.insertText(newline);
				} else target -= newline.length;
			} else $getRoot().getFirstChildOrThrow().insertBefore($createParagraphNode());
		} else if (region.end === region.contentEnd) {
			const closing = "\n" + source.slice(region.start, region.contentStart).match(/`{3,}/)![0];
			selection.insertText(closing);
			$getRoot().append($createParagraphNode());
			target += closing.length + 1;
		} else if (source[target] === "\n" || source.slice(target, target + 2) === "\r\n") {
			target += source[target] === "\r" ? 2 : 1;
			if (regions.some((candidate) => candidate.kind === "fenced" && candidate.start === target)) {
				$addUpdateTag(HISTORY_PUSH_TAG);
				$selectComposerOffset(target, selection.anchor);
				$selectComposerOffset(target, selection.focus);
				selection.insertText(source[target - 2] === "\r" ? "\r\n" : "\n");
			}
		} else {
			$getRoot().append($createParagraphNode());
			target += 1;
		}
		$selectComposerOffset(target, selection.anchor);
		$selectComposerOffset(target, selection.focus);
	}
	completionHandledEvents.add(event);
	event.preventDefault();
	return true;
}

function $codeEdgeKey(event: globalThis.KeyboardEvent, direction: -1 | 1, remove = false): boolean {
	const selection = $getSelection();
	if (
		!$isRangeSelection(selection) ||
		(!selection.isCollapsed() && (remove || !event.shiftKey)) ||
		event.isComposing ||
		event.metaKey ||
		event.ctrlKey ||
		event.altKey
	)
		return false;
	const offset = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	if (offset === undefined) return false;
	const source = $serializeComposer();
	const regions = composerCodeRegions(source);
	const region = regions.find((candidate) =>
		remove
			? direction < 0
				? offset === candidate.contentStart || offset === candidate.end
				: offset === candidate.contentEnd || offset === candidate.start
			: offset >= candidate.start && offset <= candidate.end,
	);
	if (!region) return false;
	if (!remove && region.kind === "fenced" && !event.shiftKey &&
		(direction < 0 ? offset === region.contentStart : offset === region.contentEnd)) {
		return $exitComposerCode(event, direction);
	}
	if (remove) {
		$addUpdateTag(HISTORY_PUSH_TAG);
		$selectComposerOffset(region.start, selection.anchor);
		$selectComposerOffset(region.end, selection.focus);
		selection.insertText(source.slice(region.contentStart, region.contentEnd));
		const next = $getSelection();
		if ($isRangeSelection(next)) {
			const target =
				region.start + (direction < 0 && offset === region.contentStart ? 0 : region.contentEnd - region.contentStart);
			$selectComposerOffset(target, next.anchor);
			$selectComposerOffset(target, next.focus);
		}
	} else {
		let target: number;
		if (direction < 0) {
			if (offset > region.contentEnd) target = region.contentEnd;
			else if (offset <= region.contentStart) target = region.start;
			else
				target =
					region.contentStart +
					adjacentComposerGrapheme(
						source.slice(region.contentStart, region.contentEnd),
						offset - region.contentStart,
						direction,
					);
		} else {
			if (offset < region.contentStart) target = region.contentStart;
			else if (offset >= region.contentEnd) target = region.end;
			else
				target =
					region.contentStart +
					adjacentComposerGrapheme(
						source.slice(region.contentStart, region.contentEnd),
						offset - region.contentStart,
						direction,
					);
		}
		if (target === offset) return false;
		if (!event.shiftKey) $selectComposerOffset(target, selection.anchor);
		$selectComposerOffset(target, selection.focus);
		const focus = selection.focus.getNode();
		selection.format = $isTextNode(focus) ? focus.getFormat() : 0;
		selection.style = $isTextNode(focus) ? focus.getStyle() : "";
	}
	event.preventDefault();
	return true;
}

function $normalizeCodeRangeSelection(replacement = ""): string | undefined {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
	const anchor = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
	const focus = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	if (anchor === undefined || focus === undefined) return;
	const source = $serializeComposer();
	const regions = composerCodeRegions(source);
	let start = Math.min(anchor, focus);
	let end = Math.max(anchor, focus);
	const repairs: { offset: number; end?: number; text: string }[] = [];
	for (const region of regions) {
		// A visible endpoint at the code edge can sit inside the hidden syntax.
		// Keep that syntax with the untouched code, including a fence's line boundary.
		if (start >= region.contentEnd && start < region.end && end >= region.end) {
			start = region.end;
			const after = replacement + source.slice(end);
			if (region.kind === "fenced" && after && !after.startsWith("\n") && !after.startsWith("\r\n")) {
				repairs.push({
					offset: start,
					text: source.slice(region.start, region.contentStart).endsWith("\r\n") ? "\r\n" : "\n",
				});
			}
			continue;
		}
		if (end > region.start && end <= region.contentStart && start <= region.start) {
			end = region.start;
			const before = source.slice(0, start) + replacement;
			if (region.kind === "fenced" && before && !before.endsWith("\n")) {
				repairs.push({
					offset: end,
					text: source.slice(region.start, region.contentStart).endsWith("\r\n") ? "\r\n" : "\n",
				});
			}
			continue;
		}
		if (
			start <= region.contentStart &&
			end >= region.contentEnd &&
			(start < region.contentStart || end > region.contentEnd)
		) {
			start = Math.min(start, region.start);
			end = Math.max(end, region.end);
		} else {
			if (start >= region.start && start < region.contentStart) start = region.contentStart;
			if (end > region.contentEnd && end <= region.end) end = region.contentEnd;
		}
	}
	let copied = source.slice(start, end);
	// Repair the unselected code before the normal replacement removes a crossing
	// selection. The clipboard receives balanced Markdown for the selected code too.
	const head = regions.find(
		(region) => start > region.contentStart && start < region.contentEnd && end > region.contentEnd,
	);
	const tail = regions.find(
		(region) => start < region.contentStart && end > region.contentStart && end < region.contentEnd,
	);
	let closing = "";
	if (head) {
		const opening = source.slice(head.start, head.contentStart);
		closing = source.slice(head.contentEnd, head.end);
		copied = opening + copied;
		const after = replacement + source.slice(end);
		if (head.kind === "fenced" && after && !after.startsWith("\n") && !after.startsWith("\r\n")) {
			closing += opening.endsWith("\r\n") ? "\r\n" : "\n";
		}
		repairs.push({ offset: start, text: closing });
	}
	if (tail) {
		let opening = source.slice(tail.start, tail.contentStart);
		const before = source.slice(0, start) + closing + replacement;
		if (tail.kind === "fenced" && before && !before.endsWith("\n")) {
			opening = (opening.endsWith("\r\n") ? "\r\n" : "\n") + opening;
		}
		copied += source.slice(tail.contentEnd, tail.end);
		repairs.push({ offset: end, text: opening });
	}
	if (head?.kind === "inline" && tail?.kind === "inline" && !replacement) {
		// Join the survivors under one delimiter pair: adjacent closing/opening runs
		// would coalesce into a different backtick delimiter.
		const remaining = source.slice(head.contentStart, start) + source.slice(end, tail.contentEnd);
		let markerLength = Math.max(head.contentStart - head.start, tail.end - tail.contentEnd);
		for (const match of remaining.matchAll(/`+/g)) markerLength = Math.max(markerLength, match[0].length + 1);
		const marker = "`".repeat(markerLength);
		repairs.length = 0;
		repairs.push({ offset: head.start, end: head.contentStart, text: marker });
		repairs.push({ offset: tail.contentEnd, end: tail.end, text: marker });
	}
	if (!repairs.length && start === Math.min(anchor, focus) && end === Math.max(anchor, focus)) return;
	for (const repair of repairs.sort((left, right) => right.offset - left.offset)) {
		const insertion = $createRangeSelection();
		$setSelection(insertion);
		$selectComposerOffset(repair.offset, insertion.anchor, true);
		$selectComposerOffset(repair.end ?? repair.offset, insertion.focus, true);
		insertion.insertText(repair.text);
		const delta = repair.text.length - ((repair.end ?? repair.offset) - repair.offset);
		if (repair.offset <= start) start += delta;
		if (repair.offset < end) end += delta;
	}
	const restored = $createRangeSelection();
	$setSelection(restored);
	$selectComposerOffset(anchor <= focus ? start : end, restored.anchor, true);
	$selectComposerOffset(anchor <= focus ? end : start, restored.focus, true);
	return copied;
}

function $insertComposerCodeNewline(allowClosed = false): boolean {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;
	const anchor = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
	const focus = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	if (anchor === undefined || focus === undefined) return false;
	const source = $serializeComposer();
	if (!allowClosed && !isComposerOpenCodeFenceAt(source, anchor)) return false;
	if (
		!composerCodeRegions(source).some(
			(region) =>
				region.kind === "fenced" &&
				anchor >= region.contentStart &&
				anchor <= region.contentEnd &&
				focus >= region.contentStart &&
				focus <= region.contentEnd,
		)
	)
		return false;
	selection.insertText("\n");
	return true;
}

function $selectionIsInsideOpenComposerCodeFence(): boolean {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;
	const anchorOffset = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
	const focusOffset = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	if (anchorOffset === undefined || focusOffset === undefined) return false;
	const text = $serializeComposer();
	return isComposerOpenCodeFenceAt(text, anchorOffset) && isComposerOpenCodeFenceAt(text, focusOffset);
}

function $insertComposerToken(trigger: ComposerTrigger, value: string): boolean {
	const node = $getNodeByKey<LexicalNode>(trigger.nodeKey);
	if (!$isTextNode(node)) return false;
	const text = node.getTextContent();
	const expected = `${trigger.kind === "skill" ? trigger.sigil ?? "/" : "@"}${trigger.query}`;
	if (text.slice(trigger.start, trigger.end) !== expected) return false;

	const before = text.slice(0, trigger.start);
	const after = text.slice(trigger.end);
	const token = $createComposerTokenNode(trigger.kind, value);
	const tail = $createTextNode(/^\s/.test(after) ? after : ` ${after}`);
	if (before) {
		const head = $createTextNode(before);
		node.replace(head);
		head.insertAfter(token);
	} else {
		node.replace(token);
	}
	token.insertAfter(tail);
	tail.select(1, 1);
	return true;
}

function $replaceEditorText(text: string, attached: string[] = [], caret: "start" | "end" = "end"): void {
	const root = $getRoot();
	root.clear();
	$setSelection($createRangeSelection());
	for (const line of text.split("\n")) {
		const paragraph = $createParagraphNode();
		// A restored draft is plain text; paths of still-attached files become chips
		// again. Any other path stays the text the user typed.
		for (const segment of splitAttachmentPaths(line, attached)) {
			paragraph.append(
				segment.path === undefined
					? $createTextNode(segment.text)
					: $createComposerTokenNode(isInlineImagePath(segment.path) ? "image" : "attachment", segment.path),
			);
		}
		root.append(paragraph);
	}
	if (caret === "start") root.selectStart();
	else root.selectEnd();
	$formatComposerMarkdown();
}

/** True when nothing precedes (or follows) the point in the whole document. */
function $isAtDocumentEdge(point: RangeSelection["anchor"], edge: "start" | "end"): boolean {
	let node: LexicalNode = point.getNode();
	const size = $isTextNode(node) ? node.getTextContentSize() : $isElementNode(node) ? node.getChildrenSize() : 0;
	if (point.offset !== (edge === "start" ? 0 : size)) return false;
	for (let parent = node.getParent(); parent; node = parent, parent = node.getParent()) {
		if ((edge === "start" ? node.getPreviousSibling() : node.getNextSibling()) !== null) return false;
	}
	return true;
}

/**
 * Read from the DOM: Lexical adopts a native caret move on `selectionchange`, which
 * can still be queued when the next arrow key arrives.
 */
function $caretBoundary(editor: LexicalEditor): { atStart: boolean; atEnd: boolean } | undefined {
	const selection = $createRangeSelectionFromDom(getDOMSelectionFromTarget(editor.getRootElement()), editor) ?? $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return undefined;
	return {
		atStart: $isAtDocumentEdge(selection.anchor, "start"),
		atEnd: $isAtDocumentEdge(selection.anchor, "end"),
	};
}

/** True when the character before the caret would run into an inserted chip's text. */
function $joinsPreviousWord(selection: RangeSelection): boolean {
	const { anchor } = selection;
	const node = anchor.getNode();
	const before = $isTextNode(node)
		? node.getTextContent().slice(0, anchor.offset) || (node.getPreviousSibling()?.getTextContent() ?? "")
		: $isElementNode(node) && anchor.offset > 0
			? (node.getChildAtIndex(anchor.offset - 1)?.getTextContent() ?? "")
			: "";
	return /\S$/.test(before);
}

function $reserveImages(spaced = true): string | undefined {
	const reservation = $createComposerTokenNode("image", "");
	const nodes: LexicalNode[] = spaced ? [reservation, $createTextNode(" ")] : [reservation];
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) {
		// A drop or the file picker can leave no selection; the end is the natural place.
		$getRoot().selectEnd();
		selection = $getSelection();
	}
	if (!$isRangeSelection(selection)) return undefined;
	if (spaced && $joinsPreviousWord(selection)) nodes.unshift($createTextNode(" "));
	selection.insertNodes(nodes);
	return reservation.getKey();
}

function $fillImages(reservation: string, paths: string[], attachments = false): void {
	const node = $getNodeByKey(reservation);
	// Deleted while staging: the user removed it on purpose, so add nothing back.
	if (!(node instanceof ComposerTokenNode)) return;
	if (paths.length === 0) {
		if (attachments) node.remove();
		else $removeChip(node);
		return;
	}
	if (attachments) {
		const previous = node.getPreviousSibling()?.getTextContent() ?? "";
		const next = node.getNextSibling()?.getTextContent() ?? "";
		if (/\S$/.test(previous)) node.insertBefore($createTextNode(" "));
		if (!/^\s/.test(next)) node.insertAfter($createTextNode(" "));
	}
	let last: LexicalNode = node;
	paths.forEach((path, index) => {
		const chip = $createComposerTokenNode(attachments && !isInlineImagePath(path) ? "attachment" : "image", path);
		if (index === 0) {
			node.replace(chip);
		} else {
			const space = $createTextNode(" ");
			last.insertAfter(space);
			space.insertAfter(chip);
		}
		last = chip;
	});
}

/** Remove a chip and one following space so the words around it don't double-space. */
function $removeChip(chip: LexicalNode): void {
	const next = chip.getNextSibling();
	if ($isTextNode(next) && next.getTextContent().startsWith(" ")) {
		if (next.getTextContent() === " ") next.remove();
		else next.setTextContent(next.getTextContent().slice(1));
	}
	chip.remove();
}

function $removeImageTokens(remove: (path: string) => boolean, attachments = false): void {
	for (const child of $composerLeaves()) {
		if (child instanceof ComposerTokenNode && (child.__kind === "image" || (attachments && child.__kind === "attachment")) && remove(child.__value)) $removeChip(child);
	}
}

function $documentOffsetForPoint(targetNode: LexicalNode, pointOffset: number): number | undefined {
	let offset = 0;
	let found = false;
	const visit = (node: LexicalNode): void => {
		if (found) return;
		if (node.getKey() === targetNode.getKey()) {
			if ($isTextNode(node)) offset += pointOffset;
			else if ($isElementNode(node)) {
				for (const child of node.getChildren().slice(0, pointOffset)) offset += child.getTextContent().length;
			}
			found = true;
			return;
		}
		if ($isElementNode(node)) {
			for (const child of node.getChildren()) visit(child);
		} else {
			offset += node.getTextContent().length;
		}
	};
	const rootChildren = $getRoot().getChildren();
	for (const [index, child] of rootChildren.entries()) {
		visit(child);
		if (found) return offset;
		if (index < rootChildren.length - 1) offset += 1;
	}
	return undefined;
}

function $wrapSelectionWithMarkdown(opening: string, closing: string, codeBlock = false): boolean {
	let selection = $getSelection();
	if (!$isRangeSelection(selection)) {
		$getRoot().selectEnd();
		selection = $getSelection();
	}
	if (!$isRangeSelection(selection)) return false;
	if (!selection.isCollapsed() && selection.getNodes().some((node) => node instanceof ComposerTokenNode)) return false;

	let selectedText = selection.getTextContent();
	let openingText = opening;
	let closingText = closing;
	if (codeBlock) {
		const anchorOffset = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
		const focusOffset = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
		if (anchorOffset !== undefined && focusOffset !== undefined) {
			const source = $serializeComposer();
			const start = Math.min(anchorOffset, focusOffset);
			const end = Math.max(anchorOffset, focusOffset);
			const before = source.slice(0, start);
			const after = source.slice(end);
			selectedText = source.slice(start, end);
			openingText = `${before && !before.endsWith("\n") ? "\n" : ""}${opening}`;
			closingText = `${closing}${after && !after.startsWith("\n") ? "\n" : ""}`;
		}
	}
	const anchorOffset = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
	const focusOffset = $documentOffsetForPoint(selection.focus.getNode(), selection.focus.offset);
	const start = Math.min(anchorOffset ?? 0, focusOffset ?? 0);
	$addUpdateTag(HISTORY_PUSH_TAG);
	selection.insertText(`${openingText}${selectedText}${closingText}`);
	const insertedSelection = $getSelection();
	if ($isRangeSelection(insertedSelection) && (codeBlock || !selectedText)) {
		const target = start + openingText.length + selectedText.length;
		$selectComposerOffset(target, insertedSelection.anchor);
		$selectComposerOffset(target, insertedSelection.focus);
	}
	return true;
}

function editorSnapshot(): ComposerEditorSnapshot {
	const text = $serializeComposer();
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
		return { text, hasText: text.trim().length > 0 };
	}

	const anchor = selection.anchor;
	const node = anchor.getNode();
	if (!$isTextNode(node) || anchor.type !== "text") {
		return { text, hasText: text.trim().length > 0 };
	}

	const active = findActiveTrigger(node.getTextContent(), anchor.offset);
	if (!active) return { text, hasText: text.trim().length > 0 };
	return {
		text,
		hasText: text.trim().length > 0,
		trigger: {
			...active,
			key: `${node.getKey()}:${active.start}`,
			nodeKey: node.getKey(),
			end: anchor.offset,
		},
	};
}

function focusEditor(editor: LexicalEditor): void {
	editor.focus();
	const root = editor.getRootElement();
	if (root && document.activeElement !== root) root.focus({ preventScroll: true });
}

const EditorBridge = forwardRef<
	ComposerEditorHandle,
	{
		disabled?: boolean;
		menuOpen: boolean;
		promptSuggestion?: ComposerPromptSuggestion;
		onDismissSuggestion: () => void;
		/** Paths of the files and images attached right now. */
		attachedImages: () => string[];
		compositionState: { current: boolean };
		compositionEndScheduler: { current: () => void };
		onChange: (snapshot: ComposerEditorSnapshot) => void;
		onComplete: (snapshot: ComposerEditorSnapshot, key: "Enter" | "Tab") => string | undefined;
		onEnter: (snapshot: ComposerEditorSnapshot, event: globalThis.KeyboardEvent) => boolean;
	}
>(function EditorBridge({ disabled, menuOpen, promptSuggestion, onDismissSuggestion, attachedImages, compositionState, compositionEndScheduler, onChange, onComplete, onEnter }, ref) {
	const [editor] = useLexicalComposerContext();
	const lastSelection = useRef<RangeSelection | null>(null);
	// A range stays intact while the picker/stager is pending. Only acceptance
	// replaces it, so cancellation is content-neutral and undo restores the range.
	const attachmentRanges = useRef(new Map<string, { selection: RangeSelection; text: string }>());
	const attachmentRangeId = useRef(0);

	useEffect(() => editor.setEditable(!disabled), [disabled, editor]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => focusEditor(editor),
			insertText: (text) => {
				if (!editor.isEditable() || editor.isComposing()) return;
				editor.update(() => {
					if (!$isRangeSelection($getSelection())) {
						const saved = lastSelection.current;
						if (saved && $getNodeByKey(saved.anchor.key) && $getNodeByKey(saved.focus.key)) $setSelection(saved.clone());
						else $getRoot().selectEnd();
					}
					$addUpdateTag(HISTORY_PUSH_TAG);
					$normalizeCodeRangeSelection(text);
					const selection = $getSelection();
					if ($isRangeSelection(selection)) selection.insertRawText(text);
				}, { discrete: true });
				focusEditor(editor);
			},
			clear: () => {
				editor.update(() => {
					$replaceEditorText("");
					editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
				}, {
					discrete: true,
					tag: PROGRAMMATIC_TEXT_UPDATE_TAG,
				});
			},
			setText: (text, caret) => {
				editor.update(() => {
					$replaceEditorText(text, attachedImages(), caret);
					editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
				}, {
					discrete: true,
					tag: PROGRAMMATIC_TEXT_UPDATE_TAG,
				});
			},
			wrapInlineCode: () => {
				if (editor.isComposing()) return false;
				let applied = false;
				editor.update(() => {
					applied = $wrapSelectionWithMarkdown("`", "`");
				}, { discrete: true });
				return applied;
			},
			wrapCodeBlock: () => {
				if (editor.isComposing()) return false;
				let applied = false;
				editor.update(() => {
					applied = $wrapSelectionWithMarkdown("```\n", "\n```", true);
				}, { discrete: true });
				return applied;
			},
			insertToken: (trigger, value) => {
				editor.update(() => {
					$insertComposerToken(trigger, value);
				}, { discrete: true });
			},
			insertReference: (path, display, wire) => {
				editor.update(() => {
					$insertComposerReference(path, display, wire);
				}, { discrete: true });
			},
			reserveAttachments: () => {
				let reservation: string | undefined;
				editor.update(() => {
					const saved = lastSelection.current;
					if (saved && $getNodeByKey(saved.anchor.key) && $getNodeByKey(saved.focus.key)) $setSelection(saved.clone());
					const selection = $getSelection();
					if ($isRangeSelection(selection) && !selection.isCollapsed()) {
						reservation = `attachment-range-${++attachmentRangeId.current}`;
						attachmentRanges.current.set(reservation, { selection: selection.clone(), text: selection.getTextContent() });
					} else {
						reservation = $reserveImages(false);
					}
				}, { discrete: true });
				return reservation;
			},
			reserveImages: () => {
				let reservation: string | undefined;
				editor.update(() => {
					reservation = $reserveImages();
				}, { discrete: true });
				return reservation;
			},
			fillImages: (reservation, paths) => {
				editor.update(() => $fillImages(reservation, paths), { discrete: true });
			},
			fillAttachments: (reservation, paths) => {
				const range = attachmentRanges.current.get(reservation);
				attachmentRanges.current.delete(reservation);
				if (range && !paths.length) return;
				editor.update(() => {
					if (range) {
						const { selection, text } = range;
						// A replaced draft or a user edit to this range invalidates the
						// bookmark; never overwrite new content when staging completes.
						const anchor = $getNodeByKey(selection.anchor.key);
						const focus = $getNodeByKey(selection.focus.key);
						if (!anchor || !focus || selection.anchor.offset > anchor.getTextContentSize() ||
							selection.focus.offset > focus.getTextContentSize() || selection.getTextContent() !== text) return;
						$setSelection(selection.clone());
						$addUpdateTag(HISTORY_PUSH_TAG);
						const replacement = $reserveImages(false);
						if (replacement) $fillImages(replacement, paths, true);
					} else {
						$fillImages(reservation, paths, true);
					}
				}, { discrete: true });
			},
			removeAttachment: (path) => {
				editor.update(() => $removeImageTokens((candidate) => candidate === path, true), { discrete: true });
			},
			pruneAttachments: (attached) => {
				editor.update(() => $removeImageTokens((candidate) => !attached.includes(candidate), true), { discrete: true });
			},
			removeImage: (path) => {
				editor.update(() => $removeImageTokens((candidate) => candidate === path), { discrete: true });
			},
			pruneImages: (attached) => {
				editor.update(() => $removeImageTokens((candidate) => !attached.includes(candidate)), { discrete: true });
			},
			getSnapshot: () => editor.getEditorState().read(editorSnapshot),
			caretBoundary: () => editor.read(() => $caretBoundary(editor)),
		}),
		[attachedImages, editor],
	);

	useLayoutEffect(() => {
		let disposed = false;
		let formatScheduled = false;
		const formatAfterTextUpdate = (compositionEnded = false) => {
			if (
				formatScheduled || compositionState.current ||
				(!compositionEnded && editor.isComposing())
			) return;
			formatScheduled = true;
			queueMicrotask(() => {
				formatScheduled = false;
				if (
					disposed || compositionState.current ||
					(!compositionEnded && editor.isComposing())
				) return;
				editor.update(() => $formatComposerMarkdown(), {
					discrete: true,
					// Presentation belongs to the edit that triggered recognition.
					tag: [COMPOSER_MARKDOWN_FORMAT_TAG, HISTORY_MERGE_TAG],
				});
			});
		};
		const formatAfterComposition = () => formatAfterTextUpdate(true);
		compositionEndScheduler.current = formatAfterComposition;
		const dismissIfNotEmpty = () => {
			if (promptSuggestion && $serializeComposer().length > 0) onDismissSuggestion();
		};
		editor.getEditorState().read(dismissIfNotEmpty);
		const unregister = editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
			editorState.read(() => {
				dismissIfNotEmpty();
				const selection = $getSelection();
				if ($isRangeSelection(selection)) lastSelection.current = selection.clone();
			});
			if (tags.has(COMPOSER_MARKDOWN_FORMAT_TAG)) return;
			const text = editorState.read($serializeComposer);
			const previousText = prevEditorState.read($serializeComposer);
			if (!tags.has(PROGRAMMATIC_TEXT_UPDATE_TAG)) {
				editorState.read(() => onChange(editorSnapshot()));
			}
			if (
				!tags.has(PROGRAMMATIC_TEXT_UPDATE_TAG) &&
				!tags.has(COMPOSER_CODE_LANGUAGE_TAG) &&
				!tags.has(HISTORIC_TAG) &&
				text !== previousText
			) {
				formatAfterTextUpdate();
			}
		});
		return () => {
			disposed = true;
			unregister();
			if (compositionEndScheduler.current === formatAfterComposition) {
				compositionEndScheduler.current = () => undefined;
			}
		};
	}, [compositionEndScheduler, compositionState, editor, onChange, onDismissSuggestion, promptSuggestion]);

	useEffect(() => {
		const commands = [
			editor.registerCommand(
				BEFORE_INPUT_COMMAND,
				(event) => {
					if (event.inputType !== "insertText" || event.isComposing || editor.isComposing() || compositionState.current) return false;
					const selection = $getSelection();
					if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					const offset = $documentOffsetForPoint(selection.anchor.getNode(), selection.anchor.offset);
					if (composerCodeRegions($serializeComposer()).some((region) => offset === region.start || offset === region.end)) {
						// Keep native target-range resolution from pulling an outside caret
						// into the visible code text before controlled insertion runs.
						selection.dirty = true;
						selection.format = 0;
						selection.style = "";
					}
					return false;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				CONTROLLED_TEXT_INSERTION_COMMAND,
				(input) => {
					if (!editor.isComposing() && !compositionState.current) {
						const text = typeof input === "string" ? input : (input.dataTransfer?.getData("text/plain") ?? input.data);
						if (text !== null && text !== undefined) $normalizeCodeRangeSelection(text);
					}
					return false;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				PASTE_COMMAND,
				(event) => {
					if (editor.isComposing() || compositionState.current || !event || !("clipboardData" in event)) return false;
					const clipboard = event.clipboardData;
					const text = clipboard?.getData("text/plain") || clipboard?.getData("text/uri-list");
					// Lexical's plain-text paste normalizes CRLF to LF; restored drafts retain their original line endings.
					if (text) $normalizeCodeRangeSelection(text.replace(/\r\n/g, "\n"));
					return false;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				CUT_COMMAND,
				(event) => {
					if (editor.isComposing() || compositionState.current) return false;
					const copied = $normalizeCodeRangeSelection();
					if (copied === undefined || !event || !("clipboardData" in event) || !event.clipboardData) return false;
					event.clipboardData.setData("text/plain", copied);
					event.preventDefault();
					$addUpdateTag(CUT_TAG);
					const selection = $getSelection();
					if ($isRangeSelection(selection)) selection.removeText();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				DELETE_CHARACTER_COMMAND,
				() => {
					if (!editor.isComposing() && !compositionState.current) $normalizeCodeRangeSelection();
					return false;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_BACKSPACE_COMMAND,
				(event) => !editor.isComposing() && !compositionState.current && $codeEdgeKey(event, -1, true),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_DELETE_COMMAND,
				(event) => !editor.isComposing() && !compositionState.current && $codeEdgeKey(event, 1, true),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_LEFT_COMMAND,
				(event) => !editor.isComposing() && !compositionState.current && $codeEdgeKey(event, -1),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_RIGHT_COMMAND,
				(event) => !editor.isComposing() && !compositionState.current && $codeEdgeKey(event, 1),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => !menuOpen && !editor.isComposing() && !compositionState.current && $exitComposerCode(event, -1, true),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => !menuOpen && !editor.isComposing() && !compositionState.current && $exitComposerCode(event, 1, true),
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				SELECTION_CHANGE_COMMAND,
				() => {
					if (editor.isComposing() || compositionState.current) return false;
					const selection = $getSelection();
					if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					const node = selection.anchor.getNode();
					if ($isTextNode(node) && node.getStyle() === COMPOSER_MARKER_STYLE) {
						const offset = $documentOffsetForPoint(node, selection.anchor.offset);
						if (offset !== undefined) {
							$selectComposerOffset(offset, selection.anchor);
							$selectComposerOffset(offset, selection.focus);
						}
					}
					return false;
				},
				COMMAND_PRIORITY_HIGH,
			),
		];
		return () => commands.forEach((unregister) => unregister());
	}, [compositionState, editor, menuOpen]);

	useEffect(() => {
		const complete = (event: globalThis.KeyboardEvent | null, key: "Enter" | "Tab") => {
			// The React capture handler owns send/menu keys before Lexical's native
			// bubble listener. A prevented event was already handled there and must not
			// also insert a newline or a second completion token.
			if (event?.defaultPrevented) return true;
			if (event?.isComposing || event?.shiftKey || editor.isComposing()) return false;
			if (key === "Enter" && $selectionIsInsideOpenComposerCodeFence()) return false;
			const snapshot = editorSnapshot();
			if (
				key === "Tab" && promptSuggestion && !snapshot.text &&
				!event?.altKey && !event?.ctrlKey && !event?.metaKey
			) {
				const selection = $getSelection();
				if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
				$addUpdateTag(HISTORY_PUSH_TAG);
				// End a generated @path or /skill with a boundary, including after draft
				// restore. Outgoing text is trimmed; ordinary prose stays unchanged.
				const trailingTrigger = findActiveTrigger(promptSuggestion.text, promptSuggestion.text.length);
				selection.insertText(promptSuggestion.text + (trailingTrigger ? " " : ""));
				onDismissSuggestion();
				if (event) {
					completionHandledEvents.add(event);
					event.preventDefault();
				}
				return true;
			}
			const value = onComplete(snapshot, key);
			if (snapshot.trigger && value) {
				if (!$insertComposerToken(snapshot.trigger, value)) return false;
				if (event) {
					completionHandledEvents.add(event);
					event.preventDefault();
				}
				return true;
			}
			if (key === "Enter" && event && onEnter(snapshot, event)) {
				completionHandledEvents.add(event);
				event.preventDefault();
				return true;
			}
			return false;
		};
		const removeEnter = editor.registerCommand(
			KEY_ENTER_COMMAND,
			(event) => {
				if (event?.isComposing || editor.isComposing() || compositionState.current) return false;
				if (!event?.defaultPrevented && $insertComposerCodeNewline(event?.shiftKey)) {
					event?.preventDefault();
					return true;
				}
				if (event?.shiftKey) return false;
				if (complete(event, "Enter")) return true;
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		const removeTab = editor.registerCommand(
			KEY_TAB_COMMAND,
			(event) => {
				if (event.isComposing || editor.isComposing() || compositionState.current) return false;
				if (complete(event, "Tab")) return true;
				return !menuOpen && $exitComposerCode(event, 1);
			},
			COMMAND_PRIORITY_HIGH,
		);
		const removeEscape = editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
			if (!promptSuggestion || $serializeComposer() || event.isComposing || editor.isComposing()) return false;
			onDismissSuggestion();
			completionHandledEvents.add(event);
			event.preventDefault();
			event.stopPropagation();
			return true;
		}, COMMAND_PRIORITY_HIGH);
		return () => {
			removeEnter();
			removeTab();
			removeEscape();
		};
	}, [compositionState, editor, menuOpen, onComplete, onDismissSuggestion, onEnter, promptSuggestion]);

	return null;
});

/**
 * Fades a changing placeholder (the orchestrator's start-up steps) out, swaps
 * the text, and fades it back in. Fast on purpose. The first text mounts
 * directly.
 */
const PLACEHOLDER_FADE_MS = 80;

function FadingPlaceholder({ text }: { text: string }) {
	const [shown, setShown] = useState(text);
	useEffect(() => {
		if (text === shown) return;
		const timer = setTimeout(() => setShown(text), PLACEHOLDER_FADE_MS);
		return () => clearTimeout(timer);
	}, [text, shown]);
	return (
		<span
			className="transition-opacity ease-out motion-reduce:transition-none"
			style={{ opacity: text === shown ? 1 : 0, transitionDuration: `${PLACEHOLDER_FADE_MS}ms` }}
		>
			{shown}
		</span>
	);
}

export const ComposerEditor = forwardRef<
	ComposerEditorHandle,
	{
		disabled?: boolean;
		/** Hides the text while a send is in flight; the draft is still held for recovery. */
		concealed?: boolean;
		label: string;
		placeholder: string;
		promptSuggestion?: ComposerPromptSuggestion;
		menuOpen: boolean;
		menuId: string;
		activeIndex: number;
		images?: ComposerImage[];
		attachments?: { path: string; folder?: boolean }[];
		onChange: (snapshot: ComposerEditorSnapshot) => void;
		onComplete: (snapshot: ComposerEditorSnapshot, key: "Enter" | "Tab") => string | undefined;
		onEnter: (snapshot: ComposerEditorSnapshot, event: globalThis.KeyboardEvent) => boolean;
		onCompositionChange: (isComposing: boolean) => void;
		onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
		onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
	}
>(function ComposerEditor(
	{
		disabled,
		concealed,
		label,
		placeholder,
		promptSuggestion,
		menuOpen,
		menuId,
		activeIndex,
		images = [],
		attachments = [],
		onChange,
		onComplete,
		onEnter,
		onCompositionChange,
		onKeyDown,
		onPaste,
	},
	ref,
) {
	const { t } = useTranslation();
	const suggestionDescriptionId = useId();
	const [dismissedSuggestionId, setDismissedSuggestionId] = useState<string>();
	const suggestion = !disabled && !concealed && promptSuggestion?.id !== dismissedSuggestionId
		? promptSuggestion
		: undefined;
	const dismissSuggestion = useCallback(() => {
		if (promptSuggestion) {
			setDismissedSuggestionId(promptSuggestion.id);
			promptSuggestion.onDismiss?.();
		}
	}, [promptSuggestion]);
	const initialConfig = {
		namespace: "AOChatComposer",
		nodes: [ComposerTokenNode, ComposerCodeNode, ComposerCodePlaceholderNode],
		editable: !disabled,
		theme: {
			paragraph: "m-0",
			text: {
				code: "chat-composer-markdown-code rounded bg-surface px-[5px] py-[2px] font-mono text-[0.9em] text-markdown-code",
			},
		},
		onError(error: Error) {
			throw error;
		},
	};
	const compositionState = useRef(false);
	const compositionEndScheduler = useRef<() => void>(() => undefined);

	// Read at setText time, not render time, so a draft restore sees the
	// attachments it was restored with.
	const imagesRef = useRef([...images, ...attachments]);
	imagesRef.current = [...images, ...attachments];
	const attachedImages = useCallback(() => imagesRef.current.map((image) => image.path), []);

	const placeholderNode = useCallback(
		() => (
			<div className={cn(
				"py-1 pl-[7px] text-base! leading-relaxed text-muted-foreground",
				suggestion
					? "min-h-[4.5rem] whitespace-pre-wrap break-words"
					: "pointer-events-none absolute inset-x-0 top-0",
			)}>
				{suggestion ? <span data-testid="prompt-suggestion">{suggestion.text}</span> : <FadingPlaceholder text={placeholder} />}
			</div>
		),
		[placeholder, suggestion],
	);

	return (
		<LexicalComposer initialConfig={initialConfig}>
			<ComposerAttachments.Provider value={attachments}>
			<ComposerImages.Provider value={images}>
			<div className={cn("relative", suggestion && "chat-composer-scrollbar max-h-40 overflow-y-auto overscroll-contain")}>
				<PlainTextPlugin
					contentEditable={
						<ContentEditable
							aria-label={label}
							aria-placeholder={placeholder}
							aria-describedby={suggestion ? suggestionDescriptionId : undefined}
							placeholder={placeholderNode}
							aria-disabled={disabled || undefined}
							role="combobox"
							aria-expanded={menuOpen}
							aria-controls={menuOpen ? menuId : undefined}
							aria-activedescendant={
								menuOpen ? `${menuId}-option-${activeIndex}` : undefined
							}
							aria-autocomplete={suggestion ? "both" : "list"}
							onCompositionStart={() => {
								compositionState.current = true;
								onCompositionChange(true);
							}}
							onCompositionEnd={() => {
								compositionState.current = false;
								onCompositionChange(false);
								window.setTimeout(() => compositionEndScheduler.current(), 0);
							}}
							onKeyDown={(event) => {
								if (!completionHandledEvents.has(event.nativeEvent)) onKeyDown(event);
							}}
							onPasteCapture={(event) => {
								onPaste(event);
								if (event.defaultPrevented) event.stopPropagation();
							}}
							className={cn(
								"chat-composer-scrollbar max-h-40 has-[.chat-composer-code-block]:max-h-[min(24rem,50vh)] min-h-[4.5rem] w-full overflow-y-auto overscroll-contain bg-transparent py-1 pl-[7px] pr-0 text-base! leading-relaxed text-foreground caret-foreground outline-none selection:bg-foreground selection:text-background",
								suggestion && "absolute inset-0 overflow-visible overscroll-auto",
								concealed ? "invisible" : disabled && "opacity-50",
							)}
						/>
					}
					ErrorBoundary={LexicalErrorBoundary}
				/>
				{concealed ? <div aria-hidden="true">{placeholderNode()}</div> : null}
				{suggestion ? (
					<span id={suggestionDescriptionId} className="sr-only">
						{t("chat.promptSuggestion.description", { prompt: suggestion.text })}
					</span>
				) : null}
				<HistoryPlugin />
				<ComposerCodePlugin />
				<EditorBridge
					ref={ref}
					disabled={disabled}
					menuOpen={menuOpen}
					promptSuggestion={suggestion}
					onDismissSuggestion={dismissSuggestion}
					attachedImages={attachedImages}
					compositionState={compositionState}
					compositionEndScheduler={compositionEndScheduler}
					onChange={onChange}
					onComplete={onComplete}
					onEnter={onEnter}
				/>
			</div>
			</ComposerImages.Provider>
			</ComposerAttachments.Provider>
		</LexicalComposer>
	);
});
