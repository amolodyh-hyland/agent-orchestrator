declare module "js-yaml" {
	export type LoadOptions = {
		filename?: string;
		/** Called for non-fatal problems; duplicate keys are always an error. */
		onWarning?: (warning: Error) => void;
		json?: boolean;
	};
	/** Parses one YAML document with the default (safe) schema: no code execution, no custom tags. */
	export function load(input: string, options?: LoadOptions): unknown;
}
