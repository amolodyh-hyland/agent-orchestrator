import { useEffect } from "react";
import { setUnsavedLeaveGuard } from "../lib/navigation-history";

/**
 * While `unsaved` is true, Back/Forward ask before they move away: `message` when the draft is
 * kept for the return, `unstoredMessage` when `isUnstored()` says its text could not be kept
 * and would be lost.
 */
export function useUnsavedLeaveGuard(unsaved: boolean, message: string, unstoredMessage: string, isUnstored: () => boolean): void {
	useEffect(() => {
		if (!unsaved) return;
		return setUnsavedLeaveGuard(() => (isUnstored() ? unstoredMessage : message));
	}, [isUnstored, message, unsaved, unstoredMessage]);
}
