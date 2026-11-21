import type { ReactNode } from "react";
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
	folderDisabled,
	attachmentsDisabled,
	showAttachments = true,
	onCloseAutoFocus,
	children,
}: {
	disabled?: boolean;
	onAttachFile: () => void;
	onAttachFolder: () => void;
	folderDisabled?: boolean;
	attachmentsDisabled?: boolean;
	showAttachments?: boolean;
	onCloseAutoFocus?: (event: Event) => void;
	children?: ReactNode;
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
					aria-label={t(showAttachments ? "chat.composer.addAttachment" : "shortcut.add")}
					className="size-7 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-interactive-active! hover:text-foreground"
				>
					<Plus aria-hidden="true" className="size-3.5 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="min-w-40" onCloseAutoFocus={onCloseAutoFocus}>
				{showAttachments ? <>
					<DropdownMenuItem disabled={attachmentsDisabled} onSelect={onAttachFile}>
						<File aria-hidden="true" className="size-3.5 shrink-0" />
						{t("chat.composer.attachFile")}
					</DropdownMenuItem>
					<div role="none" title={folderDisabled ? t("chat.composer.attachFolderRemoteUnavailable") : undefined}>
						<DropdownMenuItem
							disabled={folderDisabled || attachmentsDisabled}
							aria-description={folderDisabled ? t("chat.composer.attachFolderRemoteUnavailable") : undefined}
							onSelect={onAttachFolder}
						>
							<Folder aria-hidden="true" className="size-3.5 shrink-0" />
							{t("chat.composer.attachFolder")}
						</DropdownMenuItem>
					</div>
				</> : null}
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
