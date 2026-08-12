import { describe, expect, it } from "vitest";
import type { JsonValue, SourceSnapshot } from "@/src/domain/types";
import {
  buildManualEvidenceItemsFromSource,
  USER_AUTHORED_MANUAL_NOTE_KIND,
  USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
  USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
} from "@/src/lib/evidence-items";

function source(metadata: JsonValue | null): SourceSnapshot {
  return {
    id: "source-1",
    workItemId: "work-1",
    type: "manual_note",
    label: "Initial notes",
    externalId: null,
    rawContent: "Led the Workbase migration from Bedrock to OpenRouter.",
    metadata,
  };
}

describe("manual Evidence ingestion provenance", () => {
  it("propagates ownership only from an explicitly user-authored Source", () => {
    const [trusted] = buildManualEvidenceItemsFromSource(source({
      kind: USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
      userAuthored: true,
      ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
    }));
    expect(trusted?.metadata).toEqual(expect.objectContaining({
      kind: USER_AUTHORED_MANUAL_NOTE_KIND,
      userAuthored: true,
      ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
    }));

    const [legacy] = buildManualEvidenceItemsFromSource(source(null));
    const [imported] = buildManualEvidenceItemsFromSource(source({
      kind: "imported_fixture",
      userAuthored: true,
    }));
    expect(legacy?.metadata).not.toHaveProperty("userAuthored");
    expect(imported?.metadata).not.toHaveProperty("userAuthored");
  });
});
