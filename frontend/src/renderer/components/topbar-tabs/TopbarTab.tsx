import { MoreVertical, X } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MAX_SESSION_DISPLAY_NAME_LEN, useSessionRename } from "../../hooks/useSessionRename";
import { useTruncatedText } from "../../hooks/useTruncatedText";
import { getAgentActivityView, getSessionStatusDotView } from "../../lib/session-presentation";
import { cn } from "../../lib/utils";
import { agentLabel } from "../../lib/agent-options";
import { AgentAvatar } from "../AgentAvatar";
import { OrchestratorIcon } from "../icons";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "../ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { TopbarTabView } from "./topbar-tabs-view";

export type SessionTabActions = {
	menuItems: ReactNode;
	inlineStatus?: ReactNode;
} | null;

export type TopbarTabProps = {
	view: TopbarTabView;
	density: "comfortable" | "compact";
	hiddenCount?: number;
	onActivate: (view: TopbarTabView) => void;
	onPersist: (view: TopbarTabView) => void;
	onClose: (view: TopbarTabView) => void;
	onRenamed?: () => void | Promise<void>;
	renderMenu?: (ctx: {
		kind: "dropdown" | "context";
		view: TopbarTabView;
		startRename: () => void;
		sessionMenuItems?: ReactNode;
	}) => ReactNode;
	tabAction?: SessionTabActions;
	className?: string;
	isTabbable?: boolean;
	accent?: string;
};

