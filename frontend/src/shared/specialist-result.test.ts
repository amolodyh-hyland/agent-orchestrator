import { describe, expect, it, vi } from "vitest";
import { installResultUserAction } from "./specialist-result";

describe("isolated result consent click",()=>{
 it("does not promote synthetic clicks into native read or import consent",()=>{
  const invoke=vi.fn(async()=>undefined);installResultUserAction(document,invoke);
  const button=document.createElement("button");button.dataset.resultPreviewId="preview";button.dataset.resultPreviewDigest="a".repeat(64);document.body.append(button);
  button.click();button.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  expect(invoke).not.toHaveBeenCalled();button.remove();
 });
});
