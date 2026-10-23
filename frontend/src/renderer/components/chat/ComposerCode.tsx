import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isTextNode,
	ElementNode,
	DecoratorNode,
	HISTORY_PUSH_TAG,
	SKIP_DOM_SELECTION_TAG,
	setDOMUnmanaged,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedElementNode,
	type Spread,
} from "lexical";
import { Check, Copy } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../../lib/bridge";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { composerCodeRegions } from "./composerMarkdown";

type SerializedComposerCode = Spread<{ kind: "inline" | "fenced" }, SerializedElementNode>;

export const COMPOSER_CODE_LANGUAGE_TAG = "ao:composer-code-language";

export class ComposerCodePlaceholderNode extends DecoratorNode<null> {
	static getType(): string {
		return "composer-code-placeholder";
	}
	static clone(node: ComposerCodePlaceholderNode): ComposerCodePlaceholderNode {
		return new ComposerCodePlaceholderNode(node.__key);
	}
	static importJSON(): ComposerCodePlaceholderNode {
		return new ComposerCodePlaceholderNode();
	}
	exportJSON() {
		return { type: ComposerCodePlaceholderNode.getType(), version: 1 };
	}
	getTextContent(): string {
		return "";
	}
	createDOM(): HTMLElement {
		return document.createElement("br");
	}
	updateDOM(): boolean {
		return false;
	}
	isInline(): boolean {
		return true;
	}
	isKeyboardSelectable(): boolean {
		return false;
	}
	decorate(): null {
		return null;
	}
}

export class ComposerCodeNode extends ElementNode {
	__kind: "inline" | "fenced";
	static getType(): string {
		return "composer-code";
	}
	static clone(node: ComposerCodeNode): ComposerCodeNode {
		return new ComposerCodeNode(node.__kind, node.__key);
	}
	constructor(kind: "inline" | "fenced" = "inline", key?: NodeKey) {
		super(key);
		this.__kind = kind;
	}
	static importJSON(value: SerializedComposerCode): ComposerCodeNode {
		return new ComposerCodeNode(value.kind).updateFromJSON(value);
	}
	exportJSON(): SerializedComposerCode {
		return { ...super.exportJSON(), kind: this.__kind };
	}
	isInline(): boolean {
		return true;
	}
	createDOM(_config: EditorConfig): HTMLElement {
		const dom = document.createElement("span");
		dom.className = this.__kind === "fenced" ? "chat-composer-code-block" : "chat-composer-inline-code";
		if (this.__kind === "fenced") {
			const header = document.createElement("span");
			header.contentEditable = "false";
			setDOMUnmanaged(header, { captureSelection: true });
			header.dataset.composerCodeToolbar = "";
			const body = document.createElement("span");
			body.className = "chat-composer-code-body";
			body.id = `composer-code-${this.getKey()}`;
			const caretLine = document.createElement("br");
			caretLine.setAttribute("aria-hidden", "true");
			setDOMUnmanaged(caretLine);
			body.append(caretLine);
			const footer = document.createElement("span");
			footer.contentEditable = "false";
			setDOMUnmanaged(footer, { captureSelection: true });
			footer.dataset.composerCodeFooter = "";
			dom.append(header, body, footer);
		}
		return dom;
	}
	getDOMSlot(dom: HTMLElement) {
		if (this.__kind !== "fenced") return super.getDOMSlot(dom);
		const body = dom.children[1] as HTMLElement;
		return super.getDOMSlot(dom).withElement(body).withBefore(body.lastChild);
	}
	updateDOM(): boolean {
		return false;
	}
}

const languages = [
	"text",
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"diff",
	"go",
	"html",
	"java",
	"javascript",
	"json",
	"jsx",
	"kotlin",
	"markdown",
	"php",
	"python",
	"ruby",
	"rust",
	"sql",
	"swift",
	"toml",
	"tsx",
	"typescript",
	"xml",
	"yaml",
];

