import type { TFunction } from "i18next";
import type { MulticaLinkStatusEntry, MulticaStatusTone } from "../../shared/multica-session-status";
import { attentionZone, getSessionStatusView, type AttentionZone } from "./session-presentation";
import { primaryPR, type WorkspaceSession } from "../types/workspace";

const toneByZone: Record<AttentionZone, MulticaStatusTone> = {
	merge: "ready",
	action: "attention",
	pending: "pending",
	working: "working",
	done: "done",
};

export function foundSessionEntry(session: WorkspaceSession, t: TFunction): MulticaLinkStatusEntry {
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
