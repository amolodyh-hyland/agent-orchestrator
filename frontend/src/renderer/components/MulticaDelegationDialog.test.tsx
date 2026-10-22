import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DelegationConfirmationBridge, DelegationDraft } from "../../shared/multica-delegation-confirmation";
import { MulticaDelegationDialog } from "./MulticaDelegationDialog";
import { installDelegationUserAction } from "../../shared/multica-delegation-user-action";

function fixture() {
	let listener: Parameters<DelegationConfirmationBridge["onResult"]>[0] = () => undefined;
	const bridge: DelegationConfirmationBridge = {
		setCredential: vi.fn(async () => false),
		preview: vi.fn(async (request: DelegationDraft) => ({ ok: true as const, preview: {
			id: "preview", hash: "hash", expiresAt: Date.now() + 120_000, request: { ...request },
			serverKey: "configured", serverOrigin: "https://multica.example", profileName: "Reviewer", scope: "task_brief" as const, policy: "policy_absent" as const,
		} })),
		cancelPreview: vi.fn(async () => undefined),
		onResult: vi.fn((next) => { listener = next; return () => undefined; }),
	};
	return { bridge, result: (value: Parameters<typeof listener>[0]) => listener(value) };
}
async function openAndPreview() {
	fireEvent.click(screen.getByRole("button", { name: "Delegate to Multica" }));
	for (const label of ["Multica workspace ID", "Profile ID", "Bound runtime ID", "AO task ID", "Title", "Task brief"]) {
		fireEvent.change(screen.getByLabelText(label), { target: { value: `approved ${label}` } });
	}
	fireEvent.click(screen.getByRole("button", { name: "Preview delegation" }));
	await screen.findByRole("button", { name: "Confirm delegation" });
}

describe("shared task and project delegation dialog", () => {
	it.each(["task", "project"] as const)("shows the exact %s handoff and waits for confirmation", async (orchestrator) => {
		const f = fixture();
		render(<MulticaDelegationDialog orchestrator={orchestrator} projectId="project" bridge={f.bridge} />);
		expect(f.bridge.preview).not.toHaveBeenCalled();
		await openAndPreview();
		expect(f.bridge.preview).toHaveBeenCalledWith(expect.objectContaining({ orchestrator, projectId: "project", brief: "approved Task brief" }));
		expect(screen.getByLabelText("Delegation preview")).toHaveTextContent("Reviewer (approved Profile ID)");
		expect(screen.getByLabelText("Delegation preview")).toHaveTextContent("https://multica.example");
		expect(screen.getByLabelText("Delegation preview")).toHaveTextContent("approved Bound runtime ID");
		expect(screen.getByLabelText("Delegation preview")).toHaveTextContent("No files, roots, attachments or history.");
		expect(screen.getByLabelText("Delegation preview")).toHaveTextContent("Personal selection (no managed policy)");
		const confirm = screen.getByRole("button", { name: "Confirm delegation" });
		expect(confirm).toHaveAttribute("data-delegation-preview-id", "preview");
		expect(confirm).toHaveAttribute("data-delegation-preview-hash", "hash");
		fireEvent.click(confirm);
		expect(f.bridge.preview).toHaveBeenCalledTimes(1);
		act(() => f.result({ previewId: "preview", result: { ok: false, code: "cancelled" } }));
		expect(screen.getByRole("status")).toHaveTextContent("Delegation cancelled.");
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
	});
	it("cancels a pending preview on close and on a profile edit", async () => {
		const f = fixture(); render(<MulticaDelegationDialog orchestrator="task" projectId="project" bridge={f.bridge} />);
		await openAndPreview();
		fireEvent.change(screen.getByLabelText("Profile ID"), { target: { value: "changed profile" } });
		expect(f.bridge.cancelPreview).toHaveBeenCalledWith("preview");
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Preview delegation" }));
		await screen.findByRole("button", { name: "Confirm delegation" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(f.bridge.cancelPreview).toHaveBeenCalledTimes(2);
	});
	it.each(["Profile ID", "Bound runtime ID", "Multica workspace ID", "Task brief", "Title"])("revokes an in-flight confirmation when %s is edited", async (label) => {
		const f = fixture(); render(<MulticaDelegationDialog orchestrator="task" projectId="project" bridge={f.bridge} />);
		await openAndPreview();
		fireEvent.click(screen.getByRole("button", { name: "Confirm delegation" }));
		fireEvent.change(screen.getByLabelText(label), { target: { value: "changed" } });
		expect(f.bridge.cancelPreview).toHaveBeenCalledExactlyOnceWith("preview");
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
		act(() => f.result({ previewId: "preview", result: { ok: true, requestId: "stale", state: "accepted" } }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
	it.each([ ["accepted", "Multica accepted this delegation."], ["submission_unknown", "Submission outcome is unknown."] ])("reports %s truthfully", async (state, message) => {
		const f = fixture(); render(<MulticaDelegationDialog orchestrator="task" projectId="project" bridge={f.bridge} />);
		await openAndPreview();
		act(() => f.result({ previewId: "preview", result: { ok: true, requestId: "request", state } }));
		expect(screen.getByRole("status")).toHaveTextContent(message);
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
	});
	it("shows safe policy denial and conflict reasons", async () => {
		const f = fixture(); vi.mocked(f.bridge.preview).mockResolvedValueOnce({ ok: false, code: "policy_denied" });
		render(<MulticaDelegationDialog orchestrator="project" projectId="project" bridge={f.bridge} />);
		fireEvent.click(screen.getByRole("button", { name: "Delegate to Multica" }));
		fireEvent.click(screen.getByRole("button", { name: "Preview delegation" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Policy does not allow this delegation.");
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Preview delegation" }));
		await screen.findByRole("button", { name: "Confirm delegation" });
		act(() => f.result({ previewId: "preview", result: { ok: false, code: "runtime_binding_changed" } }));
		expect(screen.getByRole("status")).toHaveTextContent("The profile’s runtime changed.");
	});
	it("does not preview or dispatch on reassignment or project/task status events", async () => {
		const f = fixture();
		const props = { orchestrator: "task" as const, projectId: "project", taskId: "task", title: "Task", bridge: f.bridge };
		const view = render(<MulticaDelegationDialog {...props} />);
		for (const type of ["issue-reassigned", "project-status-changed", "task-status-changed", "task-created"]) {
			window.dispatchEvent(new CustomEvent(type, { detail: { confirmed: true, token: "forged" } }));
			view.rerender(<MulticaDelegationDialog {...props} title={`Updated ${type}`} />);
		}
		await waitFor(() => expect(f.bridge.preview).not.toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Confirm delegation" })).not.toBeInTheDocument();
	});
	it("isolated preload ignores scripted clicks even with forged preview attributes", () => {
		const invoke = vi.fn(async () => undefined);
		installDelegationUserAction(document, invoke);
		render(<button data-delegation-preview-id="forged" data-delegation-preview-hash="forged">Forged approval</button>);
		fireEvent.click(screen.getByRole("button", { name: "Forged approval" }));
		expect(invoke).not.toHaveBeenCalled();
	});
});
