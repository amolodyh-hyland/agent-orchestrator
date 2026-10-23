import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { TooltipProvider } from "../ui/tooltip";
import type { ChatSkill, ChatSkillSelection } from "../../types/conversation";
import { lexicalEditorText, typeAndPressInLexicalEditor, typeInLexicalEditor } from "../../test/lexical";
import { readChatSessionDraft } from "../../lib/chat-drafts";

const row = (overrides: Partial<ChatSkill> = {}): ChatSkill => ({
	name: "review", displayName: "Review changes", token: "$review", transport: "native_skill",
	canInvoke: true, status: "ready", trustState: "approved", scope: "personal", sourceId: "source-personal",
	entryId: "entry-one", snapshotId: "snapshot-one", bindingRef: "binding-one", controllerGeneration: "controller-one",
	catalogRevision: "catalog-one", catalogIdentity: "host:provider:snapshot:trust-one", ...overrides,
});
function setup(skills: ChatSkill[], props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
	const send = vi.fn();
	const view = render(<ChatComposer onSend={send} skills={skills} {...props} />, { wrapper: TooltipProvider });
	return { ...view, send, field: screen.getByLabelText("Message the agent") };
}

it.each(["/", "$"])("inserts the backend %s marker and preserves arguments without submitting", async (marker) => {
	const { field, send } = setup([row({ token: `${marker}review`, transport: marker === "$" ? "native_skill" : "native_text" })]);
	await typeAndPressInLexicalEditor(field, marker + "rev", "Tab");
	expect(lexicalEditorText(field)).toBe(`${marker}review `);
	expect(send).not.toHaveBeenCalled();
	await typeInLexicalEditor(field, 'file.ts --focus "a b"');
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(send).toHaveBeenCalledWith(`${marker}review file.ts --focus "a b"`, undefined, undefined, undefined, undefined, expect.objectContaining({ entryId: "entry-one", snapshotId: "snapshot-one", token: `${marker}review` })));
});

it("keeps same labels and names with distinct IDs selectable independently", async () => {
	const { field, send } = setup([row(), row({ entryId: "entry-two", bindingRef: "binding-two", sourceId: "source-two" })]);
	await typeInLexicalEditor(field, "/review");
	expect(screen.getAllByRole("option")).toHaveLength(2);
	await userEvent.click(screen.getAllByRole("option")[1]!);
	expect(lexicalEditorText(field)).toBe("$review ");
	await typeInLexicalEditor(field, "second");
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(send.mock.calls[0]?.[5]).toMatchObject({ entryId: "entry-two", bindingRef: "binding-two" }));
});

it.each(["conflict", "restart_required", "changed_content", "revoked", "unsupported_format", "policy_denied"])("cannot select a %s row by mouse, Enter or Tab", async (status) => {
	const { field, send } = setup([row({ status, canInvoke: false, reasonCode: status === "policy_denied" ? "managed_lock" : status })]);
	await typeInLexicalEditor(field, "/rev");
	expect(screen.getByRole("option")).toBeDisabled();
	await userEvent.click(screen.getByRole("option"));
	await userEvent.keyboard("{Enter}{Tab}");
	expect(send).not.toHaveBeenCalled();
	expect(lexicalEditorText(field)).toBe("/rev");
});

it("preserves Escape and keyboard navigation", async () => {
	const { field, send } = setup([row(), row({ name: "ship", token: "$ship", bindingRef: "ship" })]);
	await typeInLexicalEditor(field, "$");
	await userEvent.keyboard("{ArrowDown}{Tab}");
	expect(lexicalEditorText(field)).toBe("$ship ");
	expect(send).not.toHaveBeenCalled();
	await typeInLexicalEditor(field, "$rev");
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(lexicalEditorText(field)).toBe("$ship $rev");
});

it("clears the hidden binding when the token is edited and does not restore it on retyping", async () => {
	const focusRef = createRef<ChatComposerHandle>();
	const { field, send } = setup([row()], { focusRef });
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	act(() => focusRef.current?.setDraft("ordinary text "));
	act(() => focusRef.current?.setDraft("$review edited arguments "));
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(send).toHaveBeenCalledWith("$review edited arguments"));
});

it("retains the opaque binding through draft remount and delivery", async () => {
	const sessionId = `library-draft-${crypto.randomUUID()}`;
	const first = setup([row()], { draftSessionId: sessionId });
	await typeAndPressInLexicalEditor(first.field, "$rev", "Tab");
	await typeInLexicalEditor(first.field, "file.ts");
	expect(readChatSessionDraft(sessionId).composer.skillSelection?.selection.entryId).toBe("entry-one");
	first.unmount();
	const second = setup([row()], { draftSessionId: sessionId });
	expect(lexicalEditorText(second.field)).toBe("$review file.ts");
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(second.send.mock.calls[0]?.[5]).toMatchObject({ entryId: "entry-one", snapshotId: "snapshot-one" }));
});

