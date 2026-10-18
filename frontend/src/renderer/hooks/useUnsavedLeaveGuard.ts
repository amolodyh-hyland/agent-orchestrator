import { useEffect } from "react";
import { setUnsavedLeaveGuard } from "../lib/navigation-history";

/** While `unsaved` is true, Back/Forward ask `message` before they move away. */
export function useUnsavedLeaveGuard(unsaved: boolean, message: string): void {
	useEffect(() => {
		if (!unsaved) return;
		return setUnsavedLeaveGuard(() => message);
	}, [message, unsaved]);
}
