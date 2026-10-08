import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useOverflowScroll } from "../../hooks/useOverflowScroll";
import { cloudSessionsQueryKey, useWorkspaceQuery, workspaceQueryKey } from "../../hooks/useWorkspaceQuery";
import { sessionNavigateTarget } from "../../lib/navigate-to-session";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { findProjectOrchestrator, STANDALONE_WORKSPACE_ID } from "../../types/workspace";
import type { SessionTabActions, TopbarTabProps } from "./TopbarTab";
import { TopbarTabGroup } from "./TopbarTabGroup";
import { topbarDragStyle, topbarNoDragStyle } from "./topbar-drag-region";
import { useTopbarTabMenu } from "./TopbarTabMenu";
import { useProjectColors } from "./useProjectColors";
import { useTopbarTabsActions } from "./useTopbarTabsActions";
import { useTopbarTabsView } from "./useTopbarTabsView";
import { computeRevealScrollLeft, type TopbarTabView } from "./topbar-tabs-view";

export type TopbarTabsProps = {
	actionsReservePx?: number;
	onSelectActiveSession?: () => void;
	onOpenOrchestrator?: (groupId: string) => void;
	onRenamed?: TopbarTabProps["onRenamed"];
	renderMenu?: TopbarTabProps["renderMenu"];
	tabAction?: (view: TopbarTabView) => SessionTabActions;
};