it("submits exact text and identity to a fake conversation and rejects a stale selection", async () => {
	let generation = "controller-one";
	const received: { text: string; selection?: ChatSkillSelection }[] = [];
	const fakeSend = vi.fn(async (text: string, _attachments?: unknown, _messageId?: string, _retained?: number[], _excerpts?: unknown, selection?: ChatSkillSelection | null) => {
		if (selection?.controllerGeneration !== generation) throw { code: "CHAT_SKILL_UNAVAILABLE", message: "stale_selection" };
		received.push({ text, selection: selection ?? undefined });
	});
	const { field } = setup([row()], { onSend: fakeSend });
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	await typeInLexicalEditor(field, "file.ts --all");
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(received).toHaveLength(1));
	expect(received[0]).toMatchObject({ text: "$review file.ts --all", selection: { entryId: "entry-one", snapshotId: "snapshot-one", bindingRef: "binding-one" } });
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	await typeInLexicalEditor(field, "new turn");
	generation = "controller-two";
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
	expect(received).toHaveLength(1);
	expect(lexicalEditorText(field)).toBe("$review new turn");
});

it.each(["controllerGeneration", "snapshotId", "catalogRevision", "catalogIdentity"] as const)("refuses a selected row after %s changes", async (key) => {
	const original = row();
	const { field, send, rerender } = setup([original]);
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	await typeInLexicalEditor(field, "argument");
	rerender(<ChatComposer onSend={send} skills={[row({ [key]: "replacement" })]} />);
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no longer current"));
	expect(send).not.toHaveBeenCalled();
});


it("does not bind or send when Enter confirms IME composition", async () => {
	const { field, send } = setup([row()]);
	await typeInLexicalEditor(field, "$rev");
	fireEvent.compositionStart(field);
	fireEvent.keyDown(field, { key: "Enter", isComposing: true });
	expect(send).not.toHaveBeenCalled();
	expect(field.querySelector('[data-composer-token="skill"]')).toBeNull();
	fireEvent.compositionEnd(field);
});

it("does not attach a saved draft's selection to recalled history and restores it on return", async () => {
	const { field, send } = setup([row()], { sentMessages: ["$review history"], draftSessionId: `library-history-${crypto.randomUUID()}` });
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	await typeInLexicalEditor(field, "draft");
	// Home positions at the first chip; the existing history shortcut owns Up there.
	const lexical = (field as HTMLElement & { __lexicalEditor?: import("lexical").LexicalEditor }).__lexicalEditor!;
	const { $getRoot } = await import("lexical");
	act(() => lexical.update(() => $getRoot().selectStart(), { discrete: true }));
	await userEvent.keyboard("{ArrowUp}");
	expect(lexicalEditorText(field)).toBe("$review history");
	await userEvent.keyboard("{ArrowDown}");
	expect(lexicalEditorText(field)).toBe("$review draft");
	act(() => lexical.update(() => $getRoot().selectEnd(), { discrete: true }));
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(send.mock.calls[0]?.[5]).toMatchObject({ entryId: "entry-one" }));
});

it("preserves a native dollar skill that shares an application command name", async () => {
	const compact = vi.fn();
	const { field, send } = setup([row({ name: "compact", token: "$compact" })], { onCompact: compact });
	await typeAndPressInLexicalEditor(field, "$comp", "Tab");
	expect(lexicalEditorText(field)).toBe("$compact ");
	await typeInLexicalEditor(field, "argument");
	await userEvent.keyboard("{Enter}");
	await waitFor(() => expect(send.mock.calls[0]?.[0]).toBe("$compact argument"));
	expect(compact).not.toHaveBeenCalled();
});

it("clears persisted selection when a replacement draft has the same visible token", async () => {
	const sessionId = `library-replacement-${crypto.randomUUID()}`;
	const focusRef = createRef<ChatComposerHandle>();
	const { field } = setup([row()], { draftSessionId: sessionId, focusRef });
	await typeAndPressInLexicalEditor(field, "$rev", "Tab");
	expect(readChatSessionDraft(sessionId).composer.skillSelection).toBeDefined();
	act(() => focusRef.current?.setDraft("$review "));
	expect(readChatSessionDraft(sessionId).composer.skillSelection).toBeUndefined();
});

it.each(["native_skill", "native_text"])("keeps provider-correct steering behavior for %s", async (transport) => {
	const steer = vi.fn().mockResolvedValue(undefined);
	const marker = transport === "native_skill" ? "$" : "/";
	const { field, send } = setup([row({ transport, token: `${marker}review` })], { onSteer: steer, canSteer: true, willQueue: true });
	await typeAndPressInLexicalEditor(field, marker + "rev", "Tab");
	await typeInLexicalEditor(field, "argument");
	await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
	if (transport === "native_skill") {
		await waitFor(() => expect(send.mock.calls[0]?.[5]).toMatchObject({ entryId: "entry-one" }));
		expect(steer).not.toHaveBeenCalled();
	} else {
		await waitFor(() => expect(steer).toHaveBeenCalledWith("/review argument"));
		expect(send).not.toHaveBeenCalled();
	}
});
