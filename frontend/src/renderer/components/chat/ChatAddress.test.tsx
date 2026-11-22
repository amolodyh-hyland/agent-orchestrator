import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { aoBridge } from "../../lib/bridge";
import { queryClient } from "../../lib/query-client";
import { linkPreviewQueryKey } from "../../hooks/useLinkPreview";
import { normalizeWorkspaceFileReference } from "../../lib/workspace-file-path";
import { findBlocks, findRange, findTextOccurrences, renderedFindBlocks } from "../../lib/chat-find";
import { useUiStore } from "../../stores/ui-store";
import { ChatAddress } from "./ChatAddress";
import { ChatFindEngagedContext } from "./ChatFindUserProjection";
import { ChatCodeText, UserMarkdown, ChatLinkProvider, ChatMarkdown, SessionLinkedText } from "./ChatMarkdown";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("../../lib/api-client", async (original) => ({ ...await original<typeof import("../../lib/api-client")>(), apiClient: { GET: getMock } }));

afterEach(() => {
	act(() => useUiStore.setState({ chatUrlDisplay: "full", chatPathDisplay: "full" }));
	act(() => queryClient.clear());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	getMock.mockReset();
});

it("updates existing agent and user bubbles from independent defaults while preserving authored labels and code", () => {
	const url = "https://bubbles.example.test/a?q=%2F#part";
	act(() => queryClient.setQueryData(linkPreviewQueryKey("https://bubbles.example.test/"), { faviconUrl: "data:image/png;base64," }));
	const source = `See ${url} and /tmp/資料.txt. [My own label](${url}) and \`${url}\`\n\n\`\`\`\n/tmp/code.txt\n\`\`\``;
	render(<><div data-testid="agent"><ChatMarkdown text={source} /></div><div data-testid="user"><UserMarkdown text={source} /></div></>);
	act(() => queryClient.setQueryData(linkPreviewQueryKey(url), { url, title: "Actual cached page title" }));
	act(() => useUiStore.setState({ chatUrlDisplay: "compact", chatPathDisplay: "compact" }));
	for (const surface of ["agent", "user"]) {
		const bubble = within(screen.getByTestId(surface));
		expect(bubble.getByRole("link", { name: url })).toHaveTextContent("Actual cached page title");
		expect(bubble.getByRole("button", { name: "/tmp/資料.txt" })).toHaveTextContent("資料.txt");
		expect(bubble.getByRole("link", { name: "My own label" })).toHaveAttribute("href", url);
		expect(bubble.getByText(url, { selector: "code" })).toBeInTheDocument();
		expect(bubble.getByText("/tmp/code.txt", { selector: "code" })).toBeInTheDocument();
	}
	expect(getMock).not.toHaveBeenCalled();
	act(() => useUiStore.getState().setChatUrlDisplay("full"));
	expect(screen.getAllByRole("link", { name: url }).every((link) => link.textContent === url)).toBe(true);
});

