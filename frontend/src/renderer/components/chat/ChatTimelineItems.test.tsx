import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { useUiStore } from "../../stores/ui-store";
import { aoBridge } from "../../lib/bridge";
import { ActivityRow, AssistantMessage, HumanMessage, TurnOutcome } from "./ChatTimelineItems";
import type { ConversationMessage } from "../../types/conversation";
import { ChatLinkProvider } from "./ChatMarkdown";
import { TooltipProvider } from "../ui/tooltip";

function render(ui: ReactElement) {
	const result = rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
	return {
		...result,
		rerender: (nextUi: ReactElement) => result.rerender(<TooltipProvider>{nextUi}</TooltipProvider>),
	};
}

let nextFrame = 1;
let frameTime = 0;
let frames = new Map<number, FrameRequestCallback>();

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
	return {
		kind: "message",
		id: "assistant-1",
		sequence: 1,
		revision: 1,
		role: "assistant",
		origin: "provider",
		text: "a",
		streaming: true,
		createdAt: "2026-08-24T00:00:00Z",
		...overrides,
	};
}

function runFrame(now: number) {
	const [id, callback] = frames.entries().next().value ?? [];
	if (id === undefined || callback === undefined) throw new Error("No animation frame scheduled");
	frames.delete(id);
	frameTime = now;
	act(() => callback(now));
}

beforeEach(() => {
	nextFrame = 1;
	frameTime = 0;
	frames = new Map();
	vi.spyOn(performance, "now").mockImplementation(() => frameTime);
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		frames.delete(id);
	});
});

afterEach(() => vi.restoreAllMocks());

/** Run frames at ~60 Hz until the drain finishes; returns the time it took. */
function drain(from = 0, limitMs = 5000) {
	let now = from;
	while (frames.size && now - from < limitMs) runFrame((now += 16));
	return now - from;
}

describe("TurnOutcome", () => {
	it("keeps a recovered historical turn distinct from success", () => {
		render(<TurnOutcome state="recovered" />);
		expect(screen.getByText("This turn was recovered from an earlier session")).toBeInTheDocument();
		expect(screen.queryByText("Done")).not.toBeInTheDocument();
	});

	it("shows the failed outcome and the provider's explanation", () => {
		render(<TurnOutcome state="failed" error="Provider error" />);

		expect(screen.getByText("The agent ran into a problem")).toBeInTheDocument();
		expect(screen.getByText("Provider error")).toBeInTheDocument();
	});

	it("preserves multiline provider text and links without interpreting its structure", () => {
		render(
			<TurnOutcome
				state="failed"
				error={"Usage limit reached\n\nManage billing at https://example.com/billing."}
			/>,
		);

		expect(screen.getByText(/Usage limit reached/)).toBeInTheDocument();
		expect(screen.getByText(/Manage billing at/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "https://example.com/billing" })).toHaveAttribute(
			"href",
			"https://example.com/billing",
		);
	});
});

