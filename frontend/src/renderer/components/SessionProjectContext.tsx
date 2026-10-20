import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../lib/api-client";
import { clientForSessionHost } from "../lib/host-clients";

export function SessionProjectContext({ sessionId, hostId }: { sessionId: string; hostId?: string }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const query = useQuery({
		queryKey: ["session-project-context", hostId ?? "local", sessionId],
		enabled: open,
		staleTime: Infinity,
		retry: false,
		queryFn: async () => {
			const { data, error } = await clientForSessionHost(hostId).GET("/api/v1/sessions/{sessionId}/project-context", { params: { path: { sessionId } } });
			if (error) throw new Error(apiErrorMessage(error));
			return data?.manifest ?? null;
		},
	});
	const manifest = query.data;
	return <details className="mt-3 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary className="cursor-pointer py-2 font-medium">{t("projectContext.sessionTitle")}</summary>
		{open && <div className="flex flex-col gap-2">
			{query.isLoading && <p>{t("settings.project.loading")}</p>}
			{query.error && <p role="alert" className="text-error">{query.error.message}</p>}
			{query.isSuccess && !manifest && <p className="text-settings-muted">{t("projectContext.noManifest")}</p>}
			{manifest && <>
				<p className="text-settings-muted">{t("projectContext.pinned", { project: manifest.projectId ?? "—", revision: manifest.projectRevision, role: manifest.role, created: manifest.createdAt })}</p>
				<code className="break-all text-xs">{manifest.digest}</code>
				{[manifest.sharedInstructions, manifest.roleInstructions, manifest.roleRules].filter(Boolean).map((text, index) => <pre key={index} className="whitespace-pre-wrap break-words font-sans">{text}</pre>)}
				{manifest.attachments?.map((entry) => <div key={entry.binding.id} className="flex flex-col gap-1 py-2">
					<span className="break-all font-medium">{entry.binding.id}</span>
					<span className="break-all text-xs text-settings-muted">{entry.binding.machineId ?? t("projectContext.portable")} · {t(entry.binding.required ? "projectContext.required" : "projectContext.optional")}</span>
					<span className={entry.availability === "unavailable" ? "text-error" : "text-settings-muted"}>{t(`projectContext.${entry.availability}`)}{entry.reason ? ` · ${entry.reason}` : ""}</span>
					<span className="break-all text-xs">{entry.binding.mediaType} · {t("projectContext.bytes", { count: entry.byteCount })} · {entry.sourceDigest}</span>
					{entry.content && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{entry.content}</pre>}
				</div>)}
			</>}
		</div>}
	</details>;
}
