import { RunMonitoring } from "./RunMonitoring";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { hidesShellTopbar } from "../lib/platform";
import { getSessionStatusView } from "../lib/session-presentation";
import { apiClient } from "../lib/api-client";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { topbarProjectLabelClass } from "./TopbarButton";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export const COCKPIT_SELECTION_KEY = "ao.cockpit.project-ids";
const STALE_AFTER_MS = 15 * 60 * 1000;

function savedSelection(): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(COCKPIT_SELECTION_KEY) ?? "[]");
		return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
	} catch {
		return [];
	}
}

export function ProjectCockpit() {
	const { t } = useTranslation();
	const workspaceQuery = useWorkspaceQuery({ includeCloud: false });
	const [selected, setSelected] = useState(savedSelection);
	const [now, setNow] = useState(Date.now);
	const projects = (workspaceQuery.data ?? []).filter((project) => project.id !== STANDALONE_WORKSPACE_ID && !project.hostId);
	const visible = selected.map((id) => ({ id, project: projects.find((project) => project.id === id) }));
	const reports = useQueries({
		queries: visible.map(({ id, project }) => ({
			queryKey: ["cockpit-reports", id],
			enabled: Boolean(project) && !workspaceQuery.isError,
			queryFn: async ({ signal }: { signal: AbortSignal }) => {
				const { data, error } = await apiClient.GET("/api/v1/reports", { params: { query: { projectId: id } }, signal });
				if (error) throw error;
				return (data?.reports ?? []).filter((report) => report.projectId === id);
			},
			staleTime: 15_000,
		})),
	});

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	function select(next: string[]) {
		setSelected(next);
		try { localStorage.setItem(COCKPIT_SELECTION_KEY, JSON.stringify(next)); } catch {}
	}

	function timestamp(value?: string | number) {
		const time = value === undefined ? NaN : new Date(value).getTime();
		if (!Number.isFinite(time) || time <= 0) return t("cockpit.unknownTime");
		return t("cockpit.timestamp", { time: new Date(time).toLocaleString(), age: Math.max(0, Math.floor((now - time) / 60_000)) });
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<header className="workspace-topbar-container center-panel-titlebar flex h-toolbar shrink-0 items-center justify-between gap-3 pr-4">
				<h1 className={hidesShellTopbar() ? topbarProjectLabelClass : "sr-only"}>{t("cockpit.title")}</h1>
				<Button variant="ghost" size="sm" className="ml-auto" disabled={workspaceQuery.isFetching || reports.some((query) => query.isFetching)} onClick={() => {
					void workspaceQuery.refetch();
					for (const [index, query] of reports.entries()) if (visible[index].project) void query.refetch();
					setNow(Date.now());
				}}>{t("cockpit.refresh")}</Button>
			</header>
			<main className="min-h-0 flex-1 overflow-auto p-4 text-sm">
				<p className="mb-4 text-muted-foreground">{t("cockpit.readOnly")}</p>
				<fieldset className="mb-4">
					<legend className="mb-2 font-medium">{t("cockpit.selectProjects")}</legend>
					<div className="divide-y divide-border rounded-md bg-card">
						{projects.map((project) => <label key={project.id} className="flex min-h-9 items-center gap-2 px-3 py-2">
							<Checkbox aria-label={`${project.name} ${project.id}`} checked={selected.includes(project.id)} onCheckedChange={(checked) => select(checked === true ? [...selected, project.id] : selected.filter((id) => id !== project.id))} />
							<span className="min-w-0 break-words">{project.name}</span>
							<span className="break-all text-xs text-muted-foreground">{project.id}</span>
						</label>)}
					</div>
				</fieldset>
				{workspaceQuery.isPending ? <p role="status">{t("cockpit.loading")}</p> : null}
				{workspaceQuery.isError ? <p role="alert" className="text-destructive">{t("cockpit.factsError")}</p> : null}
				{!selected.length ? <p className="text-muted-foreground">{t("cockpit.empty")}</p> : null}
				<div className="divide-y divide-border">
					{visible.map(({ id, project }, index) => {
						const query = reports[index];
						if (!project) return <section key={id} className="py-4" aria-label={id}>
							<h2 className="break-all font-medium">{id}</h2>
							<p>{workspaceQuery.isPending ? t("cockpit.loading") : t("cockpit.projectUnavailable")}</p>
							<Button variant="ghost" size="sm" onClick={() => select(selected.filter((value) => value !== id))}>{t("cockpit.remove")}</Button>
						</section>;
						const coordinators = project.sessions.filter((session) => session.kind === "orchestrator" && !session.isTerminated);
						const stale = coordinators.some((session) => session.statusReadiness !== "ready" || session.status === "no_signal" || session.status === "exited" || !Number.isFinite(Date.parse(session.updatedAt)) || now - Date.parse(session.updatedAt) > STALE_AFTER_MS);
						return <section key={id} aria-label={project.name} className="space-y-3 py-4">
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<h2 className="min-w-0 break-words font-medium">{project.name}</h2>
								<Link className="text-muted-foreground underline hover:text-foreground" to="/projects/$projectId" params={{ projectId: id }} search={{ observation: true }} preload={false}>{t("cockpit.projectBoard")}</Link>
							</div>
							<p className="break-all text-xs text-muted-foreground">{id}</p>
							<p className="text-xs text-muted-foreground">{t("cockpit.observed", { timestamp: timestamp(workspaceQuery.dataUpdatedAt) })}</p>
							{!coordinators.length ? <p>{t("cockpit.missingCoordinator")}</p> : stale ? <p>{t("cockpit.staleCoordinator")}</p> : null}
							{coordinators.length > 1 ? <p>{t("cockpit.multipleCoordinators")}</p> : null}
							<h3 className="font-medium">{t("cockpit.sessions")}</h3>
							{!project.sessions.length ? <p className="text-muted-foreground">{t("cockpit.noSessions")}</p> : <ul className="divide-y divide-border">
								{project.sessions.map((session) => <li key={session.id} className="space-y-1 py-2">
									<p className="break-words">{session.title} <span className="text-xs text-muted-foreground">{session.id}</span></p>
									<p>{session.kind === "orchestrator" ? t("cockpit.coordinator") : t("cockpit.worker")} · {session.isTerminated ? t("cockpit.archived") : session.statusReadiness !== "ready" ? t("cockpit.unknownState") : t("cockpit.observedState", { state: getSessionStatusView(session.status, t).label })}</p>
									<p className="text-xs text-muted-foreground">{t("cockpit.sourceUpdated", { timestamp: timestamp(session.updatedAt) })}</p>
								</li>)}
							</ul>}
							<RunMonitoring projectId={id} />
							<h3 className="font-medium">{t("cockpit.reports")}</h3>
							<p className="text-xs text-muted-foreground">{t("cockpit.claimsOnly")}</p>
							{query.isPending ? <p role="status">{t("cockpit.loading")}</p> : null}
							{query.isError ? <p role="alert" className="text-destructive">{t("cockpit.reportsError")}</p> : null}
							{query.data ? <>
								<p className="text-xs text-muted-foreground">{t("cockpit.observed", { timestamp: timestamp(query.dataUpdatedAt) })}</p>
								{!query.data.length ? <p className="text-muted-foreground">{t("cockpit.noReports")}</p> : <ul className="divide-y divide-border">
									{[...query.data].reverse().map((report) => <ReportRow key={report.id} report={report} timestamp={timestamp(report.createdAt)} />)}
								</ul>}
							</> : null}
						</section>;
					})}
				</div>
				<p className="mt-4 text-xs text-muted-foreground">{t("factoryMonitor.receiptHelp", { defaultValue: "Native receipts appear on linked runs. Recorded or queued feedback does not prove native acceptance or completion." })}</p>
			</main>
		</div>
	);
}

function ReportRow({ report, timestamp }: { report: components["schemas"]["ReportResponse"]; timestamp: string }) {
	const { t } = useTranslation();
	return <li className="space-y-1 py-2">
		<p className="break-all text-xs text-muted-foreground">{report.id} · {report.sessionId}</p>
		<p>{t("cockpit.reportedState", { state: report.state || t("cockpit.unknownState") })}</p>
		{report.note ? <p className="whitespace-pre-wrap break-words">{report.note}</p> : null}
		{report.message ? <p className="whitespace-pre-wrap break-words">{report.message}</p> : null}
		{report.outputs?.map((output, index) => <p key={index} className="break-all text-xs text-muted-foreground">{output.label} {output.reference}</p>)}
		<p className="text-xs text-muted-foreground">{t("cockpit.recorded", { timestamp })}</p>
	</li>;
}