it.each([
	{ name: "assistant Unicode URL and POSIX path", markdown: true, source: "前😀 BEFORE https://example.test/資料?q=%2520&tag=𐐀#節 and /work/資料%20.txt AFTER尾", queries: ["BEFORE", "%2520", "資料%20.txt", "AFTER尾"] },
	{ name: "user Unicode URL and Windows path", markdown: false, source: "😀前 BEFORE https://example.test/資料?q=%2520#節 and C:\\work\\資料%20.txt AFTER尾", queries: ["BEFORE", "%2520", "資料%20.txt", "AFTER尾"] },
	{ name: "assistant authored label and code", markdown: true, source: "`保留 %20` [Label %20](https://authored.example.test/source) BEFORE https://example.test/資料?q=%2520 AFTER尾\n\n```text\nconst x = '%20';\n```", queries: ["保留 %20", "Label %20", "BEFORE", "%2520", "AFTER尾", "const x"], renderedCode: "const x = '%20';" },
])("keeps backend UTF-16 find offsets before, inside and after addresses: $name", ({ markdown, source, queries, renderedCode }) => {
	for (const match of source.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) queryClient.setQueryData(linkPreviewQueryKey(new URL(match[1]).origin + "/"), { faviconUrl: "data:image/png;base64," });
	useUiStore.setState({ chatUrlDisplay: "compact", chatPathDisplay: "compact" });
	const { container } = render(<ChatFindEngagedContext.Provider value={true}>
		{markdown ? <ChatMarkdown text={source} /> : <UserMarkdown text={source} />}
	</ChatFindEngagedContext.Provider>);
	const expected = findBlocks(source, markdown);
	const actual = renderedFindBlocks(container);
	if (renderedCode) {
		expect(expected.at(-1)).toBe(`${renderedCode}\n`);
		expect(actual.map((block) => block.text)).toEqual([...expected.slice(0, -1), renderedCode]);
	} else expect(actual.map((block) => block.text)).toEqual(expected);
	const checked = new Set<string>();
	for (const [index, block] of expected.entries()) {
		for (const query of queries) {
			const hits = findTextOccurrences(block, query);
			expect(findTextOccurrences(actual[index].text, query)).toEqual(hits);
			for (const hit of hits) {
				expect(findRange(actual[index].nodes, hit.start, hit.end)?.toString()).toBe(block.slice(hit.start, hit.end));
				checked.add(query);
			}
		}
	}
	expect([...checked]).toEqual(queries);
	for (const item of container.querySelectorAll<HTMLElement>("[data-chat-address]")) expect(item.textContent).toBe(item.dataset.target);
	if (markdown && source.includes("[Label")) {
		expect(screen.getByRole("link", { name: "Label %20" })).toHaveAttribute("href", "https://authored.example.test/source");
		expect(screen.getByText("保留 %20", { selector: "code" })).toBeInTheDocument();
		expect(screen.getByText("const x = '%20';", { selector: "code" })).toBeInTheDocument();
	}
	expect(getMock).not.toHaveBeenCalled();
});

it("scopes raw find labels to one pane and restores defaults and mounted occurrence overrides", async () => {
	const target = "https://pane.example.test/資料?q=%2520#節";
	act(() => queryClient.setQueryData(linkPreviewQueryKey(target), { url: target, title: "Cached title" }));
	const panes = (firstFinding: boolean, secondFinding: boolean) => <>
		<ChatFindEngagedContext.Provider value={firstFinding}><div data-testid="first-pane"><ChatMarkdown text={`See ${target} after`} /></div></ChatFindEngagedContext.Provider>
		<ChatFindEngagedContext.Provider value={secondFinding}><div data-testid="second-pane"><ChatMarkdown text={`See ${target} after`} /></div></ChatFindEngagedContext.Provider>
	</>;
	const view = render(panes(false, false));
	const first = within(screen.getByTestId("first-pane")).getByRole("link", { name: target });
	const second = within(screen.getByTestId("second-pane")).getByRole("link", { name: target });
	fireEvent.contextMenu(first);
	await userEvent.click(screen.getByRole("menuitem", { name: "Show page title" }));
	expect(first).toHaveTextContent("Cached title");
	expect(second).toHaveTextContent(target);
	view.rerender(panes(true, false));
	expect(within(screen.getByTestId("first-pane")).getByRole("link", { name: target })).toBe(first);
	expect(first).toHaveTextContent(target);
	expect(useUiStore.getState().chatUrlDisplay).toBe("full");
	act(() => useUiStore.getState().setChatUrlDisplay("compact"));
	expect(first).toHaveTextContent(target);
	expect(second).toHaveTextContent("Cached title");
	view.rerender(panes(false, false));
	expect(first).toHaveTextContent("Cached title");
	act(() => useUiStore.getState().setChatUrlDisplay("full"));
	expect(first).toHaveTextContent("Cached title");
	expect(second).toHaveTextContent(target);
	view.rerender(panes(false, true));
	act(() => useUiStore.getState().setChatUrlDisplay("compact"));
	expect(first).toHaveTextContent("Cached title");
	expect(second).toHaveTextContent(target);
	view.rerender(panes(false, false));
	expect(within(screen.getByTestId("second-pane")).getByRole("link", { name: target })).toBe(second);
	expect(second).toHaveTextContent("Cached title");
	expect(useUiStore.getState().chatUrlDisplay).toBe("compact");
	expect(getMock).not.toHaveBeenCalled();
});

