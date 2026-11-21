import { useState } from "react";
import { dropdownMenuKit, MenuCloseContext, MenuKitContext } from "../menu-model";
import { MoreVertical } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { SessionTabActions } from "./TopbarTab";

/** The session actions menu for a remote-host session's own tab. */
export function RemoteSessionTabAction({ actions }: { actions: SessionTabActions }): JSX.Element | null {
 const { t } = useTranslation();
 const [open, setOpen] = useState(false);
 if (!actions) return null;
 if (actions.renderMenu) return <>{actions.renderMenu(null)}</>;
 return <>{actions.inlineStatus}<DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger asChild><button type="button" aria-label={t("session.actionsMenu")}><MoreVertical className="size-icon-sm" /></button></DropdownMenuTrigger><DropdownMenuContent><MenuKitContext.Provider value={dropdownMenuKit}><MenuCloseContext.Provider value={() => setOpen(false)}>{actions.menuItems}</MenuCloseContext.Provider></MenuKitContext.Provider></DropdownMenuContent></DropdownMenu></>;
}