describe("AssistantMessage streaming", () => {
	it("shows completed messages without a duplicate animation segmentation pass", () => {
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		const text = "Completed 👨‍👩‍👧‍👦 é answer";
		render(<AssistantMessage message={message({ text, streaming: false })} />);
		expect(document.querySelector("p")?.textContent).toBe(text);
		// Markdown may segment for emoji typography; settled text needs no
		// additional pass for the streaming animation.
		expect(segment.mock.calls.filter(([input]) => input === text).length).toBeLessThanOrEqual(1);
	});

	it("resumes a completed message without repeating its visible prefix", () => {
		const prefix = "Hello 👨‍👩‍👧‍👦 é";
		const text = prefix + " continued".repeat(20);
		const view = render(<AssistantMessage message={message({ text: prefix, streaming: false })} />);
		view.rerender(<AssistantMessage message={message({ text, streaming: true, revision: 2 })} />);

		runFrame(0);
		runFrame(100);
		const visible = document.querySelector("p")?.textContent ?? "";
		expect(visible.startsWith(prefix)).toBe(true);
		expect(text.startsWith(visible)).toBe(true);

		drain(100);
		expect(document.querySelector("p")?.textContent).toBe(text);
		expect(frames.size).toBe(0);
	});

	it("shows the first durable snapshot and a replacement message immediately", () => {
		const text = "A first snapshot 👨‍👩‍👧‍👦";
		const view = render(<AssistantMessage message={message({ text })} />);
		expect(document.querySelector("p")?.textContent).toBe(text);
		expect(frames.size).toBe(0);

		view.rerender(<AssistantMessage message={message({ text: text + " buffered" })} />);
		runFrame(0);
		view.rerender(<AssistantMessage message={message({ id: "assistant-2", text: "New message" })} />);
		expect(document.querySelector("p")?.textContent).toBe("New message");
		expect(frames.size).toBe(0);
	});

	it("shows a provider correction immediately and starts a fresh drain afterward", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "a".padEnd(2000, "x") })} />);
		runFrame(0);
		runFrame(50);
		view.rerender(<AssistantMessage message={message({ text: "Corrected" })} />);
		expect(document.querySelector("p")?.textContent).toBe("Corrected");
		expect(frames.size).toBe(0);

		view.rerender(<AssistantMessage message={message({ text: "Corrected text" })} />);
		runFrame(190);
		expect(document.querySelector("p")?.textContent).not.toBe("Corrected text");
		drain(230);
		expect(document.querySelector("p")?.textContent).toBe("Corrected text");
	});

	it("does not force a character on high-refresh frames", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "abcdefghij" })} />);

		runFrame(0);
		runFrame(8);

		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.queryByText("ab")).not.toBeInTheDocument();
	});

	it("shows the current snapshot immediately when an occluded tab resumes", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "a".padEnd(2000, "x") })} />);

		runFrame(0);
		runFrame(5 * 60 * 1000);
		const rendered = document.querySelector("p");

		expect(rendered?.textContent).toBe("a".padEnd(2000, "x"));
	});

	it("flushes on resume when a hidden tab received no initial animation frame", () => {
		const view = render(<AssistantMessage message={message()} />);
		const text = "a".padEnd(2000, "x");
		view.rerender(<AssistantMessage message={message({ text })} />);

		runFrame(5 * 60 * 1000);

		expect(document.querySelector("p")?.textContent).toBe(text);
		expect(frames.size).toBe(0);
	});

	it("spreads a large received burst over several frames instead of dumping it", () => {
		const view = render(<AssistantMessage message={message()} />);
		const text = "a".padEnd(10_000, "x");
		view.rerender(<AssistantMessage message={message({ text })} />);

		runFrame(0);
		runFrame(48);
		const partial = document.querySelector("p")?.textContent ?? "";
		expect(partial.length).toBeGreaterThan(1);
		expect(partial.length).toBeLessThan(text.length);

		drain(48);
		expect(document.querySelector("p")?.textContent).toBe(text);
		expect(frames.size).toBe(0);
	});

	it("segments each snapshot once and reuses it across animation frames", () => {
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		const view = render(<AssistantMessage message={message()} />);
		const text = "a".padEnd(2000, "x");
		view.rerender(<AssistantMessage message={message({ text })} />);
		runFrame(0);
		runFrame(16);
		runFrame(32);

		expect(segment.mock.calls.filter(([input]) => input === text)).toHaveLength(1);
	});

	it("keeps emoji and combining sequences intact while streaming", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "a👨‍👩‍👧‍👦e\u0301" })} />);

		runFrame(0);
		runFrame(1000);

		expect(document.querySelector("p")?.textContent).toBe("a👨‍👩‍👧‍👦e\u0301");
	});

	it("reconciles a grapheme when a later snapshot adds a ZWJ", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "a👨" })} />);
		drain();
		expect(document.querySelector("p")?.textContent).toBe("a👨");

		view.rerender(<AssistantMessage message={message({ text: "a👨‍👩" })} />);
		expect(document.querySelector("p")?.textContent).toBe("a");
		drain();

		expect(document.querySelector("p")?.textContent).toBe("a👨‍👩");
	});

	it("reconciles a later combining mark without skipping the following grapheme", () => {
		const view = render(<AssistantMessage message={message({ text: "ae" })} />);
		view.rerender(<AssistantMessage message={message({ text: "ae\u0301z" })} />);
		expect(document.querySelector("p")?.textContent).toBe("a");
		runFrame(0);
		runFrame(20);
		expect(document.querySelector("p")?.textContent).toBe("ae\u0301");
		runFrame(40);
		expect(document.querySelector("p")?.textContent).toBe("ae\u0301z");
	});

	it("shows the latest snapshot immediately when reduced motion is requested", () => {
		vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
			matches: query === "(prefers-reduced-motion: reduce)",
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(() => false),
		}));
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "The complete snapshot" })} />);

		expect(screen.getByText("The complete snapshot")).toBeInTheDocument();
		expect(frames.size).toBe(0);
	});

	it("flushes buffered text when streaming completes and restores actions", () => {
		const view = render(<AssistantMessage message={message()} showCopy />);
		view.rerender(<AssistantMessage message={message({ text: "aThe complete answer", streaming: true })} showCopy />);
		runFrame(0);
		view.rerender(
			<AssistantMessage message={message({ text: "aThe complete answer", streaming: false })} showCopy />,
		);

		// The fade spans linger briefly after the stream settles, so match the paragraph.
		expect(document.querySelector("p")?.textContent).toBe("aThe complete answer");
		expect(screen.getByRole("button", { name: "Copy message as markdown" })).toBeInTheDocument();
	});

	it("hides message actions while text is still buffered", () => {
		const view = render(<AssistantMessage message={message()} showCopy />);
		view.rerender(<AssistantMessage message={message({ text: "a buffered answer" })} showCopy />);

		expect(screen.queryByRole("button", { name: "Copy message as markdown" })).not.toBeInTheDocument();
	});

	it("shows the message timestamp on hover", () => {
		render(
			<AssistantMessage
				message={message({ createdAt: new Date().toISOString(), text: "Timestamped answer", streaming: false })}
				showCopy
			/>,
		);

		expect(screen.getByLabelText(/^Sent \d{2}:\d{2}$/)).toBeInTheDocument();
	});

	it("labels yesterday and older messages by date", () => {
		const now = new Date();
		const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString();
		const older = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12).toISOString();
		const view = render(
			<AssistantMessage message={message({ createdAt: yesterday, streaming: false })} showCopy />,
		);

		expect(screen.getByLabelText(/^Sent Yesterday · \d{2}:\d{2}$/)).toBeInTheDocument();
		view.rerender(<AssistantMessage message={message({ createdAt: older, streaming: false })} showCopy />);
		expect(screen.queryByLabelText(/^Sent Yesterday ·/)).toBeNull();
		expect(screen.getByLabelText(/^Sent .+\d{4}$/)).toBeInTheDocument();
	});

	it("survives StrictMode effect cleanup and keeps draining", () => {
		const view = render(
			<StrictMode>
				<AssistantMessage message={message()} />
			</StrictMode>,
		);
		view.rerender(
			<StrictMode>
				<AssistantMessage message={message({ text: "abcdefghij" })} />
			</StrictMode>,
		);
		drain();

		expect(document.querySelector("p")?.textContent).toBe("abcdefghij");
	});
});

