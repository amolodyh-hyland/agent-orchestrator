import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import type { MessageKey } from "../i18n/messages";
import { buildWhoView, type WhoRow } from "../lib/multica-who";
import { formatSince, toneDotClass } from "../lib/multica-awareness-format";
import { sessionNavigateTarget } from "../lib/navigate-to-session";
import { aoBridge } from "../lib/bridge";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useMulticaAwarenessStore } from "../stores/multica-awareness-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Switch } from "./ui/switch";
import type { MulticaWhoFlag } from "../../shared/multica-executor";

const executorKeys: Record<WhoRow["derivation"]["display"], MessageKey> = {
	ao: "multica.awareness.executor.ao",
	"multica-agent": "multica.awareness.executor.multica-agent",
	human: "multica.awareness.executor.human",
	contested: "multica.awareness.executor.contested",
	none: "multica.awareness.executor.none",
};

const flagKeys: Record<MulticaWhoFlag, MessageKey> = {
	contested: "multica.awareness.flag.contested",
	assigned_not_running: "multica.awareness.flag.assigned_not_running",
	parked: "multica.awareness.flag.parked",
	no_longer_yours: "multica.awareness.flag.no_longer_yours",
	orphaned: "multica.awareness.flag.orphaned",
};

const runKeys = {
	queued: "multica.awareness.run.queued",
	starting: "multica.awareness.run.starting",
	running: "multica.awareness.run.running",
	waiting_folder: "multica.awareness.run.waiting_folder",
	retrying: "multica.awareness.run.retrying",
	finished: "multica.awareness.run.finished",
	ended: "multica.awareness.run.ended",
	failed: "multica.awareness.run.failed",
	cancelled: "multica.awareness.run.cancelled",
} as const satisfies Record<string, MessageKey>;

/**
 * "Who is working on what": AO sessions and Multica runs joined by issue, with
 * the executor and the flags of the detection rules. Read-only: it offers no
 * action on an issue, only a way to open it or its session.
 */
