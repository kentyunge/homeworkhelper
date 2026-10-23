import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { explainApiError } from "./engine";

const apiError = (status: number, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "invalid_request_error", message } }, undefined, new Headers());

describe("explainApiError", () => {
  it("explains a key that isn't in a workspace", () => {
    const e = apiError(400, "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header");
    expect(explainApiError(e)).toMatch(/isn't tied to a workspace/);
  });
  it("explains rejected keys, billing problems and outages", () => {
    expect(explainApiError(apiError(401, "invalid x-api-key"))).toMatch(/key was rejected/);
    expect(explainApiError(apiError(400, "Your credit balance is too low"))).toMatch(/out of credit/);
    expect(explainApiError(apiError(529, "Overloaded"))).toMatch(/having trouble/);
  });
  it("leaves other errors alone", () => {
    expect(explainApiError(new Error("boom"))).toBeNull();
  });
});
