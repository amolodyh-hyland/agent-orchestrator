import { DELEGATION_CANCEL_CLICK, DELEGATION_CONFIRM_CLICK, type DelegationCancellation } from "./multica-delegation-confirmation";

export function installDelegationUserAction(doc: Document, invoke: (channel: string, input: { id: string; hash: string } | DelegationCancellation) => Promise<unknown>) {
	doc.addEventListener("click", (event) => {
		if (!event.isTrusted || !doc.defaultView?.navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
		const cancel = event.target.closest<HTMLButtonElement>("button[data-delegation-cancel-request-id]");
		if (cancel && !cancel.disabled && cancel.dataset.delegationCancelRequestId && cancel.dataset.delegationCancelRemoteId) {
			void invoke(DELEGATION_CANCEL_CLICK, { requestId: cancel.dataset.delegationCancelRequestId, remoteId: cancel.dataset.delegationCancelRemoteId });
			return;
		}
		const button = event.target.closest<HTMLButtonElement>("button[data-delegation-preview-id]");
		if (!button || button.disabled || !button.dataset.delegationPreviewId || !button.dataset.delegationPreviewHash) return;
		void invoke(DELEGATION_CONFIRM_CLICK, { id: button.dataset.delegationPreviewId, hash: button.dataset.delegationPreviewHash });
	}, true);
}