it("restores a path occurrence name override after find without changing its full-address default", async () => {
	const target = "/work/資料%20.txt";
	const fixture = (finding: boolean) => <ChatFindEngagedContext.Provider value={finding}><ChatMarkdown text={`See ${target} after`} /></ChatFindEngagedContext.Provider>;
	const view = render(fixture(false));
	const item = screen.getByRole("button", { name: target });
	fireEvent.contextMenu(item);
	await userEvent.click(screen.getByRole("menuitem", { name: "Show file or folder name" }));
	expect(item.textContent).toBe("資料%20.txt");
	view.rerender(fixture(true));
	expect(item.textContent).toBe(target);
	expect(useUiStore.getState().chatPathDisplay).toBe("full");
	view.rerender(fixture(false));
	expect(screen.getByRole("button", { name: target })).toBe(item);
	expect(item.textContent).toBe("資料%20.txt");
	expect(useUiStore.getState().chatPathDisplay).toBe("full");
	expect(item).toHaveAttribute("title", target);
	expect(getMock).not.toHaveBeenCalled();
});

it.each([
	["/tmp/one.txt", "/tmp/two.txt"],
	["C:\\work\\one.txt", "D:\\work\\two.txt"],
	["\\\\server\\share\\one.txt", "\\\\other\\share\\two.txt"],
])("keeps separate compact targets and prose in both bubbles: %s and %s", async (first, second) => {
	useUiStore.setState({ chatPathDisplay: "compact" });
	const open = vi.fn();
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const source = `${first} and ${second}`;
	render(<ChatLinkProvider sessionId="session-1" onFileOpen={open}>
		<div data-testid="agent-paths"><ChatMarkdown text={source} /></div>
		<div data-testid="user-paths"><UserMarkdown text={source} /></div>
	</ChatLinkProvider>);
	for (const surface of ["agent-paths", "user-paths"]) {
		const bubble = screen.getByTestId(surface);
		expect(bubble).toHaveTextContent("one.txt and two.txt");
		for (const target of [first, second]) {
			const item = within(bubble).getByRole("button", { name: target });
			expect(item).toHaveAttribute("title", target);
			fireEvent.contextMenu(item);
			await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
			expect(copy).toHaveBeenLastCalledWith(target);
			if (!target.startsWith("\\\\")) {
				await userEvent.click(item);
				expect(open).toHaveBeenLastCalledWith(target);
			}
		}
	}
	if (first.startsWith("\\\\")) expect(open).not.toHaveBeenCalled();
});

it.each([
	["file:///work/a%2520.txt", "file:///work/a%2520.txt", "/work/a%20.txt", "/work/a%20.txt"],
	["file:///work/a%25.txt", "file:///work/a%25.txt", "/work/a%.txt", "/work/a%.txt"],
	["file:///work/a%252F.txt", "file:///work/a%252F.txt", "/work/a%2F.txt", "/work/a%2F.txt"],
	["/work/a%20.txt", "/work/a%2520.txt", "/work/a%20.txt", "/work/a%20.txt"],
	["/work/a%.txt", "/work/a%25.txt", "/work/a%.txt", "/work/a%.txt"],
	["C:\\work\\a%20.txt", "C:\\work\\a%2520.txt", "C:/work/a%20.txt", "C:\\work\\a%20.txt"],
	["file:///C:/work/a%2520.txt", "file:///C:/work/a%2520.txt", "C:/work/a%20.txt", "C:/work/a%20.txt"],
])("opens literal-percent paths through the existing resolver exactly once: %s", async (target, reference, expected, nativePath) => {
	const resolved = vi.fn();
	const open = vi.fn((path: string, line?: number) => resolved(normalizeWorkspaceFileReference(path), line));
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const action = vi.spyOn(aoBridge.editorHandoff, "pathAction").mockResolvedValue(undefined);
	render(<ChatLinkProvider sessionId="session-1" onFileOpen={open}>
		<div data-testid="agent-file"><ChatMarkdown text={`See ${target}`} /></div>
		<div data-testid="user-file"><ChatCodeText text={`See ${target}`} renderText={(text) => <SessionLinkedText text={text} />} /></div>
	</ChatLinkProvider>);
	for (const surface of ["agent-file", "user-file"]) {
		const item = within(screen.getByTestId(surface)).getByRole("button", { name: target });
		await userEvent.click(item);
		expect(open).toHaveBeenLastCalledWith(reference);
		expect(resolved).toHaveBeenLastCalledWith(expected, undefined);
		fireEvent.contextMenu(item);
		await userEvent.click(screen.getByRole("menuitem", { name: "Open in Orchestrator" }));
		expect(resolved).toHaveBeenLastCalledWith(expected, undefined);
		fireEvent.contextMenu(item);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
		expect(action).toHaveBeenLastCalledWith({ sessionId: "session-1", path: nativePath, action: "reveal" });
		fireEvent.contextMenu(item);
		await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
		expect(copy).toHaveBeenLastCalledWith(target);
		expect(item).toHaveAttribute("title", target);
	}
});

