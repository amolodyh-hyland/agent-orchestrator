import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKeyForHost } from "../hooks/useWorkspaceQuery";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

export function CreateContextProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
		<DialogContent showCloseButton={!pending}>
			<DialogTitle>{t("projectContext.create")}</DialogTitle>
			<DialogDescription>{t("projectContext.createDescription")}</DialogDescription>
			<form className="flex flex-col gap-4" onSubmit={async (event) => {
				event.preventDefault();
				if (pending || !name.trim()) return;
				setPending(true);
				setError(undefined);
				try {
					const { data, error } = await apiClient.POST("/api/v1/projects/containers", { body: { displayName: name.trim() } });
					if (error || !data) throw new Error(apiErrorMessage(error));
					await queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost() });
					onCreated(data.project.id);
				} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
				finally { setPending(false); }
			}}>
				<Label htmlFor="context-project-name">{t("settings.project.name")}</Label>
				<Input id="context-project-name" autoFocus maxLength={100} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} />
				{error && <p role="alert" className="text-sm text-error">{error}</p>}
				<DialogFooter><Button type="submit" disabled={pending || !name.trim()}>{t(pending ? "createProject.creating" : "projectContext.create")}</Button></DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
