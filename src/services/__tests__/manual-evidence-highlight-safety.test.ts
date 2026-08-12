import { describe, expect, it } from "vitest";
import type {
  ClaimDraft,
  EvidenceItemSnapshot,
  JsonValue,
  WorkItemSnapshot,
} from "@/src/domain/types";
import {
  buildExactManualEvidenceFallback,
  manualEvidenceDlpCategories,
  markDraftsCitingRedactedEvidence,
  sanitizeManualProviderContext,
} from "@/src/services/manual-evidence-highlight-safety";
import {
  USER_AUTHORED_MANUAL_NOTE_KIND,
  USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
} from "@/src/lib/evidence-items";

const workItem: WorkItemSnapshot = {
  id: "work-1",
  userId: "user-1",
  title: "OpenRouter migration",
  type: "project",
  description: "Migration quality fixture.",
  startDate: null,
  endDate: null,
};

function evidence(input: {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}): EvidenceItemSnapshot {
  return {
    id: input.id,
    workItemId: workItem.id,
    sourceId: "source-notes",
    externalId: `source-notes:${input.id}`,
    type: "manual_note_excerpt",
    title: `Initial notes ${input.id}`,
    content: input.content,
    searchText: `${input.content} ${JSON.stringify(input.metadata ?? {})}`,
    parentKind: "source",
    parentKey: "source-notes",
    included: true,
    lifecycleStatus: "active",
    reviewState: "reviewed",
    metadata: ({
      kind: USER_AUTHORED_MANUAL_NOTE_KIND,
      userAuthored: true,
      ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
      ...(input.metadata ?? {}),
    } as JsonValue),
    source: {
      id: "source-notes",
      label: "Initial notes",
      type: "manual_note",
      externalId: "notes",
      metadata: null,
    },
    tags: [],
  };
}

function flaggedDraft(item: EvidenceItemSnapshot): ClaimDraft {
  return {
    text: item.content,
    confidence: "medium",
    ownershipClarity: "partial",
    sensitivityFlag: false,
    verificationStatus: "flagged",
    visibility: "private",
    risksSummary: "The verifier requested review.",
    missingInfo: null,
    rejectionReason: null,
    summary: item.content,
    verificationNotes: null,
    metadata: null,
    evidence: {
      summary: item.content,
      verificationNotes: null,
      sourceRefs: [{
        evidenceItemId: item.id,
        sourceId: item.sourceId,
        sourceLabel: item.source.label,
        sourceType: item.source.type,
        title: item.title,
        excerpt: item.content,
      }],
    },
    tags: [],
  };
}

