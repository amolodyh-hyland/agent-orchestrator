import { findBlocks, renderedFindBlocks } from "../lib/chat-find";
import findUserFixtures from "../../../../test/chat-find-user-source.json";
import { ChatFindEngagedContext } from "../components/chat/ChatFindUserProjection";
import { StrictMode, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../components/ui/tooltip";
import { HumanMessage } from "../components/chat/ChatTimelineItems";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatFind } from "./useChatFind";
import type { ConversationMessage, ConversationSnapshot } from "../types/conversation";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { useUiStore } from "../stores/ui-store";
import { aoBridge } from "../lib/bridge";
import { ChatMarkdown } from "../components/chat/ChatMarkdown";

const get = vi.hoisted(() => vi.fn());
vi.mock("../lib/host-clients", () => ({ clientForSessionHost: () => ({ GET: get }) }));
vi.mock("./useConversation", () => ({
	toSnapshot: (value: unknown) => value,
	mergeConversationPages: (pages: ConversationSnapshot[]) => ({ ...pages[0], items: [...pages[1].items, ...pages[0].items] }),
}));

const source: ConversationSnapshot = {
	conversationId: "c", sessionId: "s", activeBranchId: "b", harness: "codex", mode: "chat", controller: { state: "ready" },
	latestSequence: 10, oldestSequence: 10, hasMoreBefore: true, turns: [], settings: {},
	items: [{ kind: "message", id: "m", role: "user", origin: "human", text: "hello hello", sequence: 10, revision: 1, streaming: false, createdAt: "2026-11-03T00:00:00Z" }],
};
const hits = [{ messageId: "m", revision: 1, sequence: 10, block: 0, start: 0, end: 5 }, { messageId: "m", revision: 1, sequence: 10, block: 0, start: 6, end: 11 }];
function projectedHit(text: string, query: string) {
	const blocks = findBlocks(text, true);
	const block = blocks.findIndex((value) => value.includes(query));
	if (block < 0) throw new Error(`Missing canonical query ${query}`);
	const start = blocks[block].indexOf(query);
	return { ...hits[0], block, start, end: start + query.length };
}

const reveal = vi.fn(), pause = vi.fn(), send = vi.fn(), interrupt = vi.fn();

function Harness({ snapshot = source, markdown = false, formattedUser = false, unavailable = false }: { snapshot?: ConversationSnapshot; markdown?: boolean; formattedUser?: boolean; unavailable?: boolean }) {
	const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
	const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
	const find = useChatFind({ source: snapshot, root, viewport, reveal, pauseFollow: pause, unavailable });
	return <QueryClientProvider client={client}><TooltipProvider><ChatFindEngagedContext.Provider value={find.open && find.engaged && !unavailable}><section data-chat-find-scope="" onKeyDown={(event) => { if (event.key === "Escape") interrupt(); }}>
		<div ref={root} data-chat-find-surface="">{find.bar}<div ref={viewport} tabIndex={-1}>{find.snapshot.items.map((item) => <div key={item.id} data-find-message-id={formattedUser && item.kind === "message" && item.role === "user" ? undefined : item.id}>{formattedUser && item.kind === "message" && item.role === "user" ? <HumanMessage message={item} sessionId={snapshot.sessionId} apiBaseUrl={null} /> : markdown && item.kind === "message" && item.role === "assistant" ? <div data-chat-message-body=""><ChatMarkdown text={item.text} streaming={item.streaming} /></div> : <p data-chat-message-body="">{item.kind === "message" ? item.text : ""}</p>}</div>)}</div></div>
		<textarea aria-label="Composer" defaultValue="draft" onKeyDown={(event) => { if (event.key === "Enter") send(); }} />
	</section></ChatFindEngagedContext.Provider></TooltipProvider></QueryClientProvider>;
}

let openFind: ((value: string, anchorMessageId?: string) => void) | undefined;
function OpenWithHarness() {
	const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
	const find = useChatFind({ source, root, viewport, reveal, pauseFollow: pause });
	openFind = find.openWith;
	return <section data-chat-find-scope=""><div ref={root} data-chat-find-surface="">{find.bar}<div ref={viewport} tabIndex={-1}>{find.snapshot.items.map((item) => <div key={item.id} data-find-message-id={item.id}><p data-chat-message-body="">{item.kind === "message" ? item.text : ""}</p></div>)}</div></div></section>;
}

async function tick(ms = 180) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function openAndSearch() {
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "f", ctrlKey: true }); await tick(20);
	fireEvent.change(screen.getByRole("searchbox", { name: "Find in chat" }), { target: { value: "hello" } }); await tick();
}