it("keeps display overrides local to one occurrence and global defaults apply to the others", async () => {
	const target = "https://occurrences.example.test/long";
	render(<><ChatAddress target={target} kind="url" /><ChatAddress target={target} kind="url" /></>);
	const [first, second] = screen.getAllByRole("link", { name: target });
	fireEvent.contextMenu(first);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Show page title" }));
	expect(first).toHaveTextContent("occurrences.example.test");
	expect(second).toHaveTextContent(target);
	act(() => useUiStore.getState().setChatUrlDisplay("compact"));
	expect(second).toHaveTextContent("occurrences.example.test");
	fireEvent.contextMenu(first);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Show full address" }));
	expect(first).toHaveTextContent(target);
	expect(second).toHaveTextContent("occurrences.example.test");
});

it("fetches a brand-new page title only by explicit action and shares the cached result", async () => {
	const observe = vi.fn();
	vi.stubGlobal("IntersectionObserver", class {
		observe = observe;
		unobserve = vi.fn();
		disconnect = vi.fn();
	});
	const target = "https://github.com/example/project/pull/123456";
	getMock.mockResolvedValue({ data: { url: target, title: "A newly fetched title" }, error: undefined });
	render(<ChatAddress target={target} kind="url" />);
	const link = screen.getByRole("link", { name: target });
	fireEvent.pointerEnter(link);
	act(() => useUiStore.getState().setChatUrlDisplay("compact"));
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
	expect(getMock).not.toHaveBeenCalled();
	expect(observe).not.toHaveBeenCalled();
	fireEvent.contextMenu(link);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Fetch page title" }));
	await waitFor(() => expect(link).toHaveTextContent("A newly fetched title"));
	expect(getMock).toHaveBeenCalledExactlyOnceWith("/api/v1/link-preview", { params: { query: { url: target } }, signal: expect.any(AbortSignal) });
	expect(link).toHaveAttribute("href", target);
	expect(link).toHaveAttribute("title", target);
	expect(screen.queryByTestId("link-preview-card")).not.toBeInTheDocument();
	render(<ChatAddress target={target} kind="url" />);
	expect(screen.getAllByRole("link", { name: target })[1]).toHaveTextContent("A newly fetched title");
	expect(getMock).toHaveBeenCalledTimes(1);
});

it.each(["failure", "empty"])("keeps the raw target and a sensible fallback for metadata %s", async (outcome) => {
	const target = `https://${outcome}.example.test/path`;
	getMock.mockResolvedValue(outcome === "failure" ? { error: { message: "blocked" }, response: { status: 502 } } : { data: { url: target, title: "" } });
	useUiStore.setState({ chatUrlDisplay: "compact" });
	render(<ChatAddress target={target} kind="url" />);
	const link = screen.getByRole("link", { name: target });
	fireEvent.contextMenu(link);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Fetch page title" }));
	await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
	expect(link).toHaveTextContent(`${outcome}.example.test`);
	expect(link).toHaveAttribute("href", target);
});

