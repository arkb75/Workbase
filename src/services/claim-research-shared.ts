import type { ClaimDraft, NormalizedEvidenceItem, WorkItemSnapshot } from "@/src/domain/types";
import { toSentence } from "@/src/lib/utils";

export function isRejectedGuidanceSource(source: NormalizedEvidenceItem) {
  return (
    typeof source.metadata === "object" &&
    source.metadata &&
    "kind" in source.metadata &&
    source.metadata.kind === "rejected_claim_context"
  );
}

export function buildRejectedGuidance(evidenceItems: NormalizedEvidenceItem[]) {
  return evidenceItems
    .filter(isRejectedGuidanceSource)
    .map((source) => source.body)
    .join("\n\n");
}

export function buildResearchSourceCatalog(
  workItem: Pick<WorkItemSnapshot, "id" | "description">,
  evidenceItems: NormalizedEvidenceItem[],
) {
  return [
    {
      evidenceItemId: `${workItem.id}-description`,
      sourceId: `${workItem.id}-description`,
      sourceLabel: "Work Item description",
      sourceType: "manual_note" as const,
      title: "Work Item description",
      excerpt: toSentence(workItem.description),
    },
    ...evidenceItems
      .filter((item) => !isRejectedGuidanceSource(item))
      .map((item) => ({
        evidenceItemId: item.id,
        sourceId: item.sourceId,
        sourceLabel:
          typeof item.metadata === "object" &&
          item.metadata &&
          "sourceLabel" in item.metadata &&
          typeof item.metadata.sourceLabel === "string"
            ? item.metadata.sourceLabel
            : item.label,
        sourceType: item.type,
        title: item.label,
        excerpt: toSentence(item.excerpts[0] ?? item.body),
      })),
  ];
}

export type ResearchSourceCatalog = ReturnType<typeof buildResearchSourceCatalog>;

export function buildRepairEvidenceRefHints(sourceCatalog: ResearchSourceCatalog) {
  return [
    "When repairing sourceRefs, only use one or more of these exact evidenceItemId values. Do not invent aliases, shortened IDs, or placeholder refs.",
    ...sourceCatalog.map(
      (sourceRef) =>
        `${sourceRef.evidenceItemId}: ${sourceRef.title ?? sourceRef.sourceLabel} | ${sourceRef.excerpt}`,
    ),
  ];
}

export function readResearchRefEvidenceItemId(
  sourceRef:
    | {
        evidenceItemId?: string;
        sourceId: string;
        sourceLabel: string;
        sourceType: "manual_note" | "github_repo";
        title?: string;
        excerpt: string;
      }
    | { evidenceItemId: string }
    | { id: string }
    | { sourceId: string }
    | string,
) {
  if (typeof sourceRef === "string") {
    return sourceRef;
  }

  if ("evidenceItemId" in sourceRef && typeof sourceRef.evidenceItemId === "string") {
    return sourceRef.evidenceItemId;
  }

  if ("id" in sourceRef && typeof sourceRef.id === "string") {
    return sourceRef.id;
  }

  return null;
}

export function readResearchRefSourceId(
  sourceRef:
    | {
        evidenceItemId?: string;
        sourceId: string;
        sourceLabel: string;
        sourceType: "manual_note" | "github_repo";
        title?: string;
        excerpt: string;
      }
    | { evidenceItemId: string }
    | { id: string }
    | { sourceId: string }
    | string,
) {
  if (typeof sourceRef === "string") {
    return null;
  }

  if ("sourceId" in sourceRef && typeof sourceRef.sourceId === "string") {
    return sourceRef.sourceId;
  }

  return null;
}

export function normalizeResearchDrafts(
  output: {
    claims: Array<{
      claimText: string;
      category: string;
      confidence: "low" | "medium" | "high";
      ownershipClarity: "unclear" | "partial" | "clear";
      evidenceSummary: string;
      rationaleSummary: string;
      risksSummary?: string | null;
      missingInfo?: string | null;
      sourceRefs: Array<
        | {
            evidenceItemId?: string;
            sourceId: string;
            sourceLabel: string;
            sourceType: "manual_note" | "github_repo";
            title?: string;
            excerpt: string;
          }
        | { evidenceItemId: string }
        | { id: string }
        | { sourceId: string }
        | string
      >;
    }>;
  },
  sourceCatalog: ResearchSourceCatalog,
) {
  const sourceCatalogByEvidenceItemId = new Map<string, (typeof sourceCatalog)[number]>();
  const sourceCatalogBySourceId = new Map<string, (typeof sourceCatalog)[number]>();

  for (const sourceRef of sourceCatalog) {
    if (!sourceCatalogByEvidenceItemId.has(sourceRef.evidenceItemId)) {
      sourceCatalogByEvidenceItemId.set(sourceRef.evidenceItemId, sourceRef);
    }

    if (!sourceCatalogBySourceId.has(sourceRef.sourceId)) {
      sourceCatalogBySourceId.set(sourceRef.sourceId, sourceRef);
    }
  }

  return output.claims.map<ClaimDraft>((claim) => ({
    text: toSentence(claim.claimText),
    category: claim.category,
    confidence: claim.confidence,
    ownershipClarity: claim.ownershipClarity,
    sensitivityFlag: false,
    verificationStatus: "draft",
    visibility: "resume_safe",
    risksSummary: claim.risksSummary ?? null,
    missingInfo: claim.missingInfo ?? null,
    rejectionReason: null,
    evidenceCard: {
      evidenceSummary: claim.evidenceSummary,
      rationaleSummary: claim.rationaleSummary,
      sourceRefs: claim.sourceRefs.flatMap((sourceRef) => {
        const evidenceItemId = readResearchRefEvidenceItemId(sourceRef);
        const sourceId = readResearchRefSourceId(sourceRef);
        const catalogRef =
          (evidenceItemId ? sourceCatalogByEvidenceItemId.get(evidenceItemId) : null) ??
          (sourceId ? sourceCatalogBySourceId.get(sourceId) : null);

        if (
          typeof sourceRef !== "string" &&
          "sourceLabel" in sourceRef &&
          "sourceType" in sourceRef &&
          "excerpt" in sourceRef
        ) {
          return [
            {
              evidenceItemId:
                "evidenceItemId" in sourceRef && typeof sourceRef.evidenceItemId === "string"
                  ? sourceRef.evidenceItemId
                  : catalogRef?.evidenceItemId,
              sourceId: sourceRef.sourceId,
              sourceLabel: sourceRef.sourceLabel,
              sourceType: sourceRef.sourceType,
              title:
                "title" in sourceRef && typeof sourceRef.title === "string"
                  ? sourceRef.title
                  : catalogRef?.title,
              excerpt: toSentence(sourceRef.excerpt),
            },
          ];
        }

        if (!catalogRef) {
          return [];
        }

        return [
          {
            evidenceItemId: catalogRef.evidenceItemId,
            sourceId: catalogRef.sourceId,
            sourceLabel: catalogRef.sourceLabel,
            sourceType: catalogRef.sourceType,
            title: catalogRef.title,
            excerpt: toSentence(catalogRef.excerpt),
          },
        ];
      }),
      verificationNotes:
        [claim.missingInfo, claim.risksSummary].filter(Boolean).join(" ").trim() ||
        "Review wording against the cited source excerpts before approval.",
    },
  }));
}
