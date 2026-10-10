import { Link2, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { useMulticaStore } from "../stores/multica-store";
import { MulticaLinkSyncControls } from "./MulticaLinkSyncControls";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function MulticaIssueLinkChip({ projectId, sessionId }: { projectId: string; sessionId: string }) {
	const { t } = useTranslation();
	const viewStatus = useMulticaStore((state) => state.view.status);
	const links = useMulticaLinksStore((state) => state.links);
	const load = useMulticaLinksStore((state) => state.load);
	const add = useMulticaLinksStore((state) => state.add);
	const remove = useMulticaLinksStore((state) => state.remove);
	const openIssue = useMulticaLinksStore((state) => state.openIssue);
	const [open, setOpen] = useState(false);
	const [issue, setIssue] = useState("");
	const [error, setError] = useState<"invalid" | "saveFailed" | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const sessionLinks = links.filter((link) => link.sessionId === sessionId && link.projectId === projectId);

	useEffect(() => {
		void load();
	}, [load]);

	if (viewStatus === "unconfigured") return null;

	const submit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!issue.trim() || submitting) return;
		setSubmitting(true);
		setError(null);
		const result = await add({ sessionId, projectId, issue });
		if (result.ok) {
			setIssue("");
			setError(null);
		} else {
			setError(result.reason === "invalid_issue" ? "invalid" : "saveFailed");
		}
		setSubmitting(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							aria-label={t("multica.links.add")}
							className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full border border-border px-2 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
							data-testid="multica-issue-link-chip"
							type="button"
						>
							{sessionLinks.length === 0 ? (
								<Link2 aria-hidden="true" className="size-3" />
							) : (
							<>
								<span>{sessionLinks[0].issueIdentifier}</span>
								{sessionLinks.length > 1 ? <span>+{sessionLinks.length - 1}</span> : null}
							</>
							)}
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("multica.links.add")}</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" className="w-72 space-y-3 p-3">
				{sessionLinks.length > 0 ? (
					<div className="space-y-1">
						{sessionLinks.map((link: MulticaIssueLink) => (
							<div className="space-y-1" key={`${link.workspaceSlug}-${link.issueIdentifier}`}>
								<div className="flex items-center gap-1">
									<button
										aria-label={t("multica.links.open", { issue: link.issueIdentifier })}
										className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm text-foreground hover:bg-muted"
										onClick={() => {
											void openIssue({ workspaceSlug: link.workspaceSlug, issueIdentifier: link.issueIdentifier });
											setOpen(false);
										}}
										type="button"
									>
										{link.issueIdentifier}
									</button>
									<button
										aria-label={t("multica.links.unlink", { issue: link.issueIdentifier })}
										className="inline-flex size-control-sm shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										onClick={() => void remove({
											sessionId,
											workspaceSlug: link.workspaceSlug,
											issueIdentifier: link.issueIdentifier,
										})}
										type="button"
									>
										<Unlink aria-hidden="true" className="size-3.5" />
									</button>
								</div>
								<MulticaLinkSyncControls link={link} />
							</div>
						))}
					</div>
				) : null}
				<form className="space-y-2" onSubmit={(event) => void submit(event)}>
					<Input
						aria-describedby={error ? "multica-issue-link-error" : undefined}
						aria-invalid={Boolean(error)}
						onChange={(event) => {
							setIssue(event.target.value);
							setError(null);
						}}
						placeholder={t("multica.links.placeholder")}
						value={issue}
					/>
					{error ? (
						<p className="text-xs text-destructive" id="multica-issue-link-error">
							{error === "invalid" ? t("multica.links.invalid") : t("multica.links.saveFailed")}
						</p>
					) : null}
					<div className="flex justify-end">
						<Button disabled={!issue.trim() || submitting} size="sm" type="submit">
							{t("multica.links.submit")}
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}
