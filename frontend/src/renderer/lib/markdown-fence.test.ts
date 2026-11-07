import { createElement } from "react";
import { expect, it } from "vitest";
import { fenceOf } from "./markdown-fence";

it.each([".env", "@config", "js/custom", "c++", "#shell", "[script]", "!bash"])("extracts the complete explicit label %s", (label) => {
	expect(fenceOf(createElement("code", { className: `extra language-${label} other` }, "const value = 1;\n"))).toEqual({
		code: "const value = 1;",
		language: label,
	});
});

it.each([undefined, "", "other-language-js", "language-"])("keeps absent language classes distinct from explicit labels: %s", (className) => {
	expect(fenceOf(createElement("code", { className }, "code"))?.language).toBeUndefined();
});
