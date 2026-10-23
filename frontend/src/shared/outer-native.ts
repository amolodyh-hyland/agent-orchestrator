export const OUTER_STAGE = "outer:stage";
export const OUTER_CANCEL = "outer:cancel";
export const OUTER_USER_ACTION = "outer:userAction";
export const OUTER_RESULT = "outer:result";

export type OuterControlAction =
	| "session.spawn"
	| "orchestrator.ensure"
	| "session.send"
	| "session.restore"
	| "session.resume"
	| "session.kill"
	| "session.switch"
	| "chat.send"
	| "chat.settings"
	| "chat.approval"
	| "chat.input"
	| "chat.cancel"
	| "project.settings"
	| "project.config"
	| "project.permissions"
	| "task.prepare"
	| "run.create"
	| "run.evidence"
	| "run.advance"
	| "review.trigger"
	| "review.cancel"
	| "pr.merge"
	| "pr.resolve"
	| "terminal.bind";
export type OuterSendExpectation = {
	bindingRevision: number;
	scopeRevision: number;
	controllerGeneration: string;
	settingsDigest: string;
};
export type OuterNativeDraft =
	| { operation: "setup"; config: Record<string, unknown> }
	| {
			operation: "scope";
			revision: number;
			projectIds: string[];
			paused: boolean;
			foregroundReserve: boolean;
	  }
	| {
			operation: "send";
			sessionId: string;
			text: string;
			expected: OuterSendExpectation;
	  }
	| {
			operation: "control";
			control: {
				action: OuterControlAction;
				targetId: string;
				pendingId?: string;
				generation?: string;
				body: unknown;
			};
	  };
export type OuterStage = { id: string; digest: string; expiresAt: number };
export type OuterResult = {
	id: string;
	ok: boolean;
	uncertain: boolean;
	record?: unknown;
};
export type OuterNativeBridge = {
	stage(slot: string, draft: OuterNativeDraft): Promise<OuterStage | null>;
	cancel(id: string): Promise<void>;
	onResult(listener: (result: OuterResult) => void): () => void;
};

// Only the isolated preload installs this listener. The page bridge can stage
// inert data, but cannot invoke the human-action channel or obtain a signer.
export function installOuterUserAction(
	doc: Document,
	invoke: (
		channel: string,
		input: { id: string; digest: string }
	) => Promise<unknown>
) {
	const act = (event: Event, root: HTMLElement | null) => {
		if (
			!event.isTrusted ||
			!doc.defaultView?.navigator.userActivation?.isActive ||
			!root
		)
			return;
		const id = root.dataset.outerStageId,
			digest = root.dataset.outerStageDigest;
		if (
			!id ||
			!digest ||
			root.getAttribute("aria-disabled") === "true" ||
			(root instanceof HTMLButtonElement && root.disabled)
		)
			return;
		event.preventDefault();
		event.stopImmediatePropagation();
		// Close this exact UI action synchronously, before the IPC round trip.
		// A new draft gets a new stage; a second click cannot spend this one.
		for (const element of doc.querySelectorAll<HTMLElement>(
			"[data-outer-stage-id]"
		)) {
			if (element.dataset.outerStageId !== id) continue;
			element.setAttribute("aria-disabled", "true");
			if (element instanceof HTMLButtonElement) element.disabled = true;
		}
		void invoke(OUTER_USER_ACTION, { id, digest });
	};
	doc.addEventListener(
		"click",
		(event) => {
			if (!(event.target instanceof Element)) return;
			act(
				event,
				event.target.closest<HTMLElement>("button[data-outer-stage-id]")
			);
		},
		true
	);
	doc.addEventListener(
		"keydown",
		(event) => {
			if (
				event.key !== "Enter" ||
				event.shiftKey ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.isComposing ||
				event.repeat ||
				!(event.target instanceof Element)
			)
				return;
			const editor = event.target.closest<HTMLElement>(
				"[contenteditable=true][data-lexical-editor]"
			);
			const form =
				editor?.closest<HTMLElement>("form[data-outer-stage-id]") ??
				null;
			// Completion menus own Enter until the human has chosen a completion.
			if (
				doc.querySelector("[role=listbox]") ||
				editor?.getAttribute("aria-expanded") === "true"
			)
				return;
			act(event, form);
		},
		true
	);
}