export const TopbarTab = memo(function TopbarTab({
	view,
	density,
	hiddenCount = 0,
	onActivate,
	onPersist,
	onClose,
	onRenamed,
	renderMenu,
	tabAction,
	className,
	isTabbable,
	accent,
}: TopbarTabProps): JSX.Element {
	const { t } = useTranslation();
	const wrapperRef = useRef<HTMLSpanElement>(null);
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(view.label);
	// The cloud control-plane client does not expose a session rename operation.
	const renameSession = view.role !== "head" && !view.session?.cloud ? view.session : undefined;
	const rename = useSessionRename(renameSession, onRenamed);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const isHead = view.role === "head";
	const isProminent = isHead || view.role === "scratch";
	const canClose = view.role !== "head";
	const sessionActions = view.isActive && view.session ? tabAction : null;
	const switchingInterface = Boolean(sessionActions?.inlineStatus);
	const activityLabel = view.session ? getAgentActivityView(view.session.activity, t).label : undefined;
	const providerLabel = view.session ? agentLabel(view.session.provider) : undefined;
	const ariaLabel = isHead
		? view.label
		: [view.label, providerLabel, activityLabel].filter(Boolean).join(" · ");
	const statusDot = view.session && !view.isAnchor ? getSessionStatusDotView(view.session) : undefined;
	const accentStyle = {
		borderRadius: 0,
		borderWidth: 0,
		...(accent === undefined ? {} : { "--project-accent": accent }),
	} as CSSProperties;
	useLayoutEffect(() => {
		if (accent === undefined) wrapperRef.current?.style.removeProperty("--project-accent");
	}, [accent]);
	const mainButtonClassName = cn(
		"inline-flex h-full min-w-0 shrink-0 cursor-pointer items-center gap-2 text-left leading-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50",
		density === "comfortable" ? "px-3 text-control" : "px-2 text-xs",
		isProminent && "font-semibold text-foreground",
		!isProminent && "max-w-[200px]",
	);
	const actionButtonClassName = cn(
		"self-center inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-none text-passive opacity-0 pointer-events-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-[active=true]:pointer-events-auto group-data-[active=true]:opacity-100",
	);
	const startRename = () => {
		setIsMenuOpen(false);
		window.setTimeout(() => rename.begin(), 0);
	};
	const handleAuxClick = (event: MouseEvent<HTMLSpanElement>) => {
		if (event.button === 1) onClose(view);
	};
	const contents = (
		<span
			ref={wrapperRef}
			className={cn(
				"group relative inline-flex h-full shrink-0 items-stretch",
				accent !== undefined && "isolate",
				className,
				view.isActive && "bg-overlay text-foreground",
				!view.isActive && isProminent && "bg-overlay/55 text-foreground",
				!view.isActive && !isProminent && "text-passive hover:bg-interactive-hover hover:text-foreground",
			)}
			data-active={view.isActive}
			data-accent={accent === undefined ? undefined : "true"}
			data-group-id={view.groupId}
			data-mode={view.mode}
			data-role={view.role}
			data-testid="topbar-tab"
			style={accentStyle}
			onAuxClick={handleAuxClick}
			onMouseDown={(event) => {
				if (event.button === 1) event.preventDefault();
			}}
		>
			{accent !== undefined ? (
				<>
					<span
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute inset-0 -z-10",
							isHead
								? "bg-[color-mix(in_oklch,var(--project-accent)_14%,transparent)]"
								: "bg-[color-mix(in_oklch,var(--project-accent)_6%,transparent)]",
						)}
						data-testid="topbar-tab-accent-tint"
					/>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px] bg-[var(--project-accent)]"
						data-testid="topbar-tab-accent-indicator"
					/>
				</>
			) : null}
			{renameSession && rename.isEditing ? (
				<span className="inline-flex h-full min-w-0 shrink-0 items-center px-3">
					{view.session ? (
						<AgentAvatar className="size-terminal-agent-icon shrink-0" decorative provider={view.session.provider} />
					) : null}
					<input
						aria-label={t("shell.renameSession", { title: renameSession.title })}
						autoFocus
						className="min-w-0 flex-1 bg-background px-1 text-control text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50"
						maxLength={MAX_SESSION_DISPLAY_NAME_LEN}
						onBlur={() => void rename.commit()}
						onChange={(event) => rename.setDraft(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.currentTarget.blur();
							} else if (event.key === "Escape") {
								event.preventDefault();
								rename.cancel();
							}
						}}
						value={rename.draft}
					/>
				</span>
			) : (
				<button
					ref={ref}
					aria-current={view.isActive}
					aria-keyshortcuts={renameSession ? "F2" : undefined}
					aria-label={ariaLabel}
					aria-selected={view.isActive}
					className={mainButtonClassName}
					onClick={(event) => {
						if (event.detail < 2) onActivate(view);
					}}
					onDoubleClick={() => onPersist(view)}
					onKeyDown={renameSession
						? (event) => {
								if (event.key !== "F2") return;
								event.preventDefault();
								rename.begin();
							}
						: undefined}
					role="tab"
					tabIndex={(isTabbable ?? view.isActive) ? 0 : -1}
					title={isTruncated ? view.label : undefined}
					style={{ borderRadius: 0, borderWidth: 0 }}
					type="button"
				>
					<span
						className={cn(
							"relative inline-flex shrink-0 items-center justify-center",
							isHead && !view.session ? "size-3.5" : "size-terminal-agent-icon",
						)}
					>
						{isHead && !view.session ? (
							<OrchestratorIcon aria-hidden="true" className="size-3.5 shrink-0" />
						) : view.session ? (
							<AgentAvatar className="size-terminal-agent-icon" decorative provider={view.session.provider} />
						) : (
							<span aria-hidden="true" className="size-2 rounded-full bg-muted-foreground/50" />
						)}
						{statusDot ? (
							<span
								aria-hidden="true"
								className={cn(
									"absolute bottom-0 right-0 size-1.5 rounded-full",
									statusDot.className,
									statusDot.breathe && "animate-pulse",
								)}
								data-testid="topbar-tab-status-dot"
							/>
						) : null}
					</span>
					<span
						className={cn(
							"truncate",
							isHead && view.isAnchor && "opacity-70",
							view.mode === "preview" && !view.isAnchor && "italic",
						)}
					>
						{view.label}
					</span>
					{isHead && hiddenCount > 0 ? (
						<span
							aria-label={t("shell.tabs.hiddenCount", { count: hiddenCount })}
							className="shrink-0 text-passive"
						>
							+{hiddenCount}
						</span>
					) : null}
				</button>
			)}
			{canClose ? (
				<button
					aria-label={t("shell.tabs.close")}
					className={actionButtonClassName}
					onClick={() => onClose(view)}
					tabIndex={-1}
					type="button"
				>
					<span className="flex size-5 items-center justify-center">
						<X aria-hidden="true" className="size-3.5" />
					</span>
				</button>
			) : null}
			{switchingInterface ? (
				<span className="inline-flex shrink-0 items-center">{sessionActions?.inlineStatus}</span>
			) : renderMenu ? (
				<DropdownMenu onOpenChange={setIsMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							aria-label={t("shell.tabs.options")}
							className={cn(
								actionButtonClassName,
								isMenuOpen && "pointer-events-auto opacity-100",
							)}
							data-topbar-tab-options-trigger
							type="button"
						>
							<span className="flex size-5 items-center justify-center">
								<MoreVertical aria-hidden="true" className="size-3.5" />
							</span>
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						{renderMenu({
							kind: "dropdown",
							view,
							startRename,
							sessionMenuItems: sessionActions?.menuItems,
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			{view.isActive ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground/80"
					data-testid="topbar-tab-active-indicator"
				/>
			) : null}
		</span>
	);

	if (!renderMenu || switchingInterface) return contents;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{contents}</ContextMenuTrigger>
			<ContextMenuContent>{renderMenu({ kind: "context", view, startRename })}</ContextMenuContent>
		</ContextMenu>
	);
});