it.each(["C:\\Files\\a%20.txt", "\\\\server\\share\\資料.txt", "file://server/share/a%2520.txt"])("preserves the native menu target and literal escapes: %s", async (target) => {
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const action = vi.spyOn(aoBridge.editorHandoff, "pathAction").mockResolvedValue(undefined);
	render(<ChatLinkProvider sessionId="session-1"><ChatAddress target={target} kind="path" /></ChatLinkProvider>);
	const item = screen.getByRole("button", { name: target });
	fireEvent.contextMenu(item);
	await userEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
	expect(copy).toHaveBeenCalledWith(target);
		expect(action).not.toHaveBeenCalled();
	expect(item).toHaveAttribute("title", target);
});

it.each(["\\\\server\\share\\資料.txt", "file://server/share/a%2520.txt", "file:////server/share/a.txt", "file://localhost//server/share/a.txt", "file:///%2Fserver/share/a.txt", "file:///%5Cserver/share/a.txt"])("formats network targets in both bubbles without offering native open/reveal: %s", async (target) => {
	const open = vi.fn();
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const getState = vi.spyOn(aoBridge.editorHandoff, "getState");
	const source = `See "${target}" now`;
	render(<ChatLinkProvider sessionId="session-1" onFileOpen={open} workspacePaths={["share/a%20.txt"]}>
		<div data-testid="agent-network"><ChatMarkdown text={source} /></div>
		<div data-testid="user-network"><UserMarkdown text={source} /></div>
	</ChatLinkProvider>);
	for (const name of ["agent-network", "user-network"]) {
		const item = within(screen.getByTestId(name)).getByRole("button", { name: target });
		expect(item).toHaveAttribute("title", target);
		fireEvent.contextMenu(item);
		expect(screen.queryByRole("menuitem", { name: /Open|Reveal/ })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
		expect(copy).toHaveBeenLastCalledWith(target);
	}
	expect(open).not.toHaveBeenCalled();
	expect(getState).not.toHaveBeenCalled();
});


it("uses canonical assistant UNC text only during find and preserves raw copy-only actions and occurrence choice", async () => {
	const target = String.raw`\\server\share\資料.txt`;
	const source = `😀 BEFORE "${target}" AFTER尾`;
	const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
	const open = vi.fn();
	const native = vi.spyOn(aoBridge.editorHandoff, "getState");
	const fixture = (finding: boolean) => <ChatFindEngagedContext.Provider value={finding}><ChatLinkProvider sessionId="unc-fixture" onFileOpen={open}><ChatMarkdown text={source} /></ChatLinkProvider></ChatFindEngagedContext.Provider>;
	const view = render(fixture(false));
	const item = screen.getByRole("button", { name: target });
	expect(item).toHaveTextContent(target);
	fireEvent.contextMenu(item);
	expect(screen.queryByRole("menuitem", { name: /Open|Reveal/ })).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
	expect(copy).toHaveBeenCalledWith(target);
	fireEvent.contextMenu(item);
	await userEvent.click(screen.getByRole("menuitem", { name: "Show file or folder name" }));
	expect(item).toHaveTextContent("資料.txt");
	view.rerender(fixture(true));
	expect(screen.getByRole("button", { name: target })).toBe(item);
	expect(item.textContent).toBe(target.slice(1));
	expect(item).toHaveAttribute("title", target);
	expect(item.closest("[data-chat-address]")).toHaveAttribute("data-target", target);
	fireEvent.contextMenu(item);
	expect(screen.queryByRole("menuitem", { name: /Open|Reveal/ })).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
	expect(copy).toHaveBeenLastCalledWith(target);
	view.rerender(fixture(false));
	expect(item.textContent).toBe("資料.txt");
	expect(screen.getByRole("button", { name: target })).toBe(item);
	expect(useUiStore.getState().chatPathDisplay).toBe("full");
	expect(open).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
});
