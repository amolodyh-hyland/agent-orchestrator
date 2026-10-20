export const CHAT_FOLDER_ATTACHMENT_CHANNEL = "chatAttachment:chooseFolder";

export type ChatFolderAttachmentError =
	| "invalid_path"
	| "not_found"
	| "not_directory"
	| "not_readable"
	| "symbolic_link"
	| "trailing_whitespace";

export type ChatFolderAttachmentSelection = {
	path: string;
	name: string;
	machineName: string;
};

export type ChatFolderAttachmentPickerResult =
	| ChatFolderAttachmentSelection
	| { error: ChatFolderAttachmentError }
	| null;
