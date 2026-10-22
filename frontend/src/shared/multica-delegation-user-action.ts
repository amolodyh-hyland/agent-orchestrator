import { DELEGATION_CONFIRM_CLICK } from "./multica-delegation-confirmation";

export function installDelegationUserAction(doc: Document, invoke: (channel: string, input: { id: string; hash: string }) => Promise<unknown>) {
	doc.addEventListener("click", (event) => {
		if (!event.isTrusted || !doc.defaultView?.navigator.userActivation?.isActive || !(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>("button[data-delegation-preview-id]");
		if (!button || button.disabled || !button.dataset.delegationPreviewId || !button.dataset.delegationPreviewHash) return;
		void invoke(DELEGATION_CONFIRM_CLICK, { id: button.dataset.delegationPreviewId, hash: button.dataset.delegationPreviewHash });
	}, true);
}
