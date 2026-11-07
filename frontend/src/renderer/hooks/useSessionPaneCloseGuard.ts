import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { registerPaneCloseGuard } from "../components/session-pane-context";
import { hasUnstoredFileDrafts } from "../lib/file-draft-store";

export function useSessionPaneCloseGuard(id: string, draftSessionKey: string, confirmChatLeave: () => Promise<boolean>): void {
	const { t } = useTranslation();
	useEffect(() => registerPaneCloseGuard(id, async () => {
		if (hasUnstoredFileDrafts(draftSessionKey) && !window.confirm(t("files.unsavedLeaveTooLargeConfirm"))) return false;
		return confirmChatLeave();
	}), [confirmChatLeave, draftSessionKey, id, t]);
}
