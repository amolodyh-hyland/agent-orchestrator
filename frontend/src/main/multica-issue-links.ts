import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	coerceMulticaIssueLinks,
	isMulticaIssueLink,
	MAX_MULTICA_ISSUE_LINKS,
	type MulticaIssueLink,
} from "../shared/multica-issue-links";

export const MULTICA_ISSUE_LINKS_FILE = "multica-issue-links.json";

export type MulticaIssueLinkKey = { sessionId: string; workspaceSlug: string; issueIdentifier: string; serverKey?: string };
export type MulticaIssueLinkStore = {
	list: () => Promise<MulticaIssueLink[]>;
	add: (link: Omit<MulticaIssueLink, "createdAt">) => Promise<MulticaIssueLink[]>;
	remove: (key: MulticaIssueLinkKey) => Promise<MulticaIssueLink[]>;
	/** Gives every link made before servers could be switched to `serverKey`; returns all links. */
	adoptLegacy: (serverKey: string) => Promise<MulticaIssueLink[]>;
};

let linkOperationQueue: Promise<void> = Promise.resolve();

async function readUnlocked(stateDir: string): Promise<MulticaIssueLink[]> {
	try {
		const raw = await readFile(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE), "utf8");
		return coerceMulticaIssueLinks(JSON.parse(raw));
	} catch {
		return [];
	}
}

async function writeUnlocked(stateDir: string, links: MulticaIssueLink[]): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, MULTICA_ISSUE_LINKS_FILE);
	const temporary = path.join(stateDir, `.multica-issue-links-${process.pid}-${randomUUID()}.json`);
	try {
		await writeFile(temporary, `${JSON.stringify({ version: 1, links }, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, file);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

function runLinkOperation<T>(operation: () => Promise<T>): Promise<T> {
	const queued = linkOperationQueue.then(operation, operation);
	linkOperationQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

function hasSameKey(link: MulticaIssueLink, key: MulticaIssueLinkKey): boolean {
	return (
		link.sessionId === key.sessionId &&
		link.workspaceSlug === key.workspaceSlug &&
		link.issueIdentifier === key.issueIdentifier &&
		link.serverKey === key.serverKey
	);
}

export function createMulticaIssueLinkStore(stateDir: string, now: () => Date = () => new Date()): MulticaIssueLinkStore {
	return {
		list: () => runLinkOperation(() => readUnlocked(stateDir)),
		add: (link) =>
			runLinkOperation(async () => {
				const candidate: MulticaIssueLink = { ...link, createdAt: now().toISOString() };
				if (!isMulticaIssueLink(candidate)) throw new Error("invalid link");

				const links = await readUnlocked(stateDir);
				if (links.some((existing) => hasSameKey(existing, candidate))) return links;

				const next = [...links, candidate].slice(-MAX_MULTICA_ISSUE_LINKS);
				await writeUnlocked(stateDir, next);
				return next;
			}),
		remove: (key) =>
			runLinkOperation(async () => {
				const links = await readUnlocked(stateDir);
				const next = links.filter((link) => !hasSameKey(link, key));
				if (next.length !== links.length) await writeUnlocked(stateDir, next);
				return next;
			}),
		adoptLegacy: (serverKey) =>
			runLinkOperation(async () => {
				const links = await readUnlocked(stateDir);
				if (links.every((link) => link.serverKey !== undefined)) return links;
				const next = links.map((link) => (link.serverKey === undefined ? { ...link, serverKey } : link));
				await writeUnlocked(stateDir, next);
				return next;
			}),
	};
}
