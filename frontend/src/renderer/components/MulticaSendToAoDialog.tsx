import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MulticaSendRequest } from "../../shared/multica-send-to-ao";
import { aoBridge } from "../lib/bridge";
import { createMulticaIssueSession } from "../lib/multica-send-to-ao";
import { useNavigateToSession } from "../lib/navigate-to-session";
import { getProjectLastOpenedAt } from "../lib/project-history";
import {
	buildRankedAgentOptions,
	DEFAULT_AGENT_PRIORITY_RANK,
	isLaunchableAgent,
} from "../lib/agent-select-options";
import { useAgentReadinessQuery } from "../hooks/useAgentReadinessQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { CLOUD_PROJECT_KIND, sessionIsActive, STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type ReceivedRequest = { id: number; request: MulticaSendRequest };
type SessionTarget = { projectId: string; sessionId: string };
const PROJECT_DEFAULT_AGENT = "__project_default__";

function failureMessage(reason: Extract<MulticaSendRequest, { ok: false }>["reason"]):
	| "multica.send.error.signedOut"
	| "multica.send.error.noIssue"
	| "multica.send.error.unreadable" {
	switch (reason) {
		case "signed_out":
			return "multica.send.error.signedOut";
		case "no_issue":
			return "multica.send.error.noIssue";
		case "unreadable":
			return "multica.send.error.unreadable";
	}
}

