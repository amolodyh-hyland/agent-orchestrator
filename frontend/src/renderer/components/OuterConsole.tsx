import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOuterView } from "../hooks/useOuter";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { apiClient } from "../lib/api-client";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { OuterNativeButton } from "./OuterNativeButton";
import { AgentModelField } from "./settings/ProjectAgentRoleControls";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import type { ApprovalMode } from "../types/conversation";

export function OuterConsole() {
	const { t } = useTranslation();
	const view = useOuterView();
	const binding = view.data?.binding;
	const workspace = useWorkspaceQuery({ includeCloud: false });
	const availableProjects = (workspace.data ?? []).filter(
		(p) =>
			p.id !== STANDALONE_WORKSPACE_ID &&
			!p.hostId &&
			p.id !== binding?.anchorProjectId
	);
	const projects = [
		...availableProjects.map((p) => ({
			id: p.id,
			name: p.name,
			missing: false,
		})),
		...(binding?.projectIds ?? [])
			.filter((id) => !availableProjects.some((p) => p.id === id))
			.map((id) => ({
				id,
				name: t("outer.projectUnavailable"),
				missing: true,
			})),
	];
	const [ids, setIDs] = useState<string[]>([]);
	const [paused, setPaused] = useState(false);
	const [foreground, setForeground] = useState(true);
	const [model, setModel] = useState("");
	const [effort, setEffort] = useState("");
	const [permissions, setPermissions] = useState<ApprovalMode>("default");
	const [valid, setValid] = useState(true);
	const [status, setStatus] = useState("");
	const [after, setAfter] = useState(0);
	const [selectedSession, setSelectedSession] = useState("");
	const [selectedRequest, setSelectedRequest] = useState("");
	useEffect(() => {
		if (!binding) return;
		setIDs(binding.projectIds);
		setPaused(binding.paused);
		setForeground(binding.foregroundReserve);
	}, [binding?.revision]);
	useEffect(() => {
		const listener = () => {
			void view.refetch();
			void workspace.refetch();
		};
		window.addEventListener("ao:outer-changed", listener);
		return () => window.removeEventListener("ao:outer-changed", listener);
	}, [view.refetch, workspace.refetch]);
	const facts = useQueries({
		queries: (binding?.projectIds ?? []).flatMap((projectId) =>
			["reports", "sessions", "runs"].map((kind) => ({
				queryKey: ["outer-facts", binding?.revision, projectId, kind],
				queryFn: async () => {
					const { data, error } = await apiClient.GET(
						"/api/v1/outer/facts",
						{ params: { query: { projectId, kind, limit: 20 } } }
					);
					if (error) throw error;
					return data?.facts ?? [];
				},
				refetchInterval: 30_000,
			}))
		),
	});
	const audit = useQuery({
		queryKey: ["outer-audit", after],
		enabled: Boolean(binding),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/outer/audit", {
				params: { query: { after, limit: 100 } },
			});
			if (error) throw error;
			return data?.events ?? [];
		},
		refetchInterval: 10_000,
	});
	const result = (value: { ok: boolean }) => {
		setStatus(t(value.ok ? "outer.saved" : "outer.actionHeld"));
		void view.refetch();
	};
	const permissionLabels = {
		default: t("settings.project.permissionCodexDefault"),
		"accept-edits": t("settings.project.permissionCodexAcceptEdits"),
		auto: t("settings.project.permissionCodexAuto"),
		"bypass-permissions": t("settings.project.permissionCodexBypass"),
	};
	const sourceTime = (value: string) =>
		new Date(value).getFullYear() > 1970
			? new Date(value).toLocaleString()
			: t("cockpit.unknownTime");
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<header className="workspace-topbar-container center-panel-titlebar flex h-toolbar items-center justify-between gap-3 px-4">
				<h1 className="font-medium">{t("outer.title")}</h1>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						void view.refetch();
						void audit.refetch();
						for (const fact of facts) void fact.refetch();
					}}
				>
					{t("cockpit.refresh")}
				</Button>
			</header>
			<main className="min-h-0 flex-1 space-y-6 overflow-auto p-5 text-sm">
				<p className="max-w-3xl text-muted-foreground">
					{t("outer.help")}
				</p>
				{view.isError ? (
					<p role="alert">{t("outer.actionHeld")}</p>
				) : null}
				{!binding ? (
					<section className="max-w-xl space-y-3">
						<h2 className="font-medium">{t("outer.setup")}</h2>
						<AgentModelField
							role="orchestrator"
							agentId="codex"
							projectId=""
							model={model}
							mode=""
							effort={effort}
							onModelChange={setModel}
							onModeChange={() => undefined}
							onEffortChange={setEffort}
							onValidityChange={setValid}
						/>
						<SettingsOptionMenu
							aria-label={t("outer.permissions")}
							value={permissions}
							options={Object.entries(permissionLabels).map(
								([value, label]) => ({ value, label })
							)}
							onChange={(value) =>
								setPermissions(value as ApprovalMode)
							}
						/>
						<OuterNativeButton
							disabled={view.isPending || !valid}
							draft={{
								operation: "setup",
								config: { model, effort, permissions },
							}}
							onResult={result}
						>
							{t("outer.setup")}
						</OuterNativeButton>
					</section>
				) : (
					<>
						<section className="space-y-2">
							<h2 className="font-medium">
								{t("outer.conversation")}
							</h2>
							<p className="break-all text-xs text-muted-foreground">
								{binding.anchorProjectId} / {binding.sessionId}
							</p>
							<p>
								{t("outer.settingsSummary", {
									harness: view.data?.session?.harness,
									model:
										view.data?.session?.settings.model ||
										t("settings.harness.models.default"),
									effort:
										view.data?.session?.settings
											.reasoningEffort ||
										t("settings.harness.models.default"),
									permissions:
										permissionLabels[
											(view.data?.session?.settings
												.approvalMode ||
												view.data?.session
													?.permissions ||
												"default") as ApprovalMode
										],
								})}
							</p>
							{binding.historyHeld ? (
								<>
									<p>{t("outer.historyHeld")}</p>
									<OuterNativeButton
										draft={{
											operation: "setup",
											config: {},
										}}
										onResult={result}
									>
										{t("outer.fresh")}
									</OuterNativeButton>
								</>
							) : binding.sessionId ? (
								<Link
									to="/projects/$projectId/sessions/$sessionId"
									params={{
										projectId: binding.anchorProjectId,
										sessionId: binding.sessionId,
									}}
								>
									{t("outer.openChat")}
								</Link>
							) : null}
							{binding.sessionId && !binding.historyHeld ? (
								<OuterNativeButton
									variant="outline"
									size="sm"
									draft={{
										operation: "control",
										control: {
											action: "session.resume",
											targetId: binding.sessionId,
											body: {},
										},
									}}
									onResult={result}
								>
									{t("outer.resume")}
								</OuterNativeButton>
							) : null}
						</section>
						<section className="space-y-3">
							<h2 className="font-medium">{t("outer.scope")}</h2>
							<p className="text-muted-foreground">
								{t("outer.scopeHelp")}
							</p>
							{projects.map((p) => (
								<label
									key={p.id}
									className="flex items-center gap-2"
								>
									<Checkbox
										aria-label={`${p.name} ${p.id}`}
										checked={ids.includes(p.id)}
										disabled={
											p.missing && !ids.includes(p.id)
										}
										onCheckedChange={(checked) =>
											setIDs(
												checked
													? [...ids, p.id]
													: ids.filter(
															(id) => id !== p.id
													  )
											)
										}
									/>
									<span>{p.name}</span>
									<code className="text-xs text-muted-foreground">
										{p.id}
									</code>
								</label>
							))}
							<label className="flex items-center gap-2">
								<Checkbox
									checked={paused}
									onCheckedChange={(v) =>
										setPaused(v === true)
									}
								/>
								{t("outer.pause")}
							</label>
							<label className="flex items-center gap-2">
								<Checkbox
									checked={foreground}
									onCheckedChange={(v) =>
										setForeground(v === true)
									}
								/>
								{t("outer.foreground")}
							</label>
							<OuterNativeButton
								draft={{
									operation: "scope",
									revision: binding.revision,
									projectIds: ids,
									paused,
									foregroundReserve: foreground,
								}}
								onResult={result}
							>
								{t("outer.saveScope")}
							</OuterNativeButton>
						</section>
						<section className="space-y-3">
							<h2 className="font-medium">{t("outer.facts")}</h2>
							{facts.map((query, index) => (
								<div key={index}>
									{query.isError ? (
										<p>{t("outer.sourceHeld")}</p>
									) : (
										query.data?.map((f) => (
											<article
												key={`${f.source.projectId}:${f.source.kind}:${f.source.id}`}
												className="border-b border-border py-2"
											>
												<p className="font-medium">
													{f.source.label} ·{" "}
													{f.source.projectId} ·{" "}
													{f.source.kind} ·{" "}
													{f.source.id}
												</p>
												<p className="whitespace-pre-wrap">
													{f.summary}
												</p>
												<p>{f.state}</p>
												<p className="break-all text-xs text-muted-foreground">
													{f.source.digest} ·{" "}
													{sourceTime(
														f.source.sourceAt
													)}{" "}
													·{" "}
													{sourceTime(
														f.source.observedAt
													)}{" "}
													·{" "}
													{f.source.sources.join(
														", "
													)}
													{f.source.unknown
														? ` · ${t(
																"outer.unknown"
														  )}`
														: ""}
												</p>
												{f.callerState ? (
													<p className="text-xs">
														{t(
															f.callerState ===
																"scoped"
																? "outer.scoped"
																: "outer.rebindNeeded"
														)}
													</p>
												) : null}
												{f.source.kind ===
												"sessions" ? (
													<div className="flex gap-2 pt-1">
														<Button
															size="sm"
															variant="ghost"
															onClick={() =>
																setSelectedSession(
																	f.source.id
																)
															}
														>
															{t(
																"outer.sessionControls"
															)}
														</Button>
														{selectedSession ===
														f.source.id ? (
															<>
																<OuterNativeButton
																	size="sm"
																	variant="outline"
																	draft={{
																		operation:
																			"control",
																		control:
																			{
																				action: "session.kill",
																				targetId:
																					f
																						.source
																						.id,
																				body: {},
																			},
																	}}
																	onResult={
																		result
																	}
																>
																	{t(
																		"outer.stopSession"
																	)}
																</OuterNativeButton>
																<OuterNativeButton
																	size="sm"
																	variant="outline"
																	draft={{
																		operation:
																			"control",
																		control:
																			{
																				action: "session.resume",
																				targetId:
																					f
																						.source
																						.id,
																				body: {},
																			},
																	}}
																	onResult={
																		result
																	}
																>
																	{t(
																		"outer.resumeSession"
																	)}
																</OuterNativeButton>
															</>
														) : null}
													</div>
												) : null}
											</article>
										))
									)}
								</div>
							))}
						</section>
						<section>
							<h2 className="mb-2 font-medium">
								{t("outer.receipts")}
							</h2>
							{view.data?.requests.map((r) => (
								<div key={r.id} className="py-1">
									<p className="break-all text-xs">
										{r.id} · {r.state} · {r.turnId} ·{" "}
										{r.providerTurnId}
									</p>
									<p className="text-xs text-muted-foreground">
										{r.sources
											.map(
												(s) =>
													`${
														s.label ||
														s.projectId ||
														t("outer.unknown")
													} [${s.sources.join(", ")}${
														s.unknown
															? ` · ${t(
																	"outer.unknown"
															  )}`
															: ""
													}]`
											)
											.join("; ")}
									</p>
									{(r.state === "ao_queued" || r.state === "held") && r.sessionId === binding.sessionId && !binding.historyHeld && r.turnId ? (
										<>
											{selectedRequest === r.id ? (
												<OuterNativeButton
													size="sm"
													variant="ghost"
													draft={{
														operation: "control",
														control: {
															action: "chat.cancel",
															targetId:
																r.sessionId,
															pendingId: r.turnId,
															body: {},
														},
													}}
													onResult={result}
												>
													{t("outer.cancelQueued")}
												</OuterNativeButton>
											) : (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														setSelectedRequest(r.id)
													}
												>
													{t("outer.requestControls")}
												</Button>
											)}
										</>
									) : null}
								</div>
							))}
						</section>
						<section>
							<h2 className="mb-2 font-medium">
								{t("outer.capacity")}
							</h2>
							{view.data?.capacity ? (
								<>
									<p>
										{t(
											"outer.capacitySummary",
											view.data.capacity
										)}
									</p>
									<p>
										{t(
											"outer.capacityBackground",
											view.data.capacity
										)}
									</p>
									{view.data.capacity.overage ? (
										<p role="status">
											{t("outer.capacityOverage")}
										</p>
									) : null}
									{view.data.capacity.unknown > 0 ? (
										<p role="status">
											{t("outer.capacityUnknown")}
										</p>
									) : null}
								</>
							) : null}
							{view.data?.reservations.map((r) => (
								<p
									key={r.requestId}
									className="break-all py-1 text-xs"
								>
									{r.requestId} · {r.sessionId} ·{" "}
									{sourceTime(r.reservedAt)} ·{" "}
									{t(
										r.foreground
											? "outer.foregroundReservation"
											: "outer.backgroundReservation"
									)}
								</p>
							))}
						</section>
						<section>
							<h2 className="mb-2 font-medium">
								{t("outer.incoming")}
							</h2>
							{view.data?.incoming.map((e) => (
								<details key={e.id} className="py-1">
									<summary>
										{e.source.projectId ||
											t("outer.unknown")}{" "}
										· {e.id} · {t("outer.inert")}
										{e.source.unknown ? ` · ${t("outer.unknown")}` : ""}
									</summary>
									<pre className="whitespace-pre-wrap text-xs">
										{e.content}
									</pre>
								</details>
							))}
						</section>
						<section>
							<h2 className="mb-2 font-medium">
								{t("outer.audit")}
							</h2>
							{audit.data?.map((e) => (
								<p
									key={e.id}
									className="break-all py-1 text-xs"
								>
									{e.sequence} · {e.at} · {e.operation} ·{" "}
									{e.state} · {e.requestId} · {e.projectId} ·{" "}
									{e.reason}
								</p>
							))}
							<div className="mt-2 flex gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={after === 0}
									onClick={() => setAfter(0)}
								>
									{t("outer.firstEvents")}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={(audit.data?.length ?? 0) < 100}
									onClick={() =>
										setAfter(
											audit.data?.at(-1)?.sequence ??
												after
										)
									}
								>
									{t("outer.nextEvents")}
								</Button>
							</div>
						</section>
					</>
				)}
				{status ? <p role="status">{status}</p> : null}
				<p className="max-w-3xl text-xs text-muted-foreground">
					{t("outer.limitations")}
				</p>
			</main>
		</div>
	);
}
