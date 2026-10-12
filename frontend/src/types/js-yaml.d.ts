declare module "js-yaml" {
	/** The parts of the loader state that AO reads: the anchors seen so far. */
	export type LoaderState = { anchorMap?: Record<string, unknown> | null };
	export type LoadOptions = {
		filename?: string;
		/** Called for non-fatal problems; duplicate keys are always an error. */
		onWarning?: (warning: Error) => void;
		json?: boolean;
		/** The tag set: CORE_SCHEMA has no merge key (`<<`), timestamp, binary, set or omap types. */
		schema?: unknown;
		/** Called as each node is opened and closed. */
		listener?: (event: "open" | "close", state: LoaderState) => void;
	};
	/** YAML's core schema: null, booleans, integers, floats and strings only. */
	export const CORE_SCHEMA: unknown;
	/** Parses one YAML document with the default (safe) schema: no code execution, no custom tags. */
	export function load(input: string, options?: LoadOptions): unknown;
}
