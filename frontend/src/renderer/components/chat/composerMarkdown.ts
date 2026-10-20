export type ComposerMarkdownCodeRange = {
	start: number;
	end: number;
	kind: "inline" | "fenced";
};

type ComposerCodeFence = {
	start: number;
	end: number;
	closeStart?: number;
	markerLength: number;
	openedOnLine: boolean;
};

export type ComposerMarkdownAnalysis = {
	codeRanges: ComposerMarkdownCodeRange[];
	inlineCode: ComposerMarkdownCodeRange[];
	fencedCode: ComposerMarkdownCodeRange[];
	fences: ComposerCodeFence[];
};

export type ComposerMarkdownRangeCursor = {
	splitOffsets(start: number, end: number): number[];
	coveringRange(start: number, end: number): ComposerMarkdownCodeRange | undefined;
	advanceTo(offset: number): void;
};

/**
 * Maps sorted, disjoint code ranges onto text nodes in document order.
 * Each query resumes at the first range that can still overlap its interval.
 */
export function createComposerMarkdownRangeCursor(
	ranges: readonly ComposerMarkdownCodeRange[],
): ComposerMarkdownRangeCursor {
	let nextRange = 0;
	const advanceTo = (offset: number) => {
		while (nextRange < ranges.length) {
			if (ranges[nextRange].end > offset) break;
			nextRange += 1;
		}
	};

	return {
		splitOffsets: (start, end) => {
			advanceTo(start);
			const offsets = new Set<number>();
			for (let index = nextRange; index < ranges.length; index += 1) {
				const range = ranges[index];
				if (range.start >= end) break;
				if (range.start > start) offsets.add(range.start - start);
				if (range.end > start && range.end < end) offsets.add(range.end - start);
			}
			return [...offsets];
		},
		coveringRange: (start, end) => {
			advanceTo(start);
			const range = ranges[nextRange];
			return range && range.start <= start && range.end >= end ? range : undefined;
		},
		advanceTo,
	};
}

function mergeRanges(
	first: readonly ComposerMarkdownCodeRange[],
	second: readonly ComposerMarkdownCodeRange[],
): ComposerMarkdownCodeRange[] {
	const merged: ComposerMarkdownCodeRange[] = [];
	let firstIndex = 0;
	let secondIndex = 0;
	while (firstIndex < first.length || secondIndex < second.length) {
		const left = first[firstIndex];
		const right = second[secondIndex];
		if (
			left &&
			(!right || left.start < right.start || (left.start === right.start && left.end <= right.end))
		) {
			merged.push(left);
			firstIndex += 1;
		} else if (right) {
			merged.push(right);
			secondIndex += 1;
		}
	}
	return merged;
}

type MarkdownLine = {
	start: number;
	end: number;
	text: string;
	hasNewline: boolean;
};

function markdownLines(text: string): MarkdownLine[] {
	const lines: MarkdownLine[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		const contentEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
		lines.push({ start, end, text: text.slice(start, contentEnd), hasNewline: newline >= 0 });
		if (newline < 0) break;
		start = newline + 1;
	}
	return lines;
}

function isEscaped(text: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		slashes += 1;
	}
	return slashes % 2 === 1;
}

function backtickRunEnd(text: string, start: number): number {
	let end = start + 1;
	while (text[end] === "`") end += 1;
	return end;
}

function inlineCodeOnLine(text: string, lineStart: number): ComposerMarkdownCodeRange[] {
	const ranges: ComposerMarkdownCodeRange[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const openingStart = text.indexOf("`", cursor);
		if (openingStart < 0) break;
		const openingEnd = backtickRunEnd(text, openingStart);
		if (isEscaped(text, openingStart)) {
			cursor = openingEnd;
			continue;
		}

		const markerLength = openingEnd - openingStart;
		let search = openingEnd;
		let closingStart = -1;
		let closingEnd = -1;
		while (search < text.length) {
			const candidateStart = text.indexOf("`", search);
			if (candidateStart < 0) break;
			const candidateEnd = backtickRunEnd(text, candidateStart);
			if (
				candidateEnd - candidateStart === markerLength &&
				!isEscaped(text, candidateStart)
			) {
				closingStart = candidateStart;
				closingEnd = candidateEnd;
				break;
			}
			search = candidateEnd;
		}

		if (closingStart > openingEnd) {
			ranges.push({
				start: lineStart + openingStart,
				end: lineStart + closingEnd,
				kind: "inline",
			});
			cursor = closingEnd;
		} else {
			cursor = openingEnd;
		}
	}
	return ranges;
}

export function parseComposerMarkdown(text: string): ComposerMarkdownAnalysis {
	const lines = markdownLines(text);
	const fencedLines = new Set<number>();
	const fences: ComposerCodeFence[] = [];
	let activeFence: Omit<ComposerCodeFence, "end" | "closeStart"> | undefined;

	for (const [index, line] of lines.entries()) {
		if (activeFence) {
			fencedLines.add(index);
			const closing = line.text.match(/^ {0,3}(`{3,})[\t ]*$/);
			if (closing && closing[1].length >= activeFence.markerLength) {
				fences.push({ ...activeFence, end: line.end, closeStart: line.start });
				activeFence = undefined;
			}
			continue;
		}

		const opening = line.text.match(/^ {0,3}(`{3,})([^`]*)$/);
		if (!opening) continue;
		fencedLines.add(index);
		activeFence = {
			start: line.start,
			markerLength: opening[1].length,
			openedOnLine: line.hasNewline,
		};
	}

	if (activeFence) fences.push({ ...activeFence, end: text.length });

	const fencedCode = fences.flatMap((fence): ComposerMarkdownCodeRange[] =>
		fence.openedOnLine && fence.end > fence.start
			? [{ start: fence.start, end: fence.end, kind: "fenced" }]
			: [],
	);
	const inlineCode = lines.flatMap((line, index) =>
		fencedLines.has(index) ? [] : inlineCodeOnLine(line.text, line.start),
	);
	const codeRanges = mergeRanges(fencedCode, inlineCode);

	return { codeRanges, inlineCode, fencedCode, fences };
}

export function isComposerCodeFenceAt(text: string, offset: number): boolean {
	return parseComposerMarkdown(text).fences.some((fence) =>
		offset >= fence.start && (fence.closeStart === undefined || offset < fence.closeStart),
	);
}

export function isComposerOpenCodeFenceAt(text: string, offset: number): boolean {
	return parseComposerMarkdown(text).fences.some((fence) =>
		fence.closeStart === undefined && offset >= fence.start,
	);
}
