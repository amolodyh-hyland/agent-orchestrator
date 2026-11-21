import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../types/conversation";
import { ChatPrompts } from "./ChatPrompts";

const message = (id: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ kind: "message", id, role: "user", origin: "human", text: id, sequence: 1, revision: 1, streaming: false, createdAt: "2026-11-19T10:00:00Z", ...extra });

describe("Your prompts", () => {
	it("lists only actual human submissions, preserving raw content and exact message identity", async () => {
		const user = userEvent.setup(), select = vi.fn();
		const human = message("human", { text: "[from worker] human-authored **request** 😀" });
		render(<ChatPrompts items={[human, message("Deliberate browser feedback", { origin: "automation", authoredByUser: true }), message("worker", { origin: "automation" }), message("daemon", { origin: "daemon" }), message("reply", { role: "assistant", origin: "provider" }), message("continue", { continuation: true })]} onSelect={select} />);
		await user.click(screen.getByRole("button", { name: "Your prompts" }));
		expect(screen.getByRole("button", { name: human.text })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Deliberate browser feedback" })).toBeInTheDocument();
		for (const name of ["worker", "daemon", "reply", "continue"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: human.text }));
		expect(select).toHaveBeenCalledWith(human);
		expect(human.text).toBe("[from worker] human-authored **request** 😀");
		await waitFor(() => expect(screen.getByRole("button", { name: "Your prompts" })).toHaveFocus());
	});

	it("loads an older history page and selects its stable ID using the keyboard", async () => {
		const user = userEvent.setup(), load = vi.fn(), select = vi.fn();
		const props = { hasOlder: true, onLoadOlder: load, onSelect: select };
		const { rerender } = render(<ChatPrompts {...props} items={[message("new")]} />);
		await user.click(screen.getByRole("button", { name: "Your prompts" }));
		await user.click(screen.getByRole("button", { name: "Load older prompts" }));
		expect(load).toHaveBeenCalledOnce();
		rerender(<ChatPrompts {...props} hasOlder={false} items={[message("old"), message("new")]} />);
		const first = screen.getByRole("button", { name: "new" });
		first.focus();
		await user.keyboard("{ArrowDown}{Enter}");
		expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "old" }));
	});
});