describe("ActivityRow", () => {
	it("renders inline code in provider activity titles without literal backticks", () => {
		const path = "/Users/sachin/.ao/worktrees/murdock/docs/system-design.html";
		const { container } = render(
			<ActivityRow activity={{
				kind: "activity", id: "edit-title", sequence: 1, revision: 0,
				createdAt: "2026-08-23T00:00:00Z", activityKind: "file_change",
				status: "completed", summary: `Edit \`${path}\``,
			}} />,
		);
		expect(screen.getByRole("button")).toHaveTextContent(`Edit ${path}`);
		expect(container.querySelector("code")).toHaveTextContent(path);
		expect(screen.getByRole("button").textContent).not.toContain("`");
	});

	it("shows a finished project setup with its duration and expandable output", () => {
		render(
			<ActivityRow activity={{
				kind: "activity", id: "startup", sequence: 1, revision: 1, createdAt: "2026-10-13T00:00:00Z",
				activityKind: "system", status: "completed", summary: "Setup finished",
				detail: { event: "workspace.setup", setupStatus: "succeeded", exitCode: 0, durationMs: 12_400, output: "compose up\nready" },
			}} />,
		);
		expect(screen.getByText("Setup finished in 12s")).toBeInTheDocument();
		expect(screen.queryByText(/compose up/)).toBeNull();
		act(() => screen.getByRole("button", { name: "Show output" }).click());
		expect(screen.getByRole("button", { name: "Hide output" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText(/compose up/)).toBeInTheDocument();
	});

	it("shows the failed setup step with its exit code", () => {
		render(
			<ActivityRow activity={{
				kind: "activity", id: "startup", sequence: 1, revision: 1, createdAt: "2026-10-13T00:00:00Z",
				activityKind: "system", status: "failed", summary: "Setup failed",
				detail: { event: "workspace.setup", setupStatus: "failed", setupStep: 2, exitCode: 2, durationMs: 65_000 },
			}} />,
		);
		expect(screen.getByText("Setup step 2 failed (exit 2)")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show output" })).toBeNull();
	});

	it("does not present a recovered historical activity as failed", () => {
		render(
			<ActivityRow
				activity={{
					kind: "activity",
					id: "activity-1",
					sequence: 1,
					revision: 0,
					createdAt: "2026-08-23T00:00:00Z",
					activityKind: "command",
					status: "recovered",
					summary: "Run tests",
				}}
			/>,
		);
		expect(screen.getByText("outcome unknown")).toBeInTheDocument();
		expect(screen.queryByText("failed")).not.toBeInTheDocument();
	});
});

describe("HumanMessage", () => {
	function human(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
		return message({ id: "human-1", role: "user", origin: "human", text: "hi", streaming: false, ...overrides });
	}

	it.each(["/work/Project Files/", "C:\\work\\Project Files\\"])("renders an inline folder reference for %s with the shared menu", async (path) => {
		const text = `Read ${path} please\n\nAttached files (read these files in the workspace):\n- ${path}`;
		render(<HumanMessage message={human({ text })} sessionId="s1" />);
		const body = document.querySelector("[data-chat-message-body]")!;
		const chip = body.querySelector("[title]")!;
		expect(chip).toHaveTextContent("Project Files");
		expect(chip).toHaveAttribute("title", path);
		fireEvent.contextMenu(chip, { button: 2 });
		expect(await screen.findByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
	});

	it("opens a sent inline file reference in the existing Files panel", async () => {
		const path = ".ao/attachments/attachment-readme.txt";
		const open = vi.fn();
		render(<ChatLinkProvider onFileOpen={open}><HumanMessage message={human({ text: `Read ${path} please\n\nAttached files (read these files in the workspace):\n- ${path}` })} sessionId="s1" /></ChatLinkProvider>);
		const chip = document.querySelector("[data-chat-message-body] [title]")!;
		expect(chip).toHaveTextContent("attachment-readme.txt");
		fireEvent.contextMenu(chip, { button: 2 });
		await userEvent.click(await screen.findByRole("menuitem", { name: "Open in side panel" }));
		expect(useUiStore.getState().workspaceFileOpenRequest).toMatchObject({ sessionId: "s1", path, source: "panel" });
		expect(open).not.toHaveBeenCalled();
	});

	it("does not reveal a cloud attachment on the client filesystem", async () => {
		const path = "/cloud/project/";
		render(<ChatLinkProvider sessionLinkSourceKind="cloud" onFileOpen={vi.fn()}><HumanMessage message={human({ text: `Read ${path}\n\nAttached files (read these files in the workspace):\n- ${path}` })} sessionId="cloud-session" /></ChatLinkProvider>);
		fireEvent.contextMenu(document.querySelector("[data-chat-message-body] [title]")!, { button: 2 });
		expect(await screen.findByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Finder|File Explorer|file manager/ })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Open in side panel" })).toBeNull();
	});

	it.each([40, 160])("keeps code at %ipx free of collapse controls", (height) => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
		render(<HumanMessage message={human({ text: "Before\n```go\nfunc main() {}\n```\nAfter" })} sessionId="s1" />);
		expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
	});

	it("collapses long code by default and toggles without replacing its content or hiding prose", async () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
		const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue(undefined);
		const code = "const value = 42;\n".repeat(20).trimEnd();
		const text = `Before\n\n\`\`\`javascript\n${code}\n\`\`\`\n\nAfter`;
		const { container } = render(<HumanMessage message={human({ text })} sessionId="s1" />);
		const body = container.querySelector("pre")!;
		const more = screen.getByRole("button", { name: "Show more" });
		expect(more).toHaveAttribute("aria-expanded", "false");
		expect(more).toHaveAttribute("aria-controls", body.id);
		expect(body).toHaveStyle({ maxHeight: "160px" });
		expect(body).toHaveClass("overflow-auto");
		expect(body.textContent).toBe(code);
		expect(body.parentElement?.lastElementChild).toBe(more);
		expect(body.parentElement).not.toHaveTextContent("Before");
		expect(body.parentElement).not.toHaveTextContent("After");
		expect(screen.getByText(/Before/)).toBeInTheDocument();
		expect(screen.getByText(/After/)).toBeInTheDocument();
		await waitFor(() => expect(body.querySelector(".hljs-keyword")).not.toBeNull());
		const highlighted = body.querySelector(".hljs-keyword");
		const selection = window.getSelection()!;
		const range = document.createRange();
		range.selectNodeContents(body);
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selection.toString()).toBe(code);
		await userEvent.click(more);
		expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
		expect(body).toHaveStyle({ maxHeight: "none" });
		expect(container.querySelector("pre")).toBe(body);
		expect(body.querySelector(".hljs-keyword")).toBe(highlighted);
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selection.toString()).toBe(code);
		await userEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
		expect(body).toHaveStyle({ maxHeight: "160px" });
		expect(body.textContent).toBe(code);
		await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
		expect(copy).toHaveBeenCalledWith(code);
	});

	it("expands each long code block independently", async () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
		const { container } = render(<HumanMessage message={human({ text: "```\nfirst\n```\n\n```\nsecond\n```" })} sessionId="s1" />);
		const bodies = container.querySelectorAll("pre");
		const toggles = screen.getAllByRole("button", { name: "Show more" });
		await userEvent.click(toggles[0]!);
		expect(bodies[0]).toHaveStyle({ maxHeight: "none" });
		expect(bodies[1]).toHaveStyle({ maxHeight: "160px" });
		expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-controls", bodies[1]!.id);
	});

	// Light theme cannot separate a sent bubble from the canvas by fill alone, so it
	// paints an enclosure keyed off this attribute's absence. Losing it makes the
	// message read as unenclosed text again.
	it("marks a queued bubble and leaves a sent one unmarked", () => {
		const { container, rerender } = render(<HumanMessage message={human()} sessionId="s1" />);
		const sent = container.querySelector(".cursor-chat-human-message");
		expect(sent).not.toBeNull();
		expect(sent).not.toHaveAttribute("data-queued");

		rerender(<HumanMessage message={human()} sessionId="s1" queued />);
		expect(container.querySelector(".cursor-chat-human-message")).toHaveAttribute("data-queued");
	});
});
