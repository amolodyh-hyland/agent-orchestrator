export const CHAT_FOLDER_ATTACHMENT_CHANNEL = "chatAttachment:chooseFolder";
export const CHAT_ATTACHMENT_PATH_CHANNEL = "chatAttachment:path";

export type ChatAttachmentPathInput = {
	path: string;
	sessionId?: string;
	action: "resolve" | "reveal";
};

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