export function MulticaWhoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const state = useMulticaAwarenessStore((store) => store.state);
	const workspaces = useWorkspaceQuery().data;
	const [now, setNow] = useState(() => Date.now());
	const [serverKey, setServerKey] = useState("");
	const [workspaceSlug, setWorkspaceSlug] = useState("");
	const [mineOnly, setMineOnly] = useState(false);

	useEffect(() => {
		if (open) setNow(Date.now());
	}, [open]);

	const sessions = useMemo(() => (workspaces ?? []).flatMap((workspace) => workspace.sessions), [workspaces]);
	const view = useMemo(() => buildWhoView({ state, links: state.links, sessions, nowMs: now }), [state, sessions, now]);
	const rows = view.rows.filter(
		(row) => (serverKey === "" || row.serverKey === serverKey) && (workspaceSlug === "" || row.workspaceSlug === workspaceSlug) && (!mineOnly || row.mine),
	);
	const slugs = [...new Set(view.rows.filter((row) => serverKey === "" || row.serverKey === serverKey).map((row) => row.workspaceSlug).filter(Boolean))];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[80vh] w-[min(900px,calc(100vw-24px))] overflow-y-auto p-5" data-testid="multica-who-dialog">
				<DialogTitle className="text-base font-semibold">{t("multica.awareness.who.title")}</DialogTitle>
				<DialogDescription className="text-xs text-muted-foreground">{t("multica.awareness.who.description")}</DialogDescription>
				<div className="flex flex-wrap items-center gap-3 pt-2 text-xs">
					<label className="flex items-center gap-1.5">
						{t("multica.awareness.who.server")}
						<select className="rounded border border-border bg-background px-1 py-0.5" value={serverKey} onChange={(event) => { setServerKey(event.target.value); setWorkspaceSlug(""); }}>
							<option value="">{t("multica.awareness.who.all")}</option>
							{state.servers.map((server) => (
								<option key={server.serverKey} value={server.serverKey}>
									{server.label}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5">
						{t("multica.awareness.who.workspace")}
						<select className="rounded border border-border bg-background px-1 py-0.5" value={workspaceSlug} onChange={(event) => setWorkspaceSlug(event.target.value)}>
							<option value="">{t("multica.awareness.who.all")}</option>
							{slugs.map((slug) => (
								<option key={slug} value={slug}>
									{slug}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-1.5">
						<Switch checked={mineOnly} onCheckedChange={setMineOnly} aria-label={t("multica.awareness.who.mine")} />
						{t("multica.awareness.who.mine")}
					</label>
				</div>
				{rows.length === 0 ? (
					<p className="pt-3 text-xs text-muted-foreground">{t("multica.awareness.who.empty")}</p>
				) : (
					<table className="mt-3 w-full text-left text-xs" data-testid="multica-who-table">
						<thead className="text-muted-foreground">
							<tr>
								<th className="py-1 pr-2 font-medium">{t("multica.awareness.who.col.issue")}</th>
								<th className="py-1 pr-2 font-medium">{t("multica.awareness.who.col.executor")}</th>
								<th className="py-1 pr-2 font-medium">{t("multica.awareness.who.col.who")}</th>
								<th className="py-1 pr-2 font-medium">{t("multica.awareness.who.col.state")}</th>
								<th className="py-1 pr-2 font-medium">{t("multica.awareness.who.col.since")}</th>
								<th className="py-1 font-medium">{t("multica.awareness.who.col.flags")}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key} className="border-t border-border align-top" data-executor={row.derivation.display}>
									<td className="py-1.5 pr-2">
										<button
											type="button"
											className="text-left text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
											aria-label={t("multica.links.open", { issue: row.identifier })}
											onClick={() => void aoBridge.multicaAwareness.openIssue({ serverKey: row.serverKey, workspaceSlug: row.workspaceSlug, identifier: row.identifier })}
										>
											{row.identifier}
										</button>
										<div className="max-w-56 truncate text-muted-foreground" title={row.title}>
											{row.title}
										</div>
										<div className="text-caption text-muted-foreground">{row.serverLabel}</div>
									</td>
									<td className="py-1.5 pr-2">{t(executorKeys[row.derivation.display])}</td>
									<td className="py-1.5 pr-2">
										{row.agentNames.map((name) => (
											<div key={name}>{name}</div>
										))}
										{row.sessions.map((session) => (
											<button
												key={session.id}
												type="button"
												className="block max-w-48 truncate text-left text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
												onClick={() => {
													onOpenChange(false);
													void navigate(sessionNavigateTarget(session.projectId, session.id));
												}}
											>
												{session.title || session.id}
											</button>
										))}
										{row.derivation.detail === "you" ? <div>{t("multica.awareness.who.you")}</div> : null}
										{row.derivation.detail === "other" ? <div>{t("multica.awareness.who.other")}</div> : null}
									</td>
									<td className="py-1.5 pr-2">
										{row.run ? (
											<span className="inline-flex items-center gap-1">
												<span className={`size-2 rounded-full ${toneDotClass[row.run.view.tone]}`} aria-hidden="true" />
												{t(runKeys[row.run.view.state])}
											</span>
										) : null}
									</td>
									<td className="py-1.5 pr-2 text-muted-foreground">{formatSince(row.run?.since ?? row.updatedAt, now, i18n.language)}</td>
									<td className="py-1.5">
										{row.flags.map((flag) => (
											<div key={flag}>{t(flagKeys[flag])}</div>
										))}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{view.unlinkedSessions.length > 0 ? (
					<div className="pt-4">
						<h3 className="text-xs font-medium text-muted-foreground">{t("multica.awareness.who.unlinked")}</h3>
						<ul className="pt-1 text-xs">
							{view.unlinkedSessions.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
										onClick={() => {
											onOpenChange(false);
											void navigate(sessionNavigateTarget(session.projectId, session.id));
										}}
									>
										{session.title || session.id}
									</button>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