describe("find in chat interactions", () => {
	beforeEach(() => {
		vi.useFakeTimers(); get.mockReset(); reveal.mockClear(); pause.mockClear(); send.mockClear(); interrupt.mockClear();
		get.mockResolvedValue({ data: { conversationId: "c", transcriptRevision: "revision", occurrences: hits, total: 2 }, response: { status: 200 } });
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ top: 0, bottom: 100 }] as unknown as DOMRectList);
		Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ top: 20, height: 10 }) });
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		useKeybindingsStore.setState({ overrides: {} });
	});
	afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

	it("opens searching for a session search result's word, from the result's message", async () => {
		get.mockResolvedValue({ data: { conversationId: "c", transcriptRevision: "r", occurrences: hits, total: 2, offset: 0, initialIndex: 1 }, response: { status: 200 } });
		render(<OpenWithHarness />);
		act(() => openFind?.("hello", "m")); await tick(20); await tick();
		expect(screen.getByRole("searchbox")).toHaveValue("hello");
		expect(get.mock.calls[0][1].params.query).toMatchObject({ query: "hello", anchorMessageId: "m", anchorBlock: 0, anchorOffset: 0, fallbackToPrevious: false });
		expect(screen.getByText("2/2")).toBeInTheDocument();
		expect(reveal).toHaveBeenLastCalledWith(hits[1]);
		// Another result for the same word searches again from its own message
		// rather than keeping the active match.
		const calls = get.mock.calls.length;
		act(() => openFind?.("hello", "other")); await tick();
		expect(get.mock.calls.length).toBeGreaterThan(calls);
		expect(get.mock.calls.at(-1)?.[1].params.query).toMatchObject({ query: "hello", anchorMessageId: "other", fallbackToPrevious: false });
	});

	it("reveals and highlights a daemon occurrence after a rendered hard break without timing out", async () => {
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry });
		vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			const occurrence = { ...hits[0], start: 6, end: 12 };
			get.mockResolvedValue({ data: { conversationId: "c", transcriptRevision: "break", occurrences: [occurrence], total: 1 }, response: { status: 200 } });
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, role: "assistant", origin: "provider", text: "hello  \nneedle" };
			render(<Harness markdown snapshot={{ ...source, items: [message] }} />);
			fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
			await tick(20);
			fireEvent.change(screen.getByRole("searchbox"), { target: { value: "needle" } });
			await tick(3500);
			expect(screen.getByText("1/1")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(reveal).toHaveBeenCalledWith(occurrence);
			expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual(["needle"]);
			expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
		} finally { cleanup(); vi.unstubAllGlobals(); }
	});

	it.each([
		{ name: "inline code", text: "😀 BEFORE `const inside_inline = '%20';` AFTER尾", inside: "inside_inline" },
		{ name: "fenced code", text: "😀 BEFORE\n\n```text\nconst inside_fence = '%20';\n```\n\nAFTER尾", inside: "inside_fence" },
		{ name: "mixed literal prose and code", text: "  😀 BEFORE **literal** `inline_mixed`\n\n```text\nfence_mixed\n```\n\nAFTER尾", inside: "fence_mixed" },
	])("reveals real USER code and restores its formatted subtree: $name", async ({ text, inside }) => {
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry });
		vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			get.mockImplementation((_path: string, options: { params: { query: { query: string } } }) => {
				const query = options.params.query.query;
				return Promise.resolve({ data: { conversationId: "c", transcriptRevision: "user-projection", occurrences: [projectedHit(text, query)], total: 1 }, response: { status: 200 } });
			});
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text };
			const { container } = render(<StrictMode><Harness formattedUser snapshot={{ ...source, items: [message] }} /></StrictMode>);
			const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!;
			const normalCode = body.querySelector("code");
			expect(normalCode).toBeVisible();
			const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
			fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
			for (const query of ["BEFORE", inside, ...(text.includes("**literal**") ? ["literal", "inline_mixed"] : []), "AFTER尾"]) {
				fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } }); await tick(3500);
								expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual([query]);
				expect(reveal).toHaveBeenLastCalledWith(projectedHit(text, query));
				expect(screen.getByText("1/1")).toBeInTheDocument();
				expect(screen.queryByRole("alert")).not.toBeInTheDocument();
				expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
			}
			expect(renderedFindBlocks(body).map((block) => block.text)).toEqual(findBlocks(text, true));
			expect(within(body).queryAllByRole("button")).toHaveLength(0);
			expect(body.contains(normalCode)).toBe(true); expect(normalCode).not.toBeVisible();
			expect(normalCode?.closest("[inert][aria-hidden='true'][data-chat-find-exclude]")).not.toBeNull();
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); await tick(20);
			expect(body.querySelector("code")).toBe(normalCode); expect(normalCode).toBeVisible();
			expect(message.text).toBe(text); expect(composer).toHaveValue("draft"); expect(composer).toHaveFocus();
		} finally { cleanup(); vi.unstubAllGlobals(); }
	});

	it.each(findUserFixtures.filter((fixture) => ["combined filters", "retained absolute folder suffix"].includes(fixture.name)))("uses the backend canonical USER source: $name", async ({ source: text, text: canonical }) => {
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry }); vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			const query = canonical.includes("needle") ? "needle" : "/Users/me/Folder";
			const hit = projectedHit(canonical, query);
			get.mockResolvedValue({ data: { conversationId: "c", transcriptRevision: "cleaned", occurrences: [hit], total: 1 }, response: { status: 200 } });
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text };
			const { container } = render(<Harness formattedUser snapshot={{ ...source, items: [message] }} />);
			const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!;
			const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
			fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
			fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } }); await tick(3500);
			expect(renderedFindBlocks(body).map((block) => block.text)).toEqual(findBlocks(canonical, true));
			expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual([query]);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(reveal).toHaveBeenLastCalledWith(hit);
			expect(body.querySelector('[data-chat-find-projection="search"]')?.textContent).not.toContain("private");
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); await tick(20);
			expect(body.querySelector('[data-chat-find-projection="search"]')).toHaveTextContent("");
		} finally { cleanup(); vi.unstubAllGlobals(); }
	});

	it("isolates sibling and nested chats and unavailable find projections", async () => {
		const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text: "`needle`" };
		const { container } = render(<ChatFindEngagedContext.Provider value={true}>
			<div data-testid="first-chat"><Harness formattedUser snapshot={{ ...source, items: [message] }} /></div>
			<div data-testid="second-chat"><Harness formattedUser snapshot={{ ...source, conversationId: "other", items: [{ ...message, id: "other" }] }} /></div>
			<div data-testid="unavailable-chat"><Harness formattedUser unavailable snapshot={{ ...source, conversationId: "cloud", items: [{ ...message, id: "cloud" }] }} /></div>
		</ChatFindEngagedContext.Provider>);
		const first = screen.getByTestId("first-chat"), second = screen.getByTestId("second-chat"), unavailable = screen.getByTestId("unavailable-chat");
		const codes = [first, second, unavailable].map((chat) => chat.querySelector("code"));
		codes.forEach((code) => expect(code).toBeVisible());
		const composer = within(first).getByRole("textbox", { name: "Composer" }); composer.focus();
		fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
		expect(codes[0]).not.toBeVisible(); expect(codes[1]).toBeVisible(); expect(codes[2]).toBeVisible();
		act(() => within(second).getByRole("textbox", { name: "Composer" }).focus()); await tick(20);
		expect(codes[0]).toBeVisible();
		const cloudComposer = within(unavailable).getByRole("textbox", { name: "Composer" }); cloudComposer.focus();
		fireEvent.keyDown(cloudComposer, { key: "f", ctrlKey: true }); await tick(20);
		expect(codes[2]).toBeVisible(); expect(unavailable.querySelector('[data-chat-find-projection="search"]')).not.toBeVisible();
		expect(get).not.toHaveBeenCalled(); expect(container.querySelectorAll("[data-chat-message-body]")).toHaveLength(3);
	});

	it.each([false, true])("restores code state and focus after find under StrictMode, expanded=%s", async (expanded) => {
		vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.tagName === "PRE" ? 600 : 0; });
		const text = "```text\n" + Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n```";
		const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text };
		const { container } = render(<StrictMode><Harness formattedUser snapshot={{ ...source, items: [message] }} /></StrictMode>);
		const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!, code = body.querySelector("code"), pre = body.querySelector("pre");
		const collapse = within(body).getByRole("button", { name: "Show more" });
		if (expanded) fireEvent.click(collapse);
		const wrap = within(body).getByRole("button", { name: "Wrap long lines" });
		const wrapped = wrap.getAttribute("aria-pressed"); wrap.focus();
		const focus = wrap.focus.bind(wrap), restored = vi.spyOn(wrap, "focus").mockImplementation((options) => {
			expect(wrap.closest("[inert]")).toBeNull(); focus(options);
		});
		fireEvent.keyDown(wrap, { key: "f", ctrlKey: true }); await tick(20);
		expect(code).not.toBeVisible(); expect(within(body).queryAllByRole("button")).toHaveLength(0);
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); await tick(20);
		expect(body.querySelector("code")).toBe(code); expect(body.querySelector("pre")).toBe(pre);
		expect(collapse).toHaveAttribute("aria-expanded", String(expanded));
		expect(pre?.style.maxHeight).toBe(expanded ? "none" : "160px");
		expect(wrap).toHaveAttribute("aria-pressed", wrapped); expect(wrap).toHaveFocus(); expect(restored).toHaveBeenCalledTimes(1);
	});

	it("cancels focus restoration on identity change and unmount", async () => {
		const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text: "```text\nneedle\n```" };
		const view = render(<StrictMode><Harness formattedUser snapshot={{ ...source, items: [message] }} /></StrictMode>);
		const wrap = screen.getByRole("button", { name: "Wrap long lines" }); wrap.focus();
		const restore = vi.spyOn(wrap, "focus");
		fireEvent.keyDown(wrap, { key: "f", ctrlKey: true }); await tick(20);
		view.rerender(<StrictMode><Harness formattedUser snapshot={{ ...source, conversationId: "new", items: [message] }} /></StrictMode>); await tick(20);
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(); expect(restore).not.toHaveBeenCalled();
		const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
		fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
		view.unmount(); await tick(3500); expect(restore).not.toHaveBeenCalled();
	});

	it("expands auto-addresses only for the engaged chat and restores compact labels after closing find", async () => {
		const previousDisplay = useUiStore.getState().chatUrlDisplay;
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry });
		vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			useUiStore.setState({ chatUrlDisplay: "compact" });
			const url = "https://find.example.test/資料?q=%2520#節";
			const text = `😀 BEFORE ${url} AFTER尾`;
			const start = text.indexOf("%2520");
			const occurrence = { ...hits[0], start, end: start + "%2520".length };
			get.mockResolvedValue({ data: { conversationId: "c", transcriptRevision: "address", occurrences: [occurrence], total: 1 }, response: { status: 200 } });
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, role: "assistant", origin: "provider", text };
			render(<><Harness markdown snapshot={{ ...source, items: [message] }} /><Harness markdown snapshot={{ ...source, conversationId: "other", items: [message] }} /></>);
			const composers = screen.getAllByRole("textbox", { name: "Composer" });
			const first = within(composers[0].closest("section")!).getByRole("link", { name: url });
			const second = within(composers[1].closest("section")!).getByRole("link", { name: url });
			expect(first).toHaveTextContent("find.example.test");
			expect(second).toHaveTextContent("find.example.test");
			composers[0].focus();
			fireEvent.keyDown(composers[0], { key: "f", ctrlKey: true });
			await tick(20);
			expect(first).toHaveTextContent(url);
			expect(second).not.toHaveTextContent(url);
			fireEvent.change(screen.getByRole("searchbox"), { target: { value: "%2520" } });
			await tick(3500);
			expect(reveal).toHaveBeenCalledWith(occurrence);
			expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual(["%2520"]);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
			await tick(20);
			expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
			expect(within(composers[0].closest("section")!).getByRole("link", { name: url })).toBe(first);
			expect(first).toHaveTextContent("find.example.test");
			expect(first).not.toHaveTextContent(url);
			expect(useUiStore.getState().chatUrlDisplay).toBe("compact");
		} finally {
			cleanup();
			useUiStore.setState({ chatUrlDisplay: previousDisplay });
			vi.unstubAllGlobals();
		}
	});

	it.each([
		{ name: "authored link", text: "😀 BEFORE [Visible label](https://user.example.test/資料?q=%2520#節) AFTER尾", inside: "Visible label" },
	])("uses one canonical Markdown USER find projection and restores formatted state: $name", async ({ text, inside }) => {
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry });
		vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			get.mockImplementation((_path: string, options: { params: { query: { query: string } } }) => {
				const query = options.params.query.query;
								return Promise.resolve({ data: { conversationId: "c", transcriptRevision: "user-projection", occurrences: [projectedHit(text, query)], total: 1 }, response: { status: 200 } });
			});
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, text };
			const { container } = render(<Harness formattedUser snapshot={{ ...source, items: [message] }} />);
			const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!;
			const normalCode = body.querySelector("code");
			const normalLink = within(body).queryByRole("link", { name: "Visible label" });
			if (normalCode) expect(normalCode).toBeVisible();
			if (normalLink) expect(normalLink).toBeVisible();
			expect(normalCode ?? normalLink).not.toBeNull();
			const composer = screen.getByRole("textbox", { name: "Composer" });
			composer.focus();
			fireEvent.keyDown(composer, { key: "f", ctrlKey: true });
			await tick(20);
			expect(renderedFindBlocks(body).map((block) => block.text)).toEqual(findBlocks(text, true));
			if (normalCode) { expect(body.contains(normalCode)).toBe(true); expect(normalCode).not.toBeVisible(); }
			if (normalLink) { expect(body.contains(normalLink)).toBe(true); expect(normalLink).not.toBeVisible(); expect(within(body).queryByRole("link", { name: "Visible label" })).not.toBeInTheDocument(); }
			for (const query of ["BEFORE", inside, "AFTER尾"]) {
				fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
				await tick(3500);
								expect(reveal).toHaveBeenLastCalledWith(projectedHit(text, query));
				expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual([query]);
				expect(screen.getByText("1/1")).toBeInTheDocument();
				expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			}
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
			await tick(20);
			if (normalCode) { expect(body.querySelector("code")).toBe(normalCode); expect(normalCode).toBeVisible(); }
			if (normalLink) { expect(within(body).getByRole("link", { name: "Visible label" })).toBe(normalLink); expect(normalLink).toBeVisible(); }
			expect(message.text).toBe(text);
			expect(composer).toHaveValue("draft");
		} finally { cleanup(); vi.unstubAllGlobals(); }
	});


	it("preserves assistant address and fence block identities and canonical reveal ranges", async () => {
		const previous = { chatUrlDisplay: useUiStore.getState().chatUrlDisplay, chatPathDisplay: useUiStore.getState().chatPathDisplay };
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry }); vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			useUiStore.setState({ chatUrlDisplay: "compact", chatPathDisplay: "compact" });
			const text = "😀 BEFORE https://before.example.test/資料?q=%2520#節 and /work/前%20.txt\n\n```text\nhttps://inside.example.test/a?q=%2520 /work/inside%20.txt\n```\n\nAFTER尾 https://after.example.test/end?q=%2521 and C:\\work\\after%20.txt";
			const blocks = findBlocks(text, true);
			expect(blocks).toHaveLength(3);
			get.mockImplementation((_path: string, options: { params: { query: { query: string } } }) => {
				const query = options.params.query.query;
				const block = blocks.findIndex((value) => value.includes(query));
				const start = blocks[block].indexOf(query);
				return Promise.resolve({ data: { conversationId: "c", transcriptRevision: "assistant-fence", occurrences: [{ ...hits[0], block, start, end: start + query.length }], total: 1 }, response: { status: 200 } });
			});
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, role: "assistant", origin: "provider", text };
			const { container } = render(<Harness markdown snapshot={{ ...source, items: [message] }} />);
			const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!;
			const code = body.querySelector("pre code")!;
			expect(code.textContent).toBe(blocks[1].slice(0, -1));
			expect(code.querySelector("[data-chat-address]")).toBeNull();
			expect(body.querySelectorAll("[data-chat-address]")).toHaveLength(4);
			const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
			fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
			expect(renderedFindBlocks(body).map((block) => block.text)).toEqual([blocks[0], blocks[1].slice(0, -1), blocks[2]]);
			for (const query of ["BEFORE", "before.example.test/資料", "/work/前%20.txt", "inside.example.test/a", "/work/inside%20.txt", "AFTER尾", "after.example.test/end", "C:\\work\\after%20.txt"]) {
				fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } }); await tick(3500);
				const block = blocks.findIndex((value) => value.includes(query)), start = blocks[block].indexOf(query);
				expect(reveal).toHaveBeenLastCalledWith({ ...hits[0], block, start, end: start + query.length });
				expect([...registry.get("chat-find-active") ?? []].map((range) => range.toString())).toEqual([query]);
				expect(screen.getByText("1/1")).toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			}
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); await tick(20);
			expect(body.querySelector("pre code")).toBe(code); expect(body.querySelectorAll("[data-chat-address]")).toHaveLength(4);
			expect(message.text).toBe(text);
		} finally { cleanup(); useUiStore.setState(previous); vi.unstubAllGlobals(); }
	});


	it.each([
		{ kind: "UNC", target: "\\\\server\\share\\資料.txt", display: "\\server\\share\\資料.txt", inside: "share\\資料.txt" },
		{ kind: "Windows escape", target: "C:\\work\\_scratch.txt", display: "C:\\work_scratch.txt", inside: "scratch.txt" },
	].flatMap((path) => (["assistant", "user"] as const).map((role) => ({ ...path, role }))))("matches canonical escaped path find offsets with raw target preservation: $kind $role", async ({ role, target, display, inside }) => {
		const previous = useUiStore.getState().chatPathDisplay;
		const registry = new Map<string, Set<Range>>();
		vi.stubGlobal("CSS", { highlights: registry }); vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			useUiStore.setState({ chatPathDisplay: "compact" });
			const text = `😀 BEFORE "${target}" AFTER尾`;
			const canonical = findBlocks(text, true)[0];
			expect(canonical).toBe(`😀 BEFORE "${display}" AFTER尾`);
			get.mockImplementation((_path: string, options: { params: { query: { query: string } } }) => {
				const query = options.params.query.query, start = canonical.indexOf(query);
				return Promise.resolve({ data: { conversationId: "c", transcriptRevision: "escaped-unc", occurrences: [{ ...hits[0], start, end: start + query.length }], total: 1 }, response: { status: 200 } });
			});
			const message: ConversationMessage = { ...source.items[0] as ConversationMessage, role, origin: role === "assistant" ? "provider" : "human", text };
			const { container } = render(<Harness markdown formattedUser snapshot={{ ...source, items: [message] }} />);
			const body = container.querySelector<HTMLElement>("[data-chat-message-body]")!;
			const address = within(body).getByRole("button", { name: target });
			expect(address.closest("[data-chat-address]")).toHaveAttribute("data-target", target);
			expect(address).toHaveAttribute("title", target);
			const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
			fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); await tick(20);
			const queries = ["BEFORE", inside, "AFTER尾"], selected: string[][] = [];
			for (const query of queries) {
				fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } }); await tick(3500);
				const start = canonical.indexOf(query);
				expect(reveal).toHaveBeenLastCalledWith({ ...hits[0], start, end: start + query.length });
				selected.push([...registry.get("chat-find-active") ?? []].map((range) => range.toString()));
			}
			expect(selected).toEqual(queries.map((query) => [query]));
			expect(renderedFindBlocks(body).map((block) => block.text)).toEqual(findBlocks(canonical, true));
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); await tick(20);
			expect(within(body).getByRole("button", { name: target })).toBe(address);
			expect(message.text).toBe(text); expect(address.closest("[data-chat-address]")).toHaveAttribute("data-target", target);
			expect(composer).toHaveValue("draft");
		} finally { cleanup(); useUiStore.setState({ chatPathDisplay: previous }); vi.unstubAllGlobals(); }
	});

	it("finds both occurrences and navigates, wraps, closes and preserves the draft", async () => {
		render(<Harness />); const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
		await openAndSearch();
		expect(screen.getByText("1/2")).toBeInTheDocument();
		expect(screen.getByText("1 of 2", { selector: ".sr-only" })).toBeInTheDocument();
		const input = screen.getByRole("searchbox");
		fireEvent.keyDown(input, { key: "Enter" }); await tick(0); expect(screen.getByText("2/2")).toBeInTheDocument();
		fireEvent.keyDown(input, { key: "Enter" }); await tick(0); expect(screen.getByText("Wrapped to the first match.")).toBeInTheDocument();
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true }); await tick(0); expect(screen.getByText("2/2")).toBeInTheDocument();
		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(); expect(composer).toHaveValue("draft"); expect(composer).toHaveFocus();
		expect(send).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalled();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "f", ctrlKey: true }); expect(screen.getByRole("searchbox")).toHaveValue("hello");
	});

	it("debounces typing and waits for IME composition", async () => {
		render(<Harness />); fireEvent.keyDown(document.activeElement ?? document.body, { key: "f", ctrlKey: true });
		const input = screen.getByRole("searchbox"); fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: "hello" } }); await tick(500); expect(get).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Enter", isComposing: true }); expect(reveal).not.toHaveBeenCalled();
		fireEvent.compositionEnd(input); await tick(100); expect(get).not.toHaveBeenCalled(); await tick(60); expect(get).toHaveBeenCalledTimes(1);
	});

	it("distinguishes an error from no matches and supports retry", async () => {
		get.mockRejectedValueOnce(new Error("Offline")); render(<Harness />); await openAndSearch();
		expect(screen.getByText("Search incomplete")).toBeInTheDocument(); expect(screen.queryByText("No results")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" })); await tick(); expect(screen.getByText("1/2")).toBeInTheDocument();
	});

	it("does not accept a late response for an old query", async () => {
		let resolve: (value: unknown) => void = () => {};
		get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		render(<Harness />); await openAndSearch();
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } }); await tick();
		await act(async () => resolve({ data: { conversationId: "c", transcriptRevision: "old", occurrences: [], total: 0 }, response: { status: 200 } }));
		expect(screen.queryByText("No results")).not.toBeInTheDocument(); expect(screen.getByText("1/2")).toBeInTheDocument();
	});

	it("loads a target window instead of walking older pages", async () => {
		const oldHit = { ...hits[0], messageId: "old", sequence: 1 };
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "r", occurrences: [oldHit], total: 1 }, response: { status: 200 } });
		get.mockResolvedValueOnce({ data: { ...source, items: [{ ...source.items[0], id: "old", sequence: 1 }] }, response: { status: 200 } });
		render(<Harness />); await openAndSearch();
		expect(get.mock.calls[1][0]).toContain("find-window"); expect(get.mock.calls[1][1].params.query).toEqual({ sequence: 1 });
		expect(reveal).toHaveBeenCalledWith(oldHit);
	});

	it("clears search state when the conversation changes", async () => {
		const view = render(<Harness />); await openAndSearch(); view.rerender(<Harness snapshot={{ ...source, conversationId: "other" }} />);
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(); fireEvent.keyDown(document.activeElement ?? document.body, { key: "f", ctrlKey: true }); expect(screen.getByRole("searchbox")).toHaveValue("");
	});

	it("does not capture find from a terminal or modal", async () => {
		render(<Harness />);
		const terminal = document.createElement("textarea"); terminal.className = "xterm"; document.body.append(terminal); terminal.focus();
		fireEvent.keyDown(terminal, { key: "f", ctrlKey: true }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(); terminal.remove();
		const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "f", ctrlKey: true }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument(); modal.remove();
	});

	it("uses the configured shortcut from the composer", async () => {
		useKeybindingsStore.setState({ overrides: { "find-in-chat": [{ key: "j", ctrl: true, meta: false, shift: true, alt: false }] } });
		render(<Harness />); const composer = screen.getByRole("textbox"); composer.focus();
		fireEvent.keyDown(composer, { key: "f", ctrlKey: true }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		fireEvent.keyDown(composer, { key: "J", ctrlKey: true, shiftKey: true }); await tick(20); expect(screen.getByRole("searchbox")).toHaveFocus();
		fireEvent.keyDown(composer, { key: "Escape" }); expect(interrupt).not.toHaveBeenCalled(); expect(composer).toHaveFocus();
	});

	it("routes find to the focused chat when two transcripts are mounted", async () => {
		render(<><Harness /><Harness snapshot={{ ...source, conversationId: "other" }} /></>);
		const composers = screen.getAllByRole("textbox"); composers[1].focus();
		fireEvent.keyDown(composers[1], { key: "f", ctrlKey: true }); await tick(20);
		expect(screen.getAllByRole("searchbox")).toHaveLength(1);
		expect(screen.getByRole("searchbox").closest("section")).toBe(composers[1].closest("section"));
	});

	it("does not replace a stable active result when streaming adds matches", async () => {
		const view = render(<Harness />); await openAndSearch();
		const streaming = { ...source.items[0] as ConversationMessage, id: "stream", role: "assistant" as const, origin: "provider" as const, text: "hello", streaming: true, sequence: 11 };
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "stream1", occurrences: [...hits, { ...hits[0], messageId: "stream", sequence: 11 }], total: 3 }, response: { status: 200 } });
		const before = get.mock.calls.length;
		view.rerender(<Harness snapshot={{ ...source, items: [...source.items, streaming] }} />); await tick();
		expect(get).toHaveBeenCalledTimes(before); await tick(2000);
		expect(screen.getByText("1/3")).toBeInTheDocument(); expect(reveal).toHaveBeenCalledTimes(1);
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "stream2", occurrences: [...hits, ...hits.map((hit) => ({ ...hit, messageId: "stream", sequence: 11, revision: 2 }))], total: 4 }, response: { status: 200 } });
		view.rerender(<Harness snapshot={{ ...source, items: [...source.items, { ...streaming, text: "hello hello", revision: 2 }] }} />); await tick(2000);
		expect(screen.getByText("1/4")).toBeInTheDocument(); expect(reveal).toHaveBeenCalledTimes(1);
	});

	it("validates an over-limit query without truncating it", async () => {
		render(<Harness />); fireEvent.keyDown(document.activeElement ?? document.body, { key: "f", ctrlKey: true });
		const value = "x".repeat(513); fireEvent.change(screen.getByRole("searchbox"), { target: { value } }); await tick();
		expect(screen.getByRole("searchbox")).toHaveValue(value); expect(screen.getByText(/up to 512 characters/)).toBeInTheDocument(); expect(get).not.toHaveBeenCalled();
	});

	it("keeps the query open and refreshes after a branch switch", async () => {
		const view = render(<Harness />); await openAndSearch();
		view.rerender(<Harness snapshot={{ ...source, activeBranchId: "new-branch" }} />);
		expect(screen.getByRole("searchbox")).toHaveValue("hello"); await tick(); expect(screen.getByText("1/2")).toBeInTheDocument();
	});

	it("treats an empty new conversation as no results without an invalid API request", async () => {
		render(<Harness snapshot={{ ...source, conversationId: "", items: [], hasMoreBefore: false }} />); await openAndSearch();
		expect(screen.getByText("No results")).toBeInTheDocument(); expect(get).not.toHaveBeenCalled();
	});

	it("keeps a million-hit search bounded and loads only the next result page", async () => {
		const pageHits = (offset: number) => Array.from({ length: 200 }, (_, index) => ({ ...hits[0], start: (offset + index) * 6, end: (offset + index) * 6 + 5 }));
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "r", occurrences: pageHits(0), total: 1000000, offset: 0, initialIndex: 199, nextCursor: "r:200", lastCursor: "r:999800" }, response: { status: 200 } });
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "r", occurrences: pageHits(200), total: 1000000, offset: 200, initialIndex: 200, previousCursor: "r:0", nextCursor: "r:400", lastCursor: "r:999800" }, response: { status: 200 } });
		render(<Harness />); await openAndSearch();
		expect(screen.getByText("200/1000000")).toBeInTheDocument(); expect(get).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" }); await tick(0);
		expect(screen.getByText("201/1000000")).toBeInTheDocument(); expect(get).toHaveBeenCalledTimes(2); expect(get.mock.calls[1][1].params.query.cursor).toBe("r:200");
	});

	it("has no launch button and applies reassignment, alternatives and reset without remounting", async () => {
		render(<Harness />);
		expect(screen.queryByRole("button", { name: "Find in chat" })).not.toBeInTheDocument();
		const binding = { key: "j", ctrl: true, meta: false, shift: true, alt: false };
		const persist = vi.spyOn(aoBridge.keybindings, "set").mockImplementation(async (value) => value);
		await act(async () => { await useKeybindingsStore.getState().setBindings("find-in-chat", [binding]); });
		fireEvent.keyDown(document.body, { key: "f", ctrlKey: true }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		fireEvent.keyDown(document.body, { key: "J", ctrlKey: true, shiftKey: true }); await tick(20);
		expect(screen.getByRole("searchbox")).toHaveFocus();
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
		await act(async () => { await useKeybindingsStore.getState().setBindings("find-in-chat", [binding, { ...binding, key: "f", shift: false }]); });
		fireEvent.keyDown(document.body, { key: "f", ctrlKey: true }); await tick(20); expect(screen.getByRole("searchbox")).toHaveFocus();
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
		await act(async () => { await useKeybindingsStore.getState().resetBinding("find-in-chat"); });
		fireEvent.keyDown(document.body, { key: "J", ctrlKey: true, shiftKey: true }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		fireEvent.keyDown(document.body, { key: "f", ctrlKey: true }); await tick(20); expect(screen.getByRole("searchbox")).toHaveFocus();
		expect(persist).toHaveBeenLastCalledWith({});
	});

	it("does no search work while chatting and retains browser highlight objects until reactivated", async () => {
		const registry = new Map<string, unknown>(); const set = vi.spyOn(registry, "set");
		vi.stubGlobal("CSS", { highlights: registry }); vi.stubGlobal("Highlight", class extends Set<Range> {});
		try {
			const view = render(<Harness />); await openAndSearch();
			const existing = registry.get("chat-find-matches"), paints = set.mock.calls.length;
			expect(existing).toBeDefined();
			act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
			await tick(0);
			expect(vi.getTimerCount()).toBe(0);
			fireEvent.pointerDown(screen.getByText("1/2")); fireEvent.click(screen.getByText("1/2"));
			const added = { ...source.items[0], id: "new", sequence: 11 };
			view.rerender(<Harness snapshot={{ ...source, items: [...source.items, added] }} />); await tick(1000);
			expect(get).toHaveBeenCalledTimes(1); expect(set).toHaveBeenCalledTimes(paints);
			expect(registry.get("chat-find-matches")).toBe(existing); expect(screen.getByText("1/2")).toBeInTheDocument();
			get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "new", occurrences: [...hits, { ...hits[0], messageId: "new", sequence: 11 }], total: 3 }, response: { status: 200 } });
			act(() => screen.getByRole("searchbox").focus()); await tick();
			expect(get).toHaveBeenCalledTimes(2); expect(screen.getByText("1/3")).toBeInTheDocument();
			expect(registry.get("chat-find-matches")).not.toBe(existing);
			fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" }); expect(registry.size).toBe(0);
		} finally { cleanup(); vi.unstubAllGlobals(); }
	});

	it("cancels and ignores an in-flight search on blur, then shows a loader only for a new query", async () => {
		let resolve: (value: unknown) => void = () => {};
		get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		render(<Harness />); await openAndSearch();
		const status = screen.getAllByRole("status").find((element) => element.querySelector(".animate-spin"))!;
		expect(status.querySelector("svg")).toHaveClass("size-4", "shrink-0", "motion-reduce:animate-none");
		expect(screen.getByText("Searching…")).toHaveClass("sr-only");
		act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
		expect(get.mock.calls[0][1].signal.aborted).toBe(true); expect(status.querySelector(".animate-spin")).toBeNull();
		expect(screen.getByRole("search")).toHaveAttribute("aria-busy", "false");
		await act(async () => resolve({ data: { conversationId: "c", transcriptRevision: "late", occurrences: hits, total: 2 }, response: { status: 200 } }));
		expect(screen.queryByText("1/2")).not.toBeInTheDocument(); expect(reveal).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "f", ctrlKey: true }); await tick();
		expect(screen.getByText("1/2")).toBeInTheDocument(); expect(get).toHaveBeenCalledTimes(2);
	});

	it("keeps the completed count during refresh and waits for it before navigating", async () => {
		render(<Harness />); await openAndSearch();
		act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
		let resolve: (value: unknown) => void = () => {};
		get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		fireEvent.click(screen.getByRole("button", { name: "Next match" })); await tick();
		expect(screen.getByText("1/2")).toBeInTheDocument(); expect(reveal).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/updating|Loading matches/i)).not.toBeInTheDocument(); expect(document.querySelector(".animate-spin")).toBeNull();
		await act(async () => resolve({ data: { conversationId: "c", transcriptRevision: "new", occurrences: [...hits, { ...hits[0], start: 12, end: 17 }], total: 3 }, response: { status: 200 } })); await tick(0);
		expect(screen.getByText("2/3")).toBeInTheDocument(); expect(reveal).toHaveBeenLastCalledWith(hits[1]);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("treats focus between controls as active and stops when the window is blurred", async () => {
		const view = render(<Harness />); await openAndSearch();
		act(() => screen.getByRole("button", { name: "Next match" }).focus());
		view.rerender(<Harness snapshot={{ ...source }} />); await tick(); expect(get).toHaveBeenCalledTimes(2);
		fireEvent.blur(window); expect(vi.getTimerCount()).toBe(0);
		view.rerender(<Harness snapshot={{ ...source }} />); await tick(500); expect(get).toHaveBeenCalledTimes(2);
		fireEvent.pointerDown(screen.getByRole("searchbox")); await tick(); expect(get).toHaveBeenCalledTimes(3);
	});

	it("invalidates a paused branch without searching and refreshes on the next activation", async () => {
		const view = render(<Harness />); await openAndSearch();
		act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
		view.rerender(<Harness snapshot={{ ...source, activeBranchId: "other" }} />); await tick(500);
		expect(screen.getByRole("searchbox")).toHaveValue("hello"); expect(get).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("1/2")).not.toBeInTheDocument();
		act(() => screen.getByRole("searchbox").focus()); await tick(); expect(get).toHaveBeenCalledTimes(2);
	});

	it("ignores a late history-window response after the reader returns to the composer", async () => {
		let resolve: (value: unknown) => void = () => {};
		const old = { ...hits[0], messageId: "old", sequence: 1 };
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "r", occurrences: [old], total: 1 }, response: { status: 200 } });
		get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		render(<Harness />); await openAndSearch(); expect(get.mock.calls[1][0]).toContain("find-window");
		act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
		expect(get.mock.calls[1][1].signal.aborted).toBe(true);
		await act(async () => resolve({ data: { ...source, items: [{ ...source.items[0], id: "old", sequence: 1 }] }, response: { status: 200 } }));
		expect(document.querySelector('[data-find-message-id="old"]')).toBeNull(); expect(reveal).not.toHaveBeenCalled();
	});

	it("cancels an occurrence page and queued navigation when focus leaves the bar", async () => {
		let resolve: (value: unknown) => void = () => {};
		get.mockResolvedValueOnce({ data: { conversationId: "c", transcriptRevision: "r", occurrences: hits, total: 3, initialIndex: 1, nextCursor: "r:2" }, response: { status: 200 } });
		get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		render(<Harness />); await openAndSearch();
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" }); await tick(0);
		expect(get).toHaveBeenCalledTimes(2);
		act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
		await act(async () => resolve({ data: { conversationId: "c", transcriptRevision: "r", occurrences: [{ ...hits[0], start: 12, end: 17 }], total: 3, offset: 2 }, response: { status: 200 } })); await tick();
		expect(get.mock.calls[1][1].signal.aborted).toBe(true); expect(get).toHaveBeenCalledTimes(2);
		expect(screen.getByText("2/3")).toBeInTheDocument(); expect(reveal).toHaveBeenCalledTimes(1);
	});

	it("handles a missing focus destination and does not refresh merely on window focus", async () => {
		render(<Harness />); await openAndSearch();
		act(() => screen.getByRole("searchbox").blur()); await tick(0);
		expect(vi.getTimerCount()).toBe(0);
		fireEvent.focus(window); await tick(500); expect(get).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
		fireEvent.keyDown(document.body, { key: "f", ctrlKey: true }); await tick();
		expect(get).toHaveBeenCalledTimes(2); expect(screen.getByRole("searchbox")).toHaveFocus();
	});
});
