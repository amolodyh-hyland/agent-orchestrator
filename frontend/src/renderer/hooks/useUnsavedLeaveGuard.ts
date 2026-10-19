import { useEffect } from "react";
import { hasUnstoredFileDraft } from "../lib/file-draft-store";
import { setUnsavedLeaveGuard } from "../lib/navigation-history";

/**
 * While `unsaved` is true, Back/Forward ask before they move away: `message` when the draft is
 * kept for the return, `unstoredMessage` when it was too large to keep and would be lost.
 */
export function useUnsavedLeaveGuard(unsaved: boolean, message: string, unstoredMessage: string): void {
	useEffect(() => {
		if (!unsaved) return;
		return setUnsavedLeaveGuard(() => (hasUnstoredFileDraft() ? unstoredMessage : message));
	}, [message, unsaved, unstoredMessage]);
}
