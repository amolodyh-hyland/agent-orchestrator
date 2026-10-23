import type { components } from "../../api/schema";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiClient } from "../lib/api-client";
import { Button } from "./ui/button";

export function RunMonitoring({ projectId, runId, sessionId }: { projectId?: string; runId?: string; sessionId?: string }) {
	const { t } = useTranslation();
	const copy = (key: string, fallback: string) => t(`factoryMonitor.${key}`, { defaultValue: fallback });
	const query = useQuery({
		queryKey: ["run-monitoring", projectId, runId, sessionId],
		queryFn: async ({ signal }) => {
			const rows: components["schemas"]["RunMonitoring"][] = [];
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			let afterId: string | undefined;
			const seen = new Set<string>();
			do {
				const { data, error } = await apiClient.GET("/api/v1/runs/monitoring", { params: { query: { projectId, afterId, limit: 100 } }, signal: bounded });
				if (error) throw error;
				rows.push(...(data?.runs ?? []));
				afterId = data?.nextCursor;
				if (afterId && seen.has(afterId)) throw new Error("repeated_monitor_cursor");
				if (afterId) seen.add(afterId);
			} while (afterId);
			return rows.filter((row) => (!projectId || row.projectId === projectId) && (!runId || row.runId === runId) && (!sessionId || row.sessionId === sessionId || row.participants.some((p) => p.sessionId === sessionId)));
		},
		refetchInterval: 30_000,
	});
	return <section className="space-y-2" aria-label={copy("title", "Run monitoring")}>
		<div className="flex items-center justify-between gap-2"><h3 className="font-medium">{copy("title", "Run monitoring")}</h3><Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{copy("refresh", "Request status")}</Button></div>
		<p className="text-xs text-muted-foreground">{copy("passive", "Display only. Status requests start no work. Idle retains ownership and never proves completion or death.")}</p>
		{query.isPending ? <p role="status">{copy("loading", "Reading run references…")}</p> : null}
		{query.isError ? <p role="alert">{copy("error", "Observation unavailable. Retain work in progress; refresh to reconcile.")}</p> : null}
		{query.data?.map((row) => <div key={row.runId} className="space-y-1 border-t border-border py-2">
			<p className="break-all">{row.runId} · {row.stage} · {copy("progress", "In progress")}</p>
			<p>{copy("owner", "Next owner")}: {row.config.nextOwner || copy("unknown", "Unknown — human decision required")}</p>
			<p className="text-xs text-muted-foreground">{copy("observed", "Observed")}: {Date.parse(row.observedAt) > 0 ? new Date(row.observedAt).toLocaleString() : copy("unobserved", "Not observed yet")} · {query.isError ? copy("unavailable", "Unavailable") : row.freshness} · {Math.max(0, Math.floor((Date.now() - (Date.parse(row.observedAt) > 0 ? Date.parse(row.observedAt) : Date.now())) / 60_000))} {copy("minutesOld", "min old")}</p>
			<p className="text-xs text-muted-foreground">{copy("activity", "Last activity")}: {Date.parse(row.lastActivityAt) > 0 ? new Date(row.lastActivityAt).toLocaleString() : copy("unknownTime", "Unknown")} · {copy("deadline", "Deadline")}: {Date.parse(row.deadline) > 0 ? new Date(row.deadline).toLocaleString() : copy("unknownTime", "Unknown")}</p>
			{row.attention ? <p role="status" className="text-warning">{copy("attention", "Needs attention")}: {row.attention.condition} · {row.attention.acknowledgedAt ? copy("acknowledged", "Display acknowledged; cause remains") : copy("unacknowledged", "Not acknowledged")}</p> : null}
			{row.reports.map((report) => <p key={report.id} className="break-all text-xs text-muted-foreground">{report.id} · {copy("delivery", "Report delivery")}: {report.deliveryState} · {copy("native", "Native receipt")}: {report.nativeReceipt}</p>)}
		</div>)}
	</section>;
}
