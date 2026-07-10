import { describe, expect, it } from "vitest";
import {
  looksLikeArtifactRequest,
  normalizeArtifactBrief,
} from "@/src/services/artifact-brief-service";

describe("artifact brief normalization", () => {
  it("maps a freeform request onto the supported artifact controls", () => {
    const result = normalizeArtifactBrief(
      "Write two technical resume bullets emphasizing the backend API and ownership.",
    );

    expect(result).toEqual({
      status: "ok",
      request: expect.objectContaining({
        type: "resume_bullets",
        targetAngle: "backend",
        tone: "technical",
      }),
    });
  });

  it("asks for clarification outside the supported output kinds", () => {
    expect(normalizeArtifactBrief("Write something impressive").status).toBe(
      "clarification_required",
    );
  });

  it("detects chat requests for artifacts", () => {
    expect(looksLikeArtifactRequest("Draft a LinkedIn experience entry")).toBe(true);
    expect(looksLikeArtifactRequest("How does authentication work?")).toBe(false);
  });
});
