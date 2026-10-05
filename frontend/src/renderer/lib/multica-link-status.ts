import type { TFunction } from "i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import {
	clampStatusText,
	MAX_STATUS_DETAIL,
	MAX_STATUS_ENTRIES,
	MAX_STATUS_LABEL,
	MAX_STATUS_SESSION_ID,
	type MulticaLinkStatusEntry,
	type MulticaStatusSnapshot,
	type MulticaStatusTone,
} from "../../shared/multica-session-status";
import { attentionZone, getSessionStatusView, type AttentionZone } from "./session-presentation";
import { primaryPR, type WorkspaceSession, type WorkspaceSummary } from "../types/workspace";

const toneByZone: Record<AttentionZone, MulticaStatusTone> = {
	merge: "ready",
	action: "attention",
	pending: "pending",
	working: "working",
	done: "done",
};

export function buildMulticaStatusSnapshot(input: {
	links: readonly MulticaIssueLink[];
	workspaces: readonly WorkspaceSummary[];
	stale: boolean;
	t: TFunction;
}): MulticaStatusSnapshot {
	const entries: MulticaLinkStatusEntry[] = [];
	const seenSessionIds = new Set<string>();

	for (const link of input.links) {
		if (entries.length >= MAX_STATUS_ENTRIES) break;
		if (!link.sessionId || link.sessionId.length > MAX_STATUS_SESSION_ID || seenSessionIds.has(link.sessionId)) continue;
		seenSessionIds.add(link.sessionId);

		const workspace = input.workspaces.find((candidate) => candidate.id === link.projectId);
		const session = workspace?.sessions.find((candidate) => candidate.id === link.sessionId);
		const entry = session
			? foundSessionEntry(session, input.t)
			: {
				sessionId: link.sessionId,
				tone: "unknown" as const,
				label: input.t("multica.status.notFound"),
				detail: "",
			};

		entries.push({
			...entry,
			label: clampStatusText(
				input.stale ? input.t("multica.status.stale", { status: entry.label }) : entry.label,
				MAX_STATUS_LABEL,
			),
			detail: clampStatusText(entry.detail, MAX_STATUS_DETAIL),
		});
	}

	return { stale: input.stale, entries };
}

function foundSessionEntry(session: WorkspaceSession, t: TFunction): MulticaLinkStatusEntry {
	const statusView = getSessionStatusView(session.status, t);
	const tone = session.status === "unknown" ? "unknown" : toneByZone[attentionZone(session.status)];
	const primary = primaryPR(session);
	const detailParts: string[] = [];

	if (primary) {
		let prDetail = t("multica.status.pr", {
			number: primary.number,
			state: t(`pr.state.${primary.state}`),
		});
		if (session.prs.length > 1) {
			prDetail += ` ${t("multica.status.prMore", { count: session.prs.length - 1 })}`;
		}
		detailParts.push(prDetail);

		if (primary.state === "open" || primary.state === "draft") {
			if (primary.ci === "passing" || primary.ci === "failing" || primary.ci === "pending") {
				detailParts.push(`${t("pr.section.ci")}: ${t(`pr.ci.${primary.ci}`)}`);
			}

			const reviewKey =
				primary.review === "approved"
					? "pr.review.approved"
					: primary.review === "changes_requested"
						? "pr.review.changesRequested"
						: primary.review === "review_required"
							? "pr.card.reviewRequired"
							: undefined;
			if (reviewKey) detailParts.push(t(reviewKey));
		}
	}

	return {
		sessionId: session.id,
		tone,
		label: statusView.label,
		detail: detailParts.join(" · "),
	};
}
