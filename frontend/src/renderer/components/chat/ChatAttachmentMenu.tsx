import { File, Folder, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export function ChatAttachmentMenu({
	disabled,
	onAttachFile,
	onAttachFolder,
}: {
	disabled?: boolean;
	onAttachFile: () => void;
	onAttachFolder: () => void;
}) {
	const { t } = useTranslation();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					disabled={disabled}
					aria-label={t("chat.composer.addAttachment")}
					className="size-7 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-interactive-active! hover:text-foreground"
				>
					<Plus aria-hidden="true" className="size-3.5 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="min-w-40">
				<DropdownMenuItem onSelect={onAttachFile}>
					<File aria-hidden="true" className="size-3.5 shrink-0" />
					{t("chat.composer.attachFile")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onAttachFolder}>
					<Folder aria-hidden="true" className="size-3.5 shrink-0" />
					{t("chat.composer.attachFolder")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
