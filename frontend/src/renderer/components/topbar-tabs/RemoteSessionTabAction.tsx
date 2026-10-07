import type { JSX } from "react";
import { SessionActionsMenu } from "../SessionActionsMenu";
import type { SessionTabActions } from "./TopbarTab";

/** The session actions menu for a remote-host session's own tab. */
export function RemoteSessionTabAction({ actions }: { actions: SessionTabActions }): JSX.Element | null {
	if (!actions) return null;
	return <SessionActionsMenu inlineStatus={actions.inlineStatus}>{actions.menuItems}</SessionActionsMenu>;
}