export function TopbarTabs({
	actionsReservePx = 0,
	onSelectActiveSession,
	onOpenOrchestrator,
	onRenamed,
	renderMenu,
	tabAction,
}: TopbarTabsProps): JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { data: workspaces } = useWorkspaceQuery();
	const workspacesRef = useRef(workspaces);
	workspacesRef.current = workspaces;
	const { accentFor } = useProjectColors();
	const { groups } = useTopbarTabsView();
	const overflow = useTopbarTabsStore((state) => state.overflow);
	const density = useTopbarTabsStore((state) => state.density);
	const renderDefaultMenu = useTopbarTabMenu(true);
	const renderCloudMenu = useTopbarTabMenu(false);
	const renderMenuRef = useRef<TopbarTabProps["renderMenu"]>(undefined);
	renderMenuRef.current = renderMenu ?? ((context) =>
		context.view.session?.cloud ? renderCloudMenu(context) : renderDefaultMenu(context));
	const stableRenderMenu = useCallback<NonNullable<TopbarTabProps["renderMenu"]>>(
		(context) => renderMenuRef.current?.(context),
		[],
	);
	const refreshAfterRename = useCallback(async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: workspaceQueryKey }),
			queryClient.invalidateQueries({ queryKey: cloudSessionsQueryKey }),
			queryClient.invalidateQueries({ queryKey: ["cloud-session"] }),
		]);
		await onRenamed?.();
	}, [onRenamed, queryClient]);
	const handleOpenOrchestrator = useCallback((groupId: string): void => {
		if (onOpenOrchestrator) {
			onOpenOrchestrator(groupId);
			return;
		}
		const orchestrator = findProjectOrchestrator(workspacesRef.current ?? [], groupId);
		if (orchestrator) {
			void navigate(sessionNavigateTarget(groupId, orchestrator.id));
		} else {
			void navigate({ to: "/projects/$projectId", params: { projectId: groupId } });
		}
	}, [navigate, onOpenOrchestrator]);
	const actions = useTopbarTabsActions({ onOpenOrchestrator: handleOpenOrchestrator });
	const activateTab = useCallback((view: TopbarTabView): void => {
		if (view.isActive && view.sessionId && onSelectActiveSession) {
			onSelectActiveSession();
			return;
		}
		actions.activate(view);
	}, [actions.activate, onSelectActiveSession]);
	const visibleViews = groups.flatMap((group) => [
		...(group.head ? [group.head] : []),
		...(!group.collapsed ? group.tabs : []),
	]);
	const firstTabKey = visibleViews[0]?.key;
	const hasActiveTab = visibleViews.some((view) => view.isActive);
	const activeTabKey = visibleViews.find((view) => view.isActive)?.key;
	const watch = [density, activeTabKey, ...visibleViews.flatMap((view) => [view.key, view.label])].join("\u0000");
	const actionsReserve = Number.isFinite(actionsReservePx) ? Math.max(0, actionsReservePx) : 0;
	const [wrapScrolling, setWrapScrolling] = useState(false);
	const [scrollViewportWidth, setScrollViewportWidth] = useState(0);
	const { ref, canScrollLeft, canScrollRight, scrollByDirection } = useOverflowScroll<HTMLDivElement>(watch, overflow === "scroll");
	const chevronVisibilityRef = useRef({ left: canScrollLeft, right: canScrollRight });
	chevronVisibilityRef.current = { left: canScrollLeft, right: canScrollRight };

	useEffect(() => {
		if (overflow !== "wrap") {
			setWrapScrolling(false);
			return;
		}
		const container = ref.current;
		if (!container) {
			setWrapScrolling(false);
			return;
		}
		const update = () => {
			const next = container.scrollHeight > container.clientHeight;
			setWrapScrolling((current) => current === next ? current : next);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(container);
		return () => observer.disconnect();
	}, [overflow, ref, watch]);

	useEffect(() => {
		if (overflow !== "scroll") {
			setScrollViewportWidth(0);
			return;
		}
		const strip = ref.current;
		if (!strip) return;
		const update = () => setScrollViewportWidth(strip.clientWidth);
		update();
		strip.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(strip);
		return () => {
			strip.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [actionsReserve, overflow, ref]);

	const style: CSSProperties & { "--topbar-actions-w": string } = {
		"--topbar-actions-w": `${actionsReserve}px`,
		...(overflow === "scroll" ? { marginRight: "var(--topbar-actions-w)" } : {}),
		...(overflow === "wrap" && wrapScrolling ? { paddingRight: "var(--topbar-actions-w)" } : {}),
	};
	const viewportStyle: CSSProperties & { "--topbar-actions-w": string } = {
		"--topbar-actions-w": `${actionsReserve}px`,
		...topbarNoDragStyle(),
	};

	useEffect(() => {
		if (overflow !== "scroll" || activeTabKey === undefined) return;
		const strip = ref.current;
		const activeTab = strip?.querySelector<HTMLElement>('[role="tab"][aria-current="true"]');
		const tabWrapper = activeTab?.closest<HTMLElement>('[data-testid="topbar-tab"]');
		if (!strip || !activeTab || !tabWrapper) return;
		const { left: leftChevronVisible, right: rightChevronVisible } = chevronVisibilityRef.current;
		const stripBounds = strip.getBoundingClientRect();
		const tabBounds = tabWrapper.getBoundingClientRect();
		const nextScrollLeft = computeRevealScrollLeft({
			scrollLeft: strip.scrollLeft,
			clientWidth: strip.clientWidth,
			actionsReservePx: 0,
			leftChevronVisible,
			rightChevronVisible,
			tabLeft: tabBounds.left - stripBounds.left + strip.scrollLeft,
			tabRight: tabBounds.right - stripBounds.left + strip.scrollLeft,
		});
		if (nextScrollLeft === strip.scrollLeft) return;
		const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
		if (typeof strip.scrollTo === "function") strip.scrollTo({ left: nextScrollLeft, behavior });
		else strip.scrollLeft = nextScrollLeft;
	}, [activeTabKey, actionsReserve, overflow, ref, watch]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
		const target = event.target;
		if (!(target instanceof HTMLButtonElement) || target.getAttribute("role") !== "tab") return;
		if (!event.currentTarget.contains(target)) return;
		const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		if (tabs.length === 0) return;
		const focusedIndex = tabs.indexOf(target);
		let nextIndex = focusedIndex;
		if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = tabs.length - 1;
		else if (event.key === "ArrowLeft") nextIndex = (focusedIndex - 1 + tabs.length) % tabs.length;
		else nextIndex = (focusedIndex + 1) % tabs.length;
		event.preventDefault();
		tabs[nextIndex].focus();
	};

	const tabListProps = {
		"aria-label": t("shell.tabs.aria"),
		"data-density": density,
		"data-overflow": overflow,
		"data-wrap-scrolling": overflow === "wrap" && wrapScrolling ? "true" : undefined,
		"data-testid": "topbar-tabs",
		className: "topbar-tabs scrollbar-none",
		role: "tablist" as const,
		style,
		onKeyDown: handleKeyDown,
	};
	const showScrollControls = overflow === "scroll" && scrollViewportWidth >= 56;

	if (groups.length === 0) {
		return (
			<div
				className="topbar-tabs__viewport"
				data-density={density}
				data-testid="topbar-tabs-viewport"
				style={viewportStyle}
			>
				<div {...tabListProps} />
			</div>
		);
	}

	return (
		<div
			className="topbar-tabs__viewport"
			data-density={density}
			data-testid="topbar-tabs-viewport"
			style={viewportStyle}
		>
			<div {...tabListProps} ref={ref}>
				{overflow === "wrap" ? (
					<span
						aria-hidden="true"
						className="topbar-tabs__actions-spacer"
						style={{ float: "right", width: "var(--topbar-actions-w)", height: "var(--topbar-row-h)" }}
					/>
				) : null}
				{groups.map((group, index) => (
					<TopbarTabGroup
						key={group.id}
						accent={group.id === STANDALONE_WORKSPACE_ID ? undefined : accentFor(group.id)}
						density={density}
						firstTabKey={firstTabKey}
						group={group}
						hasActiveTab={hasActiveTab}
						onActivate={activateTab}
						onClose={actions.close}
						onPersist={actions.persist}
						onRenamed={refreshAfterRename}
						renderMenu={stableRenderMenu}
						separatorBefore={index > 0}
						tabAction={tabAction}
					/>
				))}
				{overflow === "scroll" ? (
					<span
						aria-hidden="true"
						className="topbar-tabs__drag-filler"
						data-testid="topbar-tabs-drag-filler"
						style={topbarDragStyle()}
					/>
				) : null}
			</div>
			{showScrollControls && canScrollLeft ? (
				<>
					<span aria-hidden="true" className="topbar-tabs__scroll-fade topbar-tabs__scroll-fade--left" />
					<button
						aria-label={t("shell.tabs.scrollLeft")}
						className="topbar-tabs__scroll-button topbar-tabs__scroll-button--left"
						onClick={() => scrollByDirection(-1)}
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-4" />
					</button>
				</>
			) : null}
			{showScrollControls && canScrollRight ? (
				<>
					<span aria-hidden="true" className="topbar-tabs__scroll-fade topbar-tabs__scroll-fade--right" />
					<button
						aria-label={t("shell.tabs.scrollRight")}
						className="topbar-tabs__scroll-button topbar-tabs__scroll-button--right"
						onClick={() => scrollByDirection(1)}
						type="button"
					>
						<ChevronRight aria-hidden="true" className="size-4" />
					</button>
				</>
			) : null}
		</div>
	);
}
