import { useNavigate } from "@tanstack/react-router";
import { useSplitPanesEnabled } from "../../lib/split-panes";
import { groupContaining, leafKeys } from "../../lib/pane-split";
import { canSplitSessionTab, MAX_SESSION_TAB_PANES, selectedSessionTabsGroup, sessionTabKey, sessionTabPaneScope, splitSessionTabRight } from "../../lib/session-tab-panes";
import { useSplitPanesStore } from "../../stores/split-panes-store";
import { useTabSelectionStore, type SessionTabSelection } from "../../stores/tab-selection-store";
import { confirmPaneRemoval, SessionPaneContext } from "../session-pane-context";
import { sessionNavigateTarget } from "../../lib/navigate-to-session";
import { TabSplitItems, TabSplitMenuContext } from "../TabContextMenu";
import { SESSION_TAB_KEY } from "../../lib/pane-split";
import { useParams } from "@tanstack/react-router";
import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProjectOrchestratorAction } from "../../hooks/useProjectOrchestratorAction";
import { useWorkspaceScope } from "../../hooks/useWorkspaceQuery";
import type { MessageKey } from "../../i18n/messages";
import { PROJECT_COLOR_SLOTS, projectColorCss } from "../../lib/project-colors";
import { cn } from "../../lib/utils";
import { parseSessionLink } from "../../lib/session-links";
import { useResolvedTheme, useUiStore } from "../../stores/ui-store";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { STANDALONE_WORKSPACE_ID } from "../../types/workspace";
import type { TopbarTabProps } from "./TopbarTab";
import type { TopbarMenuEntry } from "./topbar-tab-menu";
import { buildTopbarTabMenu } from "./topbar-tab-menu";
import { useTopbarTabsActions } from "./useTopbarTabsActions";
import { ContextMenuItem, ContextMenuSeparator } from "../ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";

type RenderMenu = NonNullable<TopbarTabProps["renderMenu"]>;

function createSessionLink(projectId: string, sessionId: string): string | undefined {
	const link = new URL("ao://sessions/");
	link.pathname = `/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`;
	return parseSessionLink(link.href) ? link.href : undefined;
}

function OpenOrchestratorItem({
	groupId,
	kind,
}: {
	groupId: string;
	kind: "dropdown" | "context";
}) {
	const { t } = useTranslation();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const scope = useWorkspaceScope(groupId, undefined);
	const action = useProjectOrchestratorAction({
		projectId: groupId,
		project: scope.data?.project,
		orchestrator: scope.data?.orchestrator,
		source: "topbar",
		sessionId: params.sessionId,
	});
	const label = t("shell.tabs.menu.openOrchestrator");
	const onSelect = () => action.openOrchestrator();
	return kind === "dropdown" ? (
		<DropdownMenuItem onSelect={onSelect}>{label}</DropdownMenuItem>
	) : (
		<ContextMenuItem onSelect={onSelect}>{label}</ContextMenuItem>
	);
}

export function useTopbarTabMenu(canRename = true): RenderMenu {
	const { t } = useTranslation();
	const actions = useTopbarTabsActions();
	const split = useContext(TabSplitMenuContext);
	const pane = useContext(SessionPaneContext);
	const enabled = useSplitPanesEnabled();
	const selected = useTabSelectionStore((state) => state.selected);
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { sessionId?: string; projectId?: string };
	return ({ kind, view, startRename, sessionMenuItems }): ReactNode => {
		const state = useTopbarTabsStore.getState().tabs;
		const group = state.groups.find((candidate) => candidate.id === view.groupId);
		const groupTabCount = group?.tabs.length ?? 0;
		const tabIndex = view.sessionId ? group?.tabs.findIndex((tab) => tab.sessionId === view.sessionId) ?? -1 : -1;
		const entries = buildTopbarTabMenu(view, {
			groupCollapsed: group?.collapsed ?? false,
			groupTabCount,
			groupCount: state.groups.length,
			canRename,
			canCloseToRight: view.role === "head" ? groupTabCount > 0 : tabIndex >= 0 && tabIndex < groupTabCount - 1,
		});
		const current = pane?.sessionId ? { sessionId: pane.sessionId, projectId: pane.projectId } : params.sessionId ? { sessionId: params.sessionId, projectId: params.projectId } : undefined;
		const tab = view.sessionId ? { sessionId: view.sessionId, projectId: view.groupId === STANDALONE_WORKSPACE_ID ? undefined : view.groupId } : undefined;
		const activate = (target: SessionTabSelection) => {
			pane?.activate?.(target);
			void navigate(sessionNavigateTarget(target.projectId, target.sessionId));
		};
		const availableSelected = selected.filter((tab) => state.groups.some((group) => (group.id === STANDALONE_WORKSPACE_ID ? undefined : group.id) === tab.projectId && (group.head.sessionId === tab.sessionId || group.tabs.some((item) => item.sessionId === tab.sessionId))));
		const viewSelected = async () => {
			if (availableSelected.length < 2 || availableSelected.length > MAX_SESSION_TAB_PANES || !await confirmPaneRemoval(new Set(availableSelected.map(sessionTabKey)))) return;
			selectedSessionTabsGroup(availableSelected);
			activate(availableSelected[0]);
		};
		const openRight = async () => {
			if (!tab || !current) return;
			const groups = useSplitPanesStore.getState().groupsBySession[sessionTabPaneScope()] ?? [];
			const existing = groupContaining(groups, sessionTabKey(tab));
			const anchor = groupContaining(groups, sessionTabKey(current));
			const keep = existing ? leafKeys(existing.root) : [...(anchor ? leafKeys(anchor.root) : [sessionTabKey(current)]), sessionTabKey(tab)];
			if (!await confirmPaneRemoval(new Set(keep))) return;
			splitSessionTabRight(tab, current);
			activate(tab);
		};
		const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
		return (
			<>
				{/* These are Radix DropdownMenu items and cannot be rendered in a ContextMenu. */}
				{kind === "dropdown" && sessionMenuItems ? (
					<>
						{sessionMenuItems}
						<DropdownMenuSeparator />
					</>
				) : null}
				{enabled && tab ? <>
					<Item disabled={availableSelected.length < 2 || availableSelected.length > MAX_SESSION_TAB_PANES} onSelect={() => window.setTimeout(() => void viewSelected(), 0)}>{t("shell.tabs.menu.viewSplitPanes")}</Item>
					<Item disabled={!current || !canSplitSessionTab(tab, current)} onSelect={() => window.setTimeout(() => void openRight(), 0)}>{t("shell.tabs.menu.newPaneRight")}</Item>
				</> : null}
				{view.isActive && view.session && split ? <TabSplitItems actions={split(SESSION_TAB_KEY)} kind={kind} /> : null}
				{entries.map((entry) => (
					<MenuEntry
						key={entry.id}
						entry={entry}
						kind={kind}
						view={view}
						startRename={startRename}
						actions={actions}
					/>
				))}
				{view.role === "head" ? <ProjectColorMenuRow groupId={view.groupId} kind={kind} /> : null}
			</>
		);
	};
}

