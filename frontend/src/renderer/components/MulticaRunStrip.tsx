import { ExternalLink, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import type { MessageKey } from "../i18n/messages";
import { buildStripCards, isAwarenessActive, isAwarenessStale, type StripCard } from "../lib/multica-who";
import { formatSince, toneDotClass } from "../lib/multica-awareness-format";
import { sessionNavigateTarget } from "../lib/navigate-to-session";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { aoBridge } from "../lib/bridge";
import { useMulticaAwarenessStore } from "../stores/multica-awareness-store";
import { cn } from "../lib/utils";
import { MulticaWhoDialog } from "./MulticaWhoDialog";
import { Button } from "./ui/button";

const stateKeys: Record<StripCard["view"]["state"], MessageKey> = {
	queued: "multica.awareness.run.queued",
	starting: "multica.awareness.run.starting",
	running: "multica.awareness.run.running",
	waiting_folder: "multica.awareness.run.waiting_folder",
	retrying: "multica.awareness.run.retrying",
	finished: "multica.awareness.run.finished",
	ended: "multica.awareness.run.ended",
	failed: "multica.awareness.run.failed",
	cancelled: "multica.awareness.run.cancelled",
};

function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function assigneeText(card: StripCard, t: (key: MessageKey, options?: Record<string, unknown>) => string): string | null {
	const assignee = card.assignee;
	if (!assignee) return null;
	if (assignee.kind === "agent") return assignee.name ? t("multica.awareness.assignee.agent", { name: assignee.name }) : t("multica.awareness.assignee.agentAnonymous");
	if (assignee.kind === "squad") return t("multica.awareness.assignee.squad");
	return assignee.isMe ? t("multica.awareness.assignee.me") : t("multica.awareness.assignee.member");
}

/**
 * "Run by Multica": agent runs that Multica's own orchestrator started, shown
 * beside AO's board and never inside its five delivery columns. Read-only, no
 * badge and no notification for a card that is not AO's. Hidden until a
 * workspace is switched on.
 */
export function MulticaRunStrip() {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const state = useMulticaAwarenessStore((store) => store.state);
	const load = useMulticaAwarenessStore((store) => store.load);
	const workspaces = useWorkspaceQuery().data;
	const now = useNow();
	const [whoOpen, setWhoOpen] = useState(false);
	const [openFailedKey, setOpenFailedKey] = useState<string | null>(null);

	useEffect(() => {
		void load();
	}, [load]);

	const sessions = useMemo(() => (workspaces ?? []).flatMap((workspace) => workspace.sessions), [workspaces]);
	const cards = useMemo(() => buildStripCards({ state, links: state.links, sessions, nowMs: now }), [state, sessions, now]);

	if (!isAwarenessActive(state)) return null;

	return (
		<section aria-label={t("multica.awareness.strip.aria")} className="shrink-0 border-b border-border bg-surface px-3 py-2" data-testid="multica-run-strip">
			<div className="flex items-center gap-2">
				<h2 className="text-xs font-medium text-muted-foreground">{t("multica.awareness.strip.title")}</h2>
				<span className="text-caption text-muted-foreground">{cards.length}</span>
				{isAwarenessStale(state) ? (
					<span role="status" className="text-caption text-warning" data-testid="multica-strip-stale">
						{t("multica.awareness.strip.stale")}
					</span>
				) : null}
				<div className="min-w-0 flex-1" />
				<Button size="sm" type="button" variant="ghost" onClick={() => setWhoOpen(true)}>
					<Users className="size-3.5" aria-hidden="true" />
					{t("multica.awareness.strip.who")}
				</Button>
			</div>
			{cards.length === 0 ? (
				<p className="pt-1 text-caption leading-4 text-muted-foreground">{t("multica.awareness.strip.empty")}</p>
			) : (
				<ul className="flex gap-2 overflow-x-auto pt-2" data-testid="multica-run-cards">
					{cards.map((card) => {
						const assignee = assigneeText(card, t);
						return (
							<li key={card.key} className="flex w-64 shrink-0 flex-col gap-1 rounded-md border border-border bg-background px-2.5 py-2 text-xs" data-lane={card.view.lane} data-state={card.view.state}>
								<div className="flex items-center gap-1.5 text-muted-foreground">
									<span className="truncate">{card.serverLabel}</span>
									{card.workspaceSlug ? <span className="truncate">· {card.workspaceSlug}</span> : null}
									<span className="ml-auto shrink-0 font-medium text-foreground">{card.identifier}</span>
								</div>
								<p className="truncate text-foreground" title={card.title}>
									{card.title}
								</p>
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="inline-flex items-center gap-1">
										<span className={cn("size-2 rounded-full", toneDotClass[card.view.tone])} aria-hidden="true" />
										{t(stateKeys[card.view.state])}
									</span>
									{card.since ? <span className="text-muted-foreground">{formatSince(card.since, now, i18n.language)}</span> : null}
									{card.isLeader ? <span className="rounded bg-muted px-1 text-caption">{t("multica.awareness.chip.leader")}</span> : null}
									{card.isAutopilot ? <span className="rounded bg-muted px-1 text-caption">{t("multica.awareness.chip.autopilot")}</span> : null}
									{card.contested ? <span className="rounded bg-warning/20 px-1 text-caption text-warning">{t("multica.awareness.chip.contested")}</span> : null}
								</div>
								{card.agentName ? <p className="truncate text-muted-foreground">{t("multica.awareness.card.agent", { name: card.agentName })}</p> : null}
								{assignee ? <p className="truncate text-muted-foreground">{assignee}</p> : null}
								<div className="flex items-center gap-2 pt-0.5">
									<button
										type="button"
										className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
										aria-label={t("multica.links.open", { issue: card.identifier })}
										onClick={async () => {
											// Only the server the Multica page shows can open an issue; say so instead of doing nothing.
											const opened = await aoBridge.multicaAwareness.openIssue({ serverKey: card.serverKey, workspaceSlug: card.workspaceSlug, identifier: card.identifier }).catch(() => false);
											setOpenFailedKey(opened ? null : card.key);
										}}
									>
										<ExternalLink className="size-3" aria-hidden="true" />
										{t("multica.awareness.card.open")}
									</button>
									{card.sessions[0] ? (
										<button
											type="button"
											className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
											onClick={() => void navigate(sessionNavigateTarget(card.sessions[0].projectId, card.sessions[0].id))}
										>
											{t("multica.awareness.card.openSession")}
										</button>
									) : null}
								</div>
								{openFailedKey === card.key ? (
									<p role="alert" className="text-caption leading-4 text-error">
										{t("multica.awareness.openFailed")}
									</p>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			<MulticaWhoDialog open={whoOpen} onOpenChange={setWhoOpen} />
		</section>
	);
}
