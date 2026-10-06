const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareEntries(a, b, channelOf = (entry) => entry.channel) {
	return (
		compare(channelOf(a) ?? "", channelOf(b) ?? "") ||
		compare(a.api ?? "", b.api ?? "") ||
		compare(a.kind ?? "", b.kind ?? "") ||
		compare(a.file ?? "", b.file ?? "") ||
		(a.line ?? 0) - (b.line ?? 0)
	);
}

function uniqueBy(items, keyOf) {
	const seen = new Set();
	return items.filter((item) => {
		const key = keyOf(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function kindWorks(multicaKind, aoKind) {
	if (multicaKind === "invoke") return aoKind === "invoke";
	if (multicaKind === "send") return aoKind === "send" || aoKind === "sendSync";
	if (multicaKind === "sendSync") return aoKind === "sendSync";
	return false;
}

function baselineDirection(entry) {
	return entry.kind === "on" ? "inbound" : "outbound";
}

function pairRenames(added, removed, baselineEntries, surfaceEntries, direction) {
	const removedChannels = new Set(removed.map((entry) => entry.channel));
	const proposals = [];
	const byApi = new Map();
	for (let index = 0; index < added.length; index += 1) {
		const entry = added[index];
		const group = byApi.get(entry.api) ?? [];
		group.push({ entry, index });
		byApi.set(entry.api, group);
	}

	for (const [api, additions] of byApi) {
		if (additions.length !== 1) continue;
		const addition = additions[0];
		const oldChannels = uniqueBy(
			baselineEntries
				.filter((entry) => entry.api === api && baselineDirection(entry) === direction)
				.filter((entry) => removedChannels.has(entry.channel))
				.filter(
					(entry) =>
						!surfaceEntries.some(
							(surfaceEntry) =>
								surfaceEntry.api === api && surfaceEntry.channel === entry.channel,
						),
					)
				.map((entry) => ({ channel: entry.channel })),
			(entry) => entry.channel,
		);
		if (oldChannels.length !== 1) continue;
		proposals.push({
			addedIndex: addition.index,
			from: oldChannels[0].channel,
			to: addition.entry.channel,
			api,
			entry: addition.entry,
		});
	}

	const proposalsPerOldChannel = new Map();
	for (const proposal of proposals) {
		proposalsPerOldChannel.set(
			proposal.from,
			(proposalsPerOldChannel.get(proposal.from) ?? 0) + 1,
		);
	}
	const paired = proposals.filter((proposal) => proposalsPerOldChannel.get(proposal.from) === 1);
	const removedKeys = new Set(
		paired.map((proposal) =>
			direction === "inbound" ? JSON.stringify([proposal.from, proposal.api]) : proposal.from,
		),
	);
	const addedIndexes = new Set(paired.map((proposal) => proposal.addedIndex));
	const renamed = paired.map((proposal) => ({
		api: proposal.api,
		kind: proposal.entry.kind,
		from: proposal.from,
		to: proposal.to,
		file: proposal.entry.file,
		line: proposal.entry.line,
	}));
	return {
		added: added.filter((_, index) => !addedIndexes.has(index)),
		removed: removed.filter((entry) =>
			!removedKeys.has(
				direction === "inbound" ? JSON.stringify([entry.channel, entry.api]) : entry.channel,
			),
		),
		renamed,
	};
}

function changedMembers(before = [], after = []) {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	return {
		added: [...afterSet].filter((member) => !beforeSet.has(member)).sort(compare),
		removed: [...beforeSet].filter((member) => !afterSet.has(member)).sort(compare),
	};
}

function outboundMappingWarnings(surface, baseline, renamed) {
	if (!baseline) return [];
	const renamedApis = new Set(renamed.map((entry) => entry.api));
	const channelsByApi = (entries) => {
		const channels = new Map();
		for (const entry of entries) {
			if (baselineDirection(entry) !== "outbound") continue;
			const apiChannels = channels.get(entry.api) ?? new Set();
			apiChannels.add(entry.channel);
			channels.set(entry.api, apiChannels);
		}
		return channels;
	};
	const oldByApi = channelsByApi(baseline.entries ?? []);
	const newByApi = channelsByApi(surface.entries);
	const warnings = [];
	for (const api of [...oldByApi.keys()].sort(compare)) {
		if (!newByApi.has(api) || renamedApis.has(api)) continue;
		const oldChannels = [...oldByApi.get(api)].sort(compare);
		const newChannels = [...newByApi.get(api)].sort(compare);
		if (JSON.stringify(oldChannels) === JSON.stringify(newChannels)) continue;
		warnings.push({
			code: "mapping-changed",
			message: `${api}: ${oldChannels.join(", ")} -> ${newChannels.join(", ")}`,
		});
	}
	return warnings;
}

function makeWarnings(surface, inventory, baseline, renamed) {
	const warnings = [];
	if (baseline) {
		const globals = changedMembers(baseline.globals, surface.globals);
		if (globals.added.length || globals.removed.length) {
			const changes = [];
			if (globals.added.length) changes.push(`added: ${globals.added.join(", ")}`);
			if (globals.removed.length) changes.push(`removed: ${globals.removed.join(", ")}`);
			warnings.push({ code: "globals-changed", message: changes.join("; ") });
		}

		const globalNames = new Set([
			...Object.keys(baseline.members ?? {}),
			...Object.keys(surface.members ?? {}),
		]);
		for (const global of [...globalNames].sort(compare)) {
			const members = changedMembers(baseline.members?.[global], surface.members?.[global]);
			if (!members.added.length && !members.removed.length) continue;
			const changes = [];
			if (members.added.length) changes.push(`added: ${members.added.join(", ")}`);
			if (members.removed.length) changes.push(`removed: ${members.removed.join(", ")}`);
			warnings.push({
				code: "members-changed",
				message: `${global} members ${changes.join("; ")}`,
			});
		}
	}

	const declaredNames = new Set([
		...Object.keys(surface.members ?? {}),
		...Object.keys(surface.declaredMembers ?? {}),
	]);
	for (const global of [...declaredNames].sort(compare)) {
		if (!(global in (surface.members ?? {})) || !(global in (surface.declaredMembers ?? {}))) continue;
		const members = changedMembers(surface.members[global], surface.declaredMembers[global]);
		if (!members.added.length && !members.removed.length) continue;
		const changes = [];
		if (members.added.length) changes.push(`declarations only: ${members.added.join(", ")}`);
		if (members.removed.length) changes.push(`preload only: ${members.removed.join(", ")}`);
		warnings.push({
			code: "declaration-mismatch",
			message: `${global} ${changes.join("; ")}`,
		});
	}

	for (const issue of inventory.issues ?? []) {
		warnings.push({ code: issue.code, message: issue.message });
	}
	warnings.push(...outboundMappingWarnings(surface, baseline, renamed));
	return warnings.sort((a, b) => compare(a.code, b.code) || compare(a.message, b.message));
}

function triples(entries) {
	return entries
		.map(({ api, channel, kind }) => [api, channel, kind])
		.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]));
}

export function diffBridge({ surface, inventory, baseline }) {
	const outbound = surface.entries.filter((entry) => entry.direction === "outbound");
	const inbound = surface.entries.filter((entry) => entry.direction === "inbound");
	const baselineEntries = baseline?.entries ?? [];
	const served = inventory.served ?? {};
	const surfaceOutboundChannels = new Set(outbound.map((entry) => entry.channel));
	const addedCandidates = [];
	const changed = [];

	for (const entry of outbound) {
		if (!Object.hasOwn(served, entry.channel)) {
			addedCandidates.push({
				channel: entry.channel,
				kind: entry.kind,
				api: entry.api,
				file: entry.file,
				line: entry.line,
			});
		} else if (!kindWorks(entry.kind, served[entry.channel])) {
			changed.push({
				channel: entry.channel,
				api: entry.api,
				multicaKind: entry.kind,
				aoKind: served[entry.channel],
				file: entry.file,
				line: entry.line,
			});
		}
	}

	const removedCandidates = Object.entries(served)
		.filter(([channel]) => !surfaceOutboundChannels.has(channel))
		.map(([channel, aoKind]) => ({ channel, aoKind }));
	const inboundBaseline = baselineEntries.filter((entry) => baselineDirection(entry) === "inbound");
	let added = addedCandidates;
	let removed = removedCandidates;
	let renamed = [];
	let inboundAdded = [];
	let inboundRemoved = [];
	let inboundRenamed = [];
	const notes = [];

	if (baseline) {
		const paired = pairRenames(added, removed, baselineEntries, surface.entries, "outbound");
		added = paired.added;
		removed = paired.removed;
		renamed = paired.renamed;

		const inboundPair = (entry) => JSON.stringify([entry.api, entry.channel]);
		const baselineInboundPairs = new Set(inboundBaseline.map(inboundPair));
		const surfaceInboundPairs = new Set(inbound.map(inboundPair));
		inboundAdded = inbound
			.filter((entry) => !baselineInboundPairs.has(inboundPair(entry)))
			.map(({ channel, api, file, line }) => ({ channel, api, file, line }));
		inboundRemoved = uniqueBy(
			inboundBaseline
				.filter((entry) => !surfaceInboundPairs.has(inboundPair(entry)))
				.map(({ channel, api }) => ({ channel, api })),
			(entry) => JSON.stringify([entry.channel, entry.api]),
		);
		const pairedInbound = pairRenames(
			inboundAdded,
			inboundRemoved,
			inboundBaseline,
			inbound,
			"inbound",
		);
		inboundAdded = pairedInbound.added;
		inboundRemoved = pairedInbound.removed;
		inboundRenamed = pairedInbound.renamed.map((entry) => ({ ...entry, kind: entry.kind ?? "on" }));
	} else {
		if (addedCandidates.length && removedCandidates.length) {
			notes.push("no baseline: renames are reported as one added and one removed channel");
		}
		notes.push("no baseline: inbound (main to renderer) channels were not compared");
	}

	const sortDiff = (items, channelOf) => items.sort((a, b) => compareEntries(a, b, channelOf));
	added = sortDiff(added);
	removed = sortDiff(removed);
	changed.sort(compareEntries);
	renamed = sortDiff(renamed, (entry) => entry.to);
	inboundAdded = sortDiff(inboundAdded);
	inboundRemoved = sortDiff(inboundRemoved);
	inboundRenamed = sortDiff(inboundRenamed, (entry) => entry.to);

	const report = {
		ok: false,
		added,
		removed,
		changed,
		renamed,
		inbound: {
			added: inboundAdded,
			removed: inboundRemoved,
			renamed: inboundRenamed,
		},
		warnings: makeWarnings(surface, inventory, baseline, renamed),
		notes: notes.sort(compare),
	};
	report.ok = countDifferences(report) === 0;
	if (
		report.ok &&
		baseline &&
		JSON.stringify(triples(surface.entries)) !== JSON.stringify(triples(baseline.entries ?? []))
	) {
		report.notes.push("baseline is behind the current preload; refresh it after the bridge is updated");
		report.notes.sort(compare);
	}
	return report;
}

export function countDifferences(report) {
	return (
		report.added.length +
		report.removed.length +
		report.changed.length +
		report.renamed.length +
		report.inbound.added.length +
		report.inbound.removed.length +
		report.inbound.renamed.length
	);
}

function shortCommit(commit, fallback) {
	return commit ? String(commit).slice(0, 7) : fallback;
}

function quoted(value) {
	return JSON.stringify(String(value));
}

export function formatReport(report, meta) {
	const differenceCount = countDifferences(report);
	const lines = [
		report.ok
			? "multica bridge drift check: PASS"
			: `multica bridge drift check: FAIL (${differenceCount} differences)`,
		`multica: ${meta.multicaRoot} @ ${shortCommit(meta.multicaCommit, "unknown")}  preload: ${meta.preloadFile}`,
		`baseline: ${shortCommit(meta.baselineCommit, "none")}   AO bridge: ${meta.servedCount} channels served`,
	];
	const sections = [];
	if (report.added.length) {
		sections.push([
			"ADDED   multica uses a channel AO does not serve (the jail blocks it)",
			...report.added.map(
				(entry) => `  + ${entry.kind}  ${quoted(entry.channel)}  ${entry.api}  ${entry.file}:${entry.line}`,
			),
		]);
	}
	if (report.removed.length) {
		sections.push([
			"REMOVED   AO serves a channel multica no longer uses (stale allowlist entry)",
			...report.removed.map((entry) => `  - ${entry.aoKind}  ${quoted(entry.channel)}`),
		]);
	}
	if (report.changed.length) {
		sections.push([
			"CHANGED   same channel, different IPC kind",
			...report.changed.map(
				(entry) =>
					`  ~ ${quoted(entry.channel)}  multica ${entry.multicaKind}, AO serves ${entry.aoKind}  ${entry.api}  ${entry.file}:${entry.line}`,
			),
		]);
	}
	if (report.renamed.length) {
		sections.push([
			"RENAMED   same API member, new channel",
			...report.renamed.map(
				(entry) =>
					`  > ${entry.kind}  ${quoted(entry.from)} -> ${quoted(entry.to)}  ${entry.api}  ${entry.file}:${entry.line}`,
			),
		]);
	}
	if (report.inbound.added.length || report.inbound.removed.length || report.inbound.renamed.length) {
		const entries = ["INBOUND (main to renderer) CHANGES SINCE THE BASELINE"];
		entries.push(
			...report.inbound.added.map(
				(entry) => `  + ${quoted(entry.channel)}  ${entry.api}  ${entry.file}:${entry.line}    (added)`,
			),
			...report.inbound.removed.map(
				(entry) => `  - ${quoted(entry.channel)}  ${entry.api}                   (removed)`,
			),
			...report.inbound.renamed.map(
				(entry) =>
					`  > ${quoted(entry.from)} -> ${quoted(entry.to)}  ${entry.api}  ${entry.file}:${entry.line}    (renamed)`,
			),
		);
		sections.push(entries);
	}
	if (report.warnings.length) {
		sections.push([
			"WARNINGS",
			...report.warnings.map((warning) => `  ! ${warning.code}: ${warning.message}`),
		]);
	}
	if (report.notes.length) {
		sections.push(["NOTES", ...report.notes.map((note) => `  ${note}`)]);
	}
	for (const section of sections) lines.push("", ...section);
	if (!report.ok) {
		const inboundOnly =
			report.added.length + report.removed.length + report.changed.length + report.renamed.length === 0;
		lines.push(
			"",
			inboundOnly
				? 'Decide whether AO delivers, stubs or ignores each inbound channel, then run "npm run check:multica-bridge -- --update-baseline" and commit the baseline.'
				: 'Update frontend/src/main/multica-desktop-bridge.ts (and the jail follows from multicaBridgeChannels()), then rerun. After the check passes, run "npm run check:multica-bridge -- --update-baseline" and commit the baseline with the submodule bump.',
		);
	}
	return `${lines.join("\n")}\n`;
}
