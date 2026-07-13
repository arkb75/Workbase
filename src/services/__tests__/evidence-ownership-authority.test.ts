import { describe, expect, it } from "vitest";
import { explicitSelfReportedOwnershipAuthority } from "@/src/services/evidence-ownership-authority";
import { findUnsupportedOwnershipClaims } from "@/src/services/project-answer-grounding-service";

describe("explicit self-reported Evidence ownership authority", () => {
  it("grants private-chat authority to cited Work Item descriptions and chat statements", () => {
    const workItemDescription = {
      type: "manual_note_excerpt",
      metadata: { kind: "work_item_description" },
      source: { metadata: {} },
    };
    const chatStatement = {
      type: "chat_user_statement",
      metadata: {},
      source: { metadata: {} },
    };

    expect(explicitSelfReportedOwnershipAuthority(workItemDescription)).toBe(3);
    expect(explicitSelfReportedOwnershipAuthority(chatStatement)).toBe(3);
    expect(findUnsupportedOwnershipClaims({
      answer: "You built Workbase end to end. [citation:1]",
      entries: [{
        kind: "evidence",
        authority: "included_evidence",
        title: "Work Item description",
        content: "Built Workbase end to end.",
        currentRun: false,
        citationIndexes: [1],
        ownershipAuthority: explicitSelfReportedOwnershipAuthority(workItemDescription),
        supportingSources: [],
      }],
    })).toEqual([]);
  });

  it("does not turn repository excerpts or ordinary manual notes into ownership proof", () => {
    expect(explicitSelfReportedOwnershipAuthority({
      type: "github_file_excerpt",
      metadata: { kind: "work_item_description" },
      source: { metadata: {} },
    })).toBe(0);
    expect(explicitSelfReportedOwnershipAuthority({
      type: "manual_note_excerpt",
      metadata: {},
      source: { metadata: {} },
    })).toBe(0);
  });
});
