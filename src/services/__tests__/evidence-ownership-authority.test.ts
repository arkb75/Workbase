import { describe, expect, it } from "vitest";
import { explicitSelfReportedOwnershipAuthority } from "@/src/services/evidence-ownership-authority";
import { findUnsupportedOwnershipClaims } from "@/src/services/project-answer-grounding-service";
import {
  USER_AUTHORED_MANUAL_NOTE_KIND,
  USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
} from "@/src/lib/evidence-items";

describe("explicit self-reported Evidence ownership authority", () => {
  it("grants private-chat authority to cited Work Item descriptions and chat statements", () => {
    const workItemDescription = {
      type: "manual_note_excerpt",
      content: "Led the Workbase migration from Bedrock to OpenRouter.",
      metadata: { kind: "work_item_description", systemOwned: true },
      source: { metadata: {} },
    };
    const chatStatement = {
      type: "chat_user_statement",
      metadata: {},
      source: { metadata: {} },
    };

    expect(explicitSelfReportedOwnershipAuthority(workItemDescription)).toBe(3);
    expect(explicitSelfReportedOwnershipAuthority({
      ...workItemDescription,
      content: "Built the Workbase migration, which was led by Alice.",
    })).toBe(0);
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
      metadata: { kind: "work_item_description", systemOwned: true },
      source: { metadata: {} },
    })).toBe(0);
    expect(explicitSelfReportedOwnershipAuthority({
      type: "manual_note_excerpt",
      metadata: {},
      source: { metadata: {} },
    })).toBe(0);
  });

  it("recognizes source-note Evidence explicitly marked user-authored at ingestion", () => {
    expect(explicitSelfReportedOwnershipAuthority({
      type: "manual_note_excerpt",
      content: "Led the Workbase migration from Bedrock to OpenRouter.",
      metadata: {
        kind: USER_AUTHORED_MANUAL_NOTE_KIND,
        userAuthored: true,
        ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
      },
      source: { metadata: {} },
    })).toBe(3);
    expect(explicitSelfReportedOwnershipAuthority({
      type: "manual_note_excerpt",
      content: "Led by Alice, the Workbase migration shipped safely.",
      metadata: {
        kind: USER_AUTHORED_MANUAL_NOTE_KIND,
        userAuthored: true,
        ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
      },
      source: { metadata: {} },
    })).toBe(0);
    expect(explicitSelfReportedOwnershipAuthority({
      type: "manual_note_excerpt",
      content: "Built the Workbase migration, which was led by Alice.",
      metadata: {
        kind: USER_AUTHORED_MANUAL_NOTE_KIND,
        userAuthored: true,
        ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
      },
      source: { metadata: {} },
    })).toBe(0);
  });
});