export function MulticaSendToAoDialog() {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const navigateToSession = useNavigateToSession();
	const workspacesQuery = useWorkspaceQuery();
	const readinessQuery = useAgentReadinessQuery();
	const links = useMulticaLinksStore((state) => state.links);
	const [received, setReceived] = useState<ReceivedRequest | null>(null);
	const [open, setOpen] = useState(false);
	const [projectId, setProjectId] = useState("");
	const [agent, setAgent] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [unlinkedSession, setUnlinkedSession] = useState<SessionTarget | null>(null);
	const mounted = useRef(true);
	const requestId = useRef(0);
	const inFlight = useRef(false);
	const pendingRequest = useRef<MulticaSendRequest | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const applyRequest = (request: MulticaSendRequest) => {
		requestId.current += 1;
		setReceived({ id: requestId.current, request });
		setProjectId(request.ok && request.projectId ? request.projectId : "");
		setAgent("");
		setSubmitting(false);
		setError(null);
		setUnlinkedSession(null);
		setOpen(true);
	};

	useEffect(() => aoBridge.multicaSend.onRequest((request) => {
		if (inFlight.current) {
			pendingRequest.current = request;
			return;
		}
		pendingRequest.current = null;
		applyRequest(request);
	}), []);

	const projects = useMemo(
		() => (workspacesQuery.data ?? []).filter((workspace) =>
			workspace.id !== STANDALONE_WORKSPACE_ID && workspace.kind !== CLOUD_PROJECT_KIND,
		),
		[workspacesQuery.data],
	);

	useEffect(() => {
		if (!received?.request.ok || projects.length === 0) return;
		if (projectId && projects.some((project) => project.id === projectId)) return;
		let mostRecent: string | undefined;
		let mostRecentAt = Number.NEGATIVE_INFINITY;
		for (const project of projects) {
			const lastOpenedAt = getProjectLastOpenedAt(project.id);
			const timestamp = lastOpenedAt ? Date.parse(lastOpenedAt) : Number.NaN;
			if (Number.isFinite(timestamp) && timestamp > mostRecentAt) {
				mostRecent = project.id;
				mostRecentAt = timestamp;
			}
		}
		setProjectId(mostRecent ?? projects[0].id);
	}, [received, projects, projectId]);

	const agents = useMemo(
		() => buildRankedAgentOptions({
			agents: readinessQuery.data?.agents,
			priorityRank: DEFAULT_AGENT_PRIORITY_RANK,
			fallbackAgents: [],
		}).filter(isLaunchableAgent),
		[readinessQuery.data],
	);

	const issue = received?.request.ok ? received.request.issue : null;
	const duplicateSessions = useMemo(() => {
		if (!issue) return [];
		return links.flatMap((link) => {
			if (link.workspaceSlug !== issue.workspaceSlug || link.issueIdentifier !== issue.issueIdentifier) return [];
			const workspace = projects.find((candidate) => candidate.id === link.projectId);
			const session = workspace?.sessions.find((candidate) => candidate.id === link.sessionId);
			return session && session.status !== "unknown" && sessionIsActive(session)
				? [{ projectId: workspace!.id, sessionId: session.id, projectName: workspace!.name, sessionTitle: session.title }]
				: [];
		});
	}, [issue, links, projects]);

	const close = () => {
		const nextRequest = pendingRequest.current;
		pendingRequest.current = null;
		if (nextRequest) {
			applyRequest(nextRequest);
		} else {
			setOpen(false);
		}
	};

	const openSession = (target: SessionTarget) => {
		navigateToSession(target.projectId, target.sessionId);
		close();
	};

	const submit = async () => {
		if (!issue || !projectId || inFlight.current) return;
		const activeRequestId = received?.id;
		inFlight.current = true;
		setSubmitting(true);
		setError(null);
		setUnlinkedSession(null);
		try {
			const result = await createMulticaIssueSession({
				issue,
				projectId,
				harness: agent || undefined,
				fallbackMessage: t("multica.send.createFailed"),
			});
			if (!mounted.current) return;
			if (activeRequestId === requestId.current) {
				if (!result.ok) {
					setError(result.message);
				} else if (!result.linked) {
					setUnlinkedSession({ projectId: result.projectId, sessionId: result.sessionId });
				} else {
					await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					if (mounted.current && activeRequestId === requestId.current) {
						navigateToSession(result.projectId, result.sessionId);
						close();
					}
				}
			}
		} catch {
			if (mounted.current && activeRequestId === requestId.current) setError(t("multica.send.createFailed"));
		} finally {
			inFlight.current = false;
			if (mounted.current) setSubmitting(false);
		}
	};

	if (!received) return null;

	return (
		<Dialog.Root open={open} onOpenChange={(nextOpen) => {
			if (nextOpen) {
				setOpen(true);
			} else if (!inFlight.current) {
				close();
			}
		}}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
					<Dialog.Title className="settings-dialog-title px-4 pt-3">{t("multica.send.title")}</Dialog.Title>
					{received.request.ok ? (
						<>
							<Dialog.Description className="sr-only">{t("multica.send.description")}</Dialog.Description>
							<div className="space-y-4 px-4 py-3">
								<div className="space-y-1">
									<p className="text-sm font-medium">{issue?.issueIdentifier}</p>
									<p className="text-sm text-muted-foreground">{issue?.title}</p>
								</div>
								{projects.length === 0 ? <p className="text-sm text-muted-foreground">{t("multica.send.noProjects")}</p> : null}
								<div className="space-y-2">
									<Label htmlFor="multica-send-project">{t("multica.send.project")}</Label>
									<Select disabled={projects.length === 0} onValueChange={setProjectId} value={projectId}>
										<SelectTrigger aria-required="true" className="w-full" id="multica-send-project">
											<SelectValue placeholder={t("multica.send.projectPlaceholder")} />
										</SelectTrigger>
										<SelectContent>
											{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="multica-send-agent">{t("multica.send.agent")}</Label>
									<Select onValueChange={(value) => setAgent(value === PROJECT_DEFAULT_AGENT ? "" : value)} value={agent || PROJECT_DEFAULT_AGENT}>
										<SelectTrigger className="w-full" id="multica-send-agent">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={PROJECT_DEFAULT_AGENT}>{t("multica.send.agentDefault")}</SelectItem>
											{agents.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
										</SelectContent>
									</Select>
								</div>
								{duplicateSessions.length > 0 ? (
									<div className="space-y-2">
										<p className="text-sm font-medium">{t("multica.send.alreadySent")}</p>
										<ul className="space-y-1">
											{duplicateSessions.map((duplicate) => (
												<li className="flex items-center justify-between gap-2 text-sm" key={`${duplicate.projectId}-${duplicate.sessionId}`}>
													<span className="min-w-0 truncate text-muted-foreground">{duplicate.projectName}: {duplicate.sessionTitle}</span>
										<Button disabled={submitting} onClick={() => openSession(duplicate)} size="sm" variant="secondary">{t("multica.send.open")}</Button>
												</li>
											))}
										</ul>
									</div>
								) : null}
								{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
								{unlinkedSession ? <p className="text-sm text-destructive" role="alert">{t("multica.send.linkFailed")}</p> : null}
							</div>
							<div className="flex justify-end gap-2 border-t border-border px-4 py-3">
								<Button disabled={submitting} onClick={close} variant="secondary">{t("multica.send.cancel")}</Button>
								{unlinkedSession ? (
									<Button disabled={submitting} onClick={() => openSession(unlinkedSession)}>{t("multica.send.openSession")}</Button>
								) : (
									<Button disabled={projects.length === 0 || !projectId || submitting} onClick={() => void submit()}>
										{submitting ? t("multica.send.creating") : t(duplicateSessions.length > 0 ? "multica.send.sendAnyway" : "multica.send.create")}
									</Button>
								)}
							</div>
						</>
					) : (
						<>
							<p className="px-4 py-3 text-sm text-destructive" role="alert">{t(failureMessage(received.request.reason))}</p>
							<div className="flex justify-end border-t border-border px-4 py-3">
								<Button onClick={close} variant="secondary">{t("multica.send.close")}</Button>
							</div>
						</>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
