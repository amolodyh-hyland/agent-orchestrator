import type { components } from "../../api/schema";
import { multicaIssuePath } from "../../shared/multica-issue-links";
import { buildSendToAoPrompt, sendToAoDisplayName, type MulticaSendIssue } from "../../shared/multica-send-to-ao";
import { apiClient, apiErrorMessage } from "./api-client";
import { useMulticaLinksStore } from "../stores/multica-links-store";

export type CreateMulticaIssueSessionInput = {
	issue: MulticaSendIssue;
	projectId: string;
	harness?: string;
	/** Localized text used when the API gives no message. */
	fallbackMessage: string;
};

export type CreateMulticaIssueSessionResult =
	| { ok: true; sessionId: string; projectId: string; linked: boolean }
	| { ok: false; message: string };

export type CreateMulticaIssueSessionDeps = {
	post: (body: { projectId: string; kind: "worker"; prompt: string; displayName: string; harness?: string }) => Promise<{ session?: { id?: string; projectId?: string } | null; error?: unknown }>;
	addLink: (input: { sessionId: string; projectId: string; issue: string }) => Promise<{ ok: boolean }>;
};

async function postSession(
	body: Parameters<CreateMulticaIssueSessionDeps["post"]>[0],
): ReturnType<CreateMulticaIssueSessionDeps["post"]> {
	const { data, error } = await apiClient.POST("/api/v1/sessions", {
		body: {
			projectId: body.projectId,
			kind: body.kind,
			prompt: body.prompt,
			displayName: body.displayName,
			...(body.harness
				? { harness: body.harness as components["schemas"]["SpawnSessionRequest"]["harness"] }
				: {}),
		},
	});
	return { session: data?.session, error };
}

async function addIssueLink(input: Parameters<CreateMulticaIssueSessionDeps["addLink"]>[0]): Promise<{ ok: boolean }> {
	return useMulticaLinksStore.getState().add(input);
}

export async function createMulticaIssueSession(
	input: CreateMulticaIssueSessionInput,
	deps: Partial<CreateMulticaIssueSessionDeps> = {},
): Promise<CreateMulticaIssueSessionResult> {
	const post = deps.post ?? postSession;
	const addLink = deps.addLink ?? addIssueLink;
	const { session, error } = await post({
		projectId: input.projectId,
		kind: "worker",
		prompt: buildSendToAoPrompt(input.issue),
		displayName: sendToAoDisplayName(input.issue),
		...(typeof input.harness === "string" && input.harness.length > 0 ? { harness: input.harness } : {}),
	});

	if (error) return { ok: false, message: apiErrorMessage(error, input.fallbackMessage) };
	if (!session?.id) return { ok: false, message: input.fallbackMessage };

	const projectId = session.projectId ?? input.projectId;
	let linked = false;
	try {
		const result = await addLink({
			sessionId: session.id,
			projectId,
			issue: multicaIssuePath({
				workspaceSlug: input.issue.workspaceSlug,
				issueIdentifier: input.issue.issueIdentifier,
			}).slice(1),
		});
		linked = result.ok;
	} catch {
		linked = false;
	}

	return { ok: true, sessionId: session.id, projectId, linked };
}