describe("manual Evidence Highlight safety", () => {
  it("produces only an exact cited fallback when a clean ownership statement was falsely flagged", () => {
    const item = evidence({
      id: "evidence-led",
      content: "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.",
    });

    const fallback = buildExactManualEvidenceFallback({
      evidenceItems: [item],
    });

    expect(fallback).toEqual(expect.objectContaining({
      text: item.content,
      confidence: "high",
      ownershipClarity: "clear",
      verificationStatus: "approved",
      sensitivityFlag: false,
      visibility: "private",
    }));
    expect(fallback?.evidence.sourceRefs).toEqual([
      expect.objectContaining({
        evidenceItemId: item.id,
        excerpt: item.content,
      }),
    ]);
  });

  it("extracts and cites the exact safe sentence from the original paragraph-shaped note", () => {
    const exactSentence =
      "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.";
    const item = evidence({
      id: "evidence-paragraph",
      content: [
        exactSentence,
        "Implemented profile-specific routing, durable provider usage and cost attribution, and paired Bedrock/OpenRouter quality gates.",
        "Preserved evidence-grounded citations and exact repository-head freshness checks across the migration.",
      ].join(" "),
    });

    const fallback = buildExactManualEvidenceFallback({
      evidenceItems: [item],
    });

    expect(item.content.length).toBeGreaterThan(240);
    expect(fallback).toEqual(expect.objectContaining({
      text: exactSentence,
      summary: exactSentence,
      verificationStatus: "approved",
    }));
    expect(fallback?.evidence.sourceRefs).toEqual([
      expect.objectContaining({
        evidenceItemId: item.id,
        excerpt: exactSentence,
      }),
    ]);
    expect(item.content).toContain(fallback?.text ?? "missing");
  });

  it("keeps the exact user excerpt deterministic even when a model draft is approved", () => {
    const item = evidence({
      id: "evidence-led",
      content: "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.",
    });
    const approved = {
      ...flaggedDraft(item),
      verificationStatus: "approved" as const,
      confidence: "high" as const,
    };
    expect(buildExactManualEvidenceFallback({
      evidenceItems: [item],
    })?.text).toBe(item.content);
    expect(approved.verificationStatus).toBe("approved");
  });

  it("does not let an unrelated approved draft suppress a distinct exact excerpt", () => {
    const item = evidence({
      id: "evidence-led",
      content: "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.",
    });
    const unrelated = {
      ...flaggedDraft(item),
      text: "Implemented a durable evaluation harness for repository imports.",
      summary: "Implemented a durable evaluation harness for repository imports.",
      verificationStatus: "approved" as const,
      confidence: "high" as const,
    };
    expect(buildExactManualEvidenceFallback({
      evidenceItems: [item],
    })?.text).toBe(item.content);
    expect(unrelated.verificationStatus).toBe("approved");
  });

  it.each([
    "Migration work happened across model providers.",
    "Led every provider migration.",
    "Led by Alice, the provider migration shipped safely.",
    "Built the provider migration, which was led by Alice.",
    "Built the provider migration. It was led by Alice.",
    "Alice led the provider migration safely.",
    "Reduced provider cost by 42%.",
    "Led work involving confidential customer data.",
    "Led the migration with sk-proj-abcdefghijklmnopqrstuvwxyz123456.",
  ])("fails closed for unsafe or non-ownership Evidence: %s", (content) => {
    expect(buildExactManualEvidenceFallback({
      evidenceItems: [evidence({ id: "unsafe", content })],
    })).toBeNull();
  });

  it("redacts credentials before provider normalization and marks their cited drafts sensitive", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const item = evidence({
      id: "secret-evidence",
      content: `Implemented provider routing with ${secret}.`,
      metadata: { copiedToken: secret },
    });
    const source = {
      id: item.source.id,
      workItemId: workItem.id,
      type: "manual_note" as const,
      label: item.source.label,
      externalId: item.source.externalId,
      rawContent: item.content,
      metadata: { copiedToken: secret },
    };

    const safe = sanitizeManualProviderContext({
      workItem,
      sources: [source],
      evidenceItems: [item],
      existingHighlights: [],
    });

    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.evidenceDlpCategories.get(item.id)).toContain("api_token");
    expect(manualEvidenceDlpCategories(item)).toContain("api_token");
    const marked = markDraftsCitingRedactedEvidence({
      drafts: [flaggedDraft(item)],
      evidenceDlpCategories: safe.evidenceDlpCategories,
      workItemDlpCategories: safe.workItemDlpCategories,
    });
    expect(marked[0]).toEqual(expect.objectContaining({
      verificationStatus: "flagged",
      sensitivityFlag: true,
      visibility: "private",
    }));
  });

  it("redacts credentials used as metadata keys, including collisions", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const item = evidence({
      id: "secret-key-evidence",
      content: "Implemented profile-specific model routing.",
      metadata: {
        [secret]: true,
        "[REDACTED API TOKEN]": false,
        password: "hunter2",
      },
    });
    item.source.metadata = {
      [`source-${secret}`]: secret,
      password: "hunter2",
    };
    const safe = sanitizeManualProviderContext({
      workItem,
      sources: [],
      evidenceItems: [item],
      existingHighlights: [],
    });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain("hunter2");
    expect(safe.evidenceDlpCategories.get(item.id)).toContain("api_token");
  });

  it("does not contaminate a clean candidate with an unrelated secret note", () => {
    const clean = evidence({
      id: "clean",
      content: "Implemented profile-specific model routing.",
    });
    const secret = evidence({
      id: "secret",
      content: "Token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    });
    const safe = sanitizeManualProviderContext({
      workItem,
      sources: [],
      evidenceItems: [clean, secret],
      existingHighlights: [],
    });
    const marked = markDraftsCitingRedactedEvidence({
      drafts: [flaggedDraft(clean)],
      evidenceDlpCategories: safe.evidenceDlpCategories,
      workItemDlpCategories: safe.workItemDlpCategories,
    });
    expect(marked[0]?.sensitivityFlag).toBe(false);
  });
});