function CodeControls({ nodeKey, dom, source }: { nodeKey: string; dom: HTMLElement; source: string }) {
	const [editor] = useLexicalComposerContext();
	const { t } = useTranslation();
	const region = composerCodeRegions(source)[0];
	const language = region?.language || "text";
	const code = region ? source.slice(region.contentStart, region.contentEnd) : "";
	const [expanded, setExpanded] = useState(false);
	const [overflow, setOverflow] = useState(false);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [editable, setEditable] = useState(editor.isEditable());
	useEffect(() => editor.registerEditableListener(setEditable), [editor]);
	useEffect(() => () => clearTimeout(timer.current), []);
	useLayoutEffect(() => {
		const body = dom.children[1] as HTMLElement;
		const measure = () => setOverflow(body.scrollHeight > 160);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, [dom, source]);
	useLayoutEffect(() => {
		const body = dom.children[1] as HTMLElement;
		body.style.maxHeight = expanded ? "none" : "160px";
	}, [dom, expanded]);
	const copy = () => {
		void aoBridge.clipboard.writeText(code).then(
			() => {
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1400);
			},
			() => undefined,
		);
	};
	return (
		<>
			{createPortal(
				<span
					className="flex items-center justify-between gap-2 px-2 py-1"
					onKeyDown={(event) => event.stopPropagation()}
					onPaste={(event) => event.stopPropagation()}
				>
					<Select
						value={language}
						disabled={!editable}
						onValueChange={(value) => {
							editor.update(
								() => {
									const node = $getNodeByKey(nodeKey);
									const marker = $isElementNode(node) ? node.getFirstChild() : null;
									if ($isTextNode(marker)) {
										const opening = marker.getTextContent();
										marker.setTextContent(
											opening.replace(
												/^( {0,3}`{3,})[^\r\n]*/,
												(_, fence: string) => fence + (value === "text" ? "" : value),
											),
										);
									}
								},
								{ tag: [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG, COMPOSER_CODE_LANGUAGE_TAG], discrete: true },
							);
						}}
					>
						<SelectTrigger
							size="auto"
							aria-label={t("chat.composer.codeLanguage")}
							className="h-7 bg-transparent px-1 text-xs"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(languages.includes(language) ? languages : [language, ...languages]).map((value) => (
								<SelectItem key={value} value={value}>
									{value === "text" ? t("chat.composer.plainText") : value}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						onClick={copy}
						aria-label={copied ? t("chat.composer.codeCopied") : t("chat.composer.copyCode")}
						className="size-7 focus-visible:ring-1 focus-visible:ring-ring"
					>
						{copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
					</Button>
					<span className="sr-only" role="status">
						{copied ? t("chat.composer.codeCopied") : ""}
					</span>
				</span>,
				dom.children[0],
			)}
			{overflow
				? createPortal(
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-expanded={expanded}
							aria-controls={(dom.children[1] as HTMLElement).id}
							onKeyDown={(event) => event.stopPropagation()}
							onClick={() => setExpanded(!expanded)}
							className="m-1 h-7 rounded-none text-xs text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
						>
							{expanded ? t("chat.composer.showLessCode") : t("chat.composer.showMoreCode")}
						</Button>,
						dom.children[2],
					)
				: null}
		</>
	);
}

export function ComposerCodePlugin() {
	const [editor] = useLexicalComposerContext();
	const [blocks, setBlocks] = useState<{ key: string; source: string; dom: HTMLElement }[]>([]);
	useLayoutEffect(() => {
		const update = () =>
			editor.getEditorState().read(() => {
				const next: typeof blocks = [];
				const visit = (node: LexicalNode) => {
					if (node instanceof ComposerCodeNode && node.__kind === "fenced") {
						const dom = editor.getElementByKey(node.getKey());
						if (dom) next.push({ key: node.getKey(), source: node.getTextContent(), dom });
					} else if ($isElementNode(node)) node.getChildren().forEach(visit);
				};
				visit($getRoot());
				setBlocks((old) =>
					old.length === next.length &&
					old.every(
						(block, index) =>
							block.key === next[index].key && block.source === next[index].source && block.dom === next[index].dom,
					)
						? old
						: next,
				);
			});
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);
	return blocks.map((block) => (
		<CodeControls key={block.key} nodeKey={block.key} dom={block.dom} source={block.source} />
	));
}
