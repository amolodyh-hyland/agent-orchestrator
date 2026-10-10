import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { MulticaSyncLinkView } from "../../shared/multica-status-sync";
import { isMulticaStatusCategory } from "../../shared/multica-status-writer";
import { multicaSyncReasonKeys, multicaSyncStateKeys, multicaSyncStatusKeys } from "../i18n/key-maps";
import { useMulticaSyncStore } from "../stores/multica-sync-store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

// The status-sync controls of one issue link: the switch (off until the user turns it on), what the sync is
// doing, and the ways out of a pause. The state is the main process's; this only shows it and asks for changes.
export function MulticaLinkSyncControls({ link }: { link: MulticaIssueLink }) {
	const { t } = useTranslation();
	const snapshot = useMulticaSyncStore((state) => state.snapshot);
	const load = useMulticaSyncStore((state) => state.load);
	const setLink = useMulticaSyncStore((state) => state.setLink);
	const resume = useMulticaSyncStore((state) => state.resume);
	const reopen = useMulticaSyncStore((state) => state.reopen);
	const syncNow = useMulticaSyncStore((state) => state.syncNow);
	const [confirmingReopen, setConfirmingReopen] = useState(false);

	useEffect(() => {
		void load();
	}, [load]);

	const ref = { sessionId: link.sessionId, workspaceSlug: link.workspaceSlug, issueIdentifier: link.issueIdentifier };
	const view: MulticaSyncLinkView | undefined = snapshot.links.find(
		(entry) => entry.sessionId === ref.sessionId && entry.workspaceSlug === ref.workspaceSlug && entry.issueIdentifier === ref.issueIdentifier,
	);
	const enabled = view?.enabled ?? false;
	const available = snapshot.settings.enabled && !snapshot.killSwitch;
	const switchId = `multica-sync-${link.sessionId}-${link.issueIdentifier}`;

	const statusName = (status: string): string => (isMulticaStatusCategory(status) ? t(multicaSyncStatusKeys[status]) : status);
	const detail =
		view && enabled && view.multicaStatus !== null
			? view.aoStatus !== null && view.aoStatus !== view.multicaStatus
				? t("multica.sync.detail.both", { multica: statusName(view.multicaStatus), ao: statusName(view.aoStatus) })
				: t("multica.sync.detail.multica", { multica: statusName(view.multicaStatus) })
			: null;

	return (
		<div className="space-y-1 px-2 pb-1" data-testid="multica-link-sync">
			<div className="flex items-center justify-between gap-2">
				<Label className="min-w-0 truncate text-sm" htmlFor={switchId}>
					{t("multica.sync.toggle", { issue: link.issueIdentifier })}
				</Label>
				<Switch
					checked={enabled}
					disabled={!enabled && !available}
					id={switchId}
					onCheckedChange={(next) => void setLink({ ...ref, enabled: next })}
				/>
			</div>
			{!available && !enabled ? (
				<p className="text-xs text-muted-foreground">{snapshot.killSwitch ? t("multica.sync.settings.killSwitch") : t("multica.sync.needsSettings")}</p>
			) : null}
			{view && enabled ? (
				<div className="space-y-1" role="status">
					<p className="text-xs text-foreground">{t(multicaSyncStateKeys[view.state])}</p>
					{view.reason ? <p className="text-xs text-muted-foreground">{t(multicaSyncReasonKeys[view.reason])}</p> : null}
					{detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
				</div>
			) : null}
			{view && enabled && (view.canResume || view.canReopen || view.state === "error" || view.state === "paused") ? (
				<div className="flex flex-wrap items-center gap-1">
					{view.canResume ? (
						<Button onClick={() => void resume(ref)} size="sm" type="button" variant="secondary">
							{t("multica.sync.resume")}
						</Button>
					) : null}
					{view.canReopen ? (
						<Button onClick={() => setConfirmingReopen(true)} size="sm" type="button" variant="secondary">
							{t("multica.sync.reopen")}
						</Button>
					) : null}
					<Button onClick={() => void syncNow(ref)} size="sm" type="button" variant="ghost">
						{t("multica.sync.syncNow")}
					</Button>
				</div>
			) : null}
			<ConfirmDialog
				confirmLabel={t("multica.sync.reopen.confirm")}
				description={t("multica.sync.reopen.body")}
				onConfirm={() => {
					setConfirmingReopen(false);
					void reopen(ref);
				}}
				onOpenChange={setConfirmingReopen}
				open={confirmingReopen}
				title={t("multica.sync.reopen.title", { issue: link.issueIdentifier })}
			/>
		</div>
	);
}