function ProjectColorMenuRow({ groupId, kind }: { groupId: string; kind: "dropdown" | "context" }) {
	const { t } = useTranslation();
	const enabled = useTopbarTabsStore((state) => state.colorCoding);
	const currentSlot = useTopbarTabsStore((state) => state.projectColors[groupId]);
	const theme = useResolvedTheme();
	if (!enabled || groupId === STANDALONE_WORKSPACE_ID) return null;

	const separator = kind === "dropdown" ? <DropdownMenuSeparator /> : <ContextMenuSeparator />;
	return (
		<>
			{separator}
			<div aria-label={t("shell.tabs.menu.projectColor")} className="flex flex-col gap-2 px-2 py-2" role="group">
				<span className="text-xs text-foreground">{t("shell.tabs.menu.projectColor")}</span>
				<div className="flex items-center gap-1.5">
					{Array.from({ length: PROJECT_COLOR_SLOTS }, (_, slot) => (
						<button
							key={slot}
							aria-label={t("shell.tabs.menu.projectColorSlot", { n: slot + 1 })}
							aria-pressed={currentSlot === slot}
							className={cn(
								"size-3.5 shrink-0 rounded-full border border-foreground/20",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2",
								currentSlot === slot && "ring-2 ring-foreground ring-offset-2",
							)}
							onClick={() => useTopbarTabsStore.getState().setProjectColor(groupId, slot)}
							style={{ backgroundColor: projectColorCss(slot, theme) }}
							type="button"
						/>
					))}
				</div>
			</div>
		</>
	);
}

function MenuEntry({
	entry,
	kind,
	view,
	startRename,
	actions,
}: {
	entry: TopbarMenuEntry;
	kind: "dropdown" | "context";
	view: Parameters<RenderMenu>[0]["view"];
	startRename: () => void;
	actions: ReturnType<typeof useTopbarTabsActions>;
}) {
	const { t } = useTranslation();
	const label = t(entry.labelKey as MessageKey);
	const onSelect = () => {
		switch (entry.run) {
			case "rename":
				startRename();
				break;
			case "keepOpen":
				actions.persist(view);
				break;
			case "close":
				actions.close(view);
				break;
			case "closeOthers":
				actions.closeOthers(view);
				break;
			case "closeToRight":
				actions.closeToRight(view);
				break;
			case "closeAll":
				actions.closeAll(view);
				break;
			case "copyLink":
				void copySessionLink(view, t("shell.tabs.linkCopied"));
				break;
			case "toggleCollapsed":
				actions.toggleCollapsed(view.groupId);
				break;
			case "newTask":
				useUiStore.getState().requestNewTask(view.groupId);
				break;
			case "closeGroup":
				actions.closeGroup(view.groupId);
				break;
			case "closeOtherGroups":
				actions.closeOtherGroups(view.groupId);
				break;
			case "openOrchestrator":
				break;
		}
	};
	const separator = entry.separatorBefore
		? kind === "dropdown" ? <DropdownMenuSeparator /> : <ContextMenuSeparator />
		: null;
	if (entry.run === "openOrchestrator") {
		return (
			<>
				{separator}
				<OpenOrchestratorItem groupId={view.groupId} kind={kind} />
			</>
		);
	}
	if (kind === "dropdown") {
		return (
			<>
				{separator}
				<DropdownMenuItem
					aria-keyshortcuts={entry.run === "rename" ? "F2" : undefined}
					disabled={entry.disabled}
					onSelect={onSelect}
				>
					{label}
				</DropdownMenuItem>
			</>
		);
	}
	return (
		<>
			{separator}
			<ContextMenuItem
				aria-keyshortcuts={entry.run === "rename" ? "F2" : undefined}
				disabled={entry.disabled}
				onSelect={onSelect}
			>
				{label}
			</ContextMenuItem>
		</>
	);
}

async function copySessionLink(
	view: Parameters<RenderMenu>[0]["view"],
	toastTitle: string,
): Promise<void> {
	if (!view.sessionId) return;
	const link = createSessionLink(view.groupId, view.sessionId);
	if (!link) return;
	try {
		await navigator.clipboard.writeText(link);
		useUiStore.getState().showGlobalToast(toastTitle);
	} catch {
		return;
	}
}
