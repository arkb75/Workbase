import type {
  ClaimDraft,
  ClaimSnapshot,
  EvidenceItemSnapshot,
  JsonValue,
  NormalizedEvidenceItem,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";
import { explicitSelfReportedOwnershipAuthority } from "@/src/services/evidence-ownership-authority";
import { USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION } from "@/src/lib/evidence-items";

export const MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION =
  "manual-evidence-extractive-v1" as const;

const ownershipOpeningPattern =
  /^(?:I\s+)?(?:architected|automated|built|created|delivered|designed|developed|drove|established|implemented|improved|integrated|introduced|launched|led|migrated|optimized|owned|preserved|reduced|shipped)\b/iu;
const semanticSensitivityPattern =
  /\b(?:confidential|customer data|internal only|private dataset|restricted|secret|sensitive)\b/iu;
const unsafeAutomaticQuantifierPattern =
  /\b(?:all|always|entire(?:ly)?|every|exclusively|first|fully|guarantee(?:d|s)?|halved|largest|million|never|only|sole(?:ly)?|single[- ]handedly|tripled|twice|zero)\b|\b(?:10x|100\s*%)\b|\p{N}/iu;

type RedactionAccumulator = Set<string>;

function isSecretMetadataKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "accesstoken",
    "apikey",
    "authtoken",
    "authorization",
    "clientsecret",
    "connectionstring",
    "databaseurl",
    "dsn",
    "password",
    "passwd",
    "privatekey",
    "refreshtoken",
    "secret",
    "secretaccesskey",
    "secretkey",
    "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function redactString(value: string, categories: RedactionAccumulator) {
  const result = redactRepositorySecrets(value);
  result.categories.forEach((category) => categories.add(category));
  return result.content;
}

function redactJsonValue(
  value: JsonValue | null,
  categories: RedactionAccumulator,
): JsonValue | null {
  if (typeof value === "string") return redactString(value, categories);
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, categories));
  }
  const output: Record<string, JsonValue | null> = {};
  Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, entry], index) => {
      const redactedKey = redactString(key, categories);
      const uniqueKey = Object.hasOwn(output, redactedKey)
        ? `${redactedKey} [${index + 1}]`
        : redactedKey;
      if (isSecretMetadataKey(key)) {
        categories.add("assigned_secret");
        output[uniqueKey] = "[REDACTED ASSIGNED SECRET]";
      } else {
        output[uniqueKey] = redactJsonValue(entry, categories);
      }
    });
  return output;
}

function evidencePromptStrings(item: EvidenceItemSnapshot) {
  return [
    item.title,
    item.content,
    item.searchText,
    item.source.label,
    item.source.externalId ?? "",
    JSON.stringify(item.metadata ?? null),
    JSON.stringify(item.source.metadata ?? null),
  ];
}

export function manualEvidenceDlpCategories(item: EvidenceItemSnapshot) {
  const categories = new Set<string>();
  evidencePromptStrings(item).forEach((value) => {
    redactRepositorySecrets(value).categories.forEach((category) =>
      categories.add(category),
    );
  });
  return [...categories].sort();
}

export function sanitizeManualProviderContext(input: {
  workItem: WorkItemSnapshot;
  sources: SourceSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  existingHighlights: ClaimSnapshot[];
}) {
  const globalCategories = new Set<string>();
  const evidenceDlpCategories = new Map<string, string[]>();
  const workItem = {
    ...input.workItem,
    title: redactString(input.workItem.title, globalCategories),
    description: redactString(input.workItem.description, globalCategories),
  };
  const workItemDlpCategories = [...globalCategories].sort();
  const sources = input.sources.map((source) => {
    const categories = new Set<string>();
    const sanitized = {
      ...source,
      label: redactString(source.label, categories),
      rawContent:
        source.rawContent == null
          ? null
          : redactString(source.rawContent, categories),
      metadata: redactJsonValue(source.metadata ?? null, categories),
    };
    categories.forEach((category) => globalCategories.add(category));
    return sanitized;
  });
  const evidenceItems = input.evidenceItems.map((item) => {
    const categories = new Set<string>(manualEvidenceDlpCategories(item));
    const sanitized = {
      ...item,
      title: redactString(item.title, categories),
      content: redactString(item.content, categories),
      searchText: redactString(item.searchText, categories),
      metadata: redactJsonValue(item.metadata ?? null, categories),
      source: {
        ...item.source,
        label: redactString(item.source.label, categories),
        externalId:
          item.source.externalId == null
            ? null
            : redactString(item.source.externalId, categories),
        metadata: redactJsonValue(item.source.metadata ?? null, categories),
      },
    };
    const sorted = [...categories].sort();
    if (sorted.length) evidenceDlpCategories.set(item.id, sorted);
    return sanitized;
  });
  const existingHighlights = input.existingHighlights.map((highlight) => {
    const categories = new Set<string>();
    const sanitized: ClaimSnapshot = {
      ...highlight,
      text: redactString(highlight.text, categories),
      summary: redactString(highlight.summary, categories),
      risksSummary:
        highlight.risksSummary == null
          ? null
          : redactString(highlight.risksSummary, categories),
      missingInfo:
        highlight.missingInfo == null
          ? null
          : redactString(highlight.missingInfo, categories),
      rejectionReason:
        highlight.rejectionReason == null
          ? null
          : redactString(highlight.rejectionReason, categories),
      verificationNotes:
        highlight.verificationNotes == null
          ? null
          : redactString(highlight.verificationNotes, categories),
      metadata: redactJsonValue(highlight.metadata ?? null, categories),
      evidence: {
        ...highlight.evidence,
        summary: redactString(highlight.evidence.summary, categories),
        verificationNotes:
          highlight.evidence.verificationNotes == null
            ? null
            : redactString(
                highlight.evidence.verificationNotes,
                categories,
              ),
        sourceRefs: highlight.evidence.sourceRefs.map((reference) => ({
          ...reference,
          sourceLabel: redactString(reference.sourceLabel, categories),
          title:
            reference.title == null
              ? undefined
              : redactString(reference.title, categories),
          excerpt: redactString(reference.excerpt, categories),
        })),
      },
    };
    categories.forEach((category) => globalCategories.add(category));
    return sanitized;
  });
  return {
    workItem,
    sources,
    evidenceItems,
    existingHighlights,
    evidenceDlpCategories,
    workItemDlpCategories,
  };
}

export function sanitizeNormalizedManualEvidence(input: {
  evidenceItems: NormalizedEvidenceItem[];
  evidenceDlpCategories: ReadonlyMap<string, string[]>;
}) {
  return input.evidenceItems.map((item) => {
    const categories = input.evidenceDlpCategories.get(item.id) ?? [];
    return {
      ...item,
      metadata: {
        ...(item.metadata &&
        typeof item.metadata === "object" &&
        !Array.isArray(item.metadata)
          ? item.metadata
          : {}),
        ...(categories.length
          ? {
              manualDlpRedacted: true,
              manualDlpCategories: categories,
            }
          : {}),
      },
    };
  });
}

function isSystemOwnedDescription(item: EvidenceItemSnapshot) {
  return Boolean(
    item.metadata &&
      typeof item.metadata === "object" &&
      !Array.isArray(item.metadata) &&
      "kind" in item.metadata &&
      item.metadata.kind === "work_item_description",
  );
}

function exactSentenceExcerpts(value: string) {
  return Array.from(value.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu))
    .map((match) => match[0].trim())
    .filter(Boolean);
}

function isSafeExtractiveEvidence(item: EvidenceItemSnapshot) {
  return (
    item.type === "manual_note_excerpt" &&
    item.source.type === "manual_note" &&
    item.included &&
    item.lifecycleStatus === "active" &&
    item.reviewState !== "reverted" &&
    explicitSelfReportedOwnershipAuthority({
      type: item.type,
      content: item.content,
      externalId: item.externalId,
      parentKind: item.parentKind,
      parentKey: item.parentKey,
      metadata: item.metadata,
      source: {
        externalId: item.source.externalId,
        metadata: item.source.metadata,
      },
    }) >= 3 &&
    !semanticSensitivityPattern.test(item.content) &&
    manualEvidenceDlpCategories(item).length === 0
  );
}

function isSafeExtractiveStatement(
  item: EvidenceItemSnapshot,
  text: string,
) {
  return (
    text.length >= 24 &&
    text.length <= 240 &&
    !text.includes("\n") &&
    explicitSelfReportedOwnershipAuthority({
      type: item.type,
      content: text,
      externalId: item.externalId,
      parentKind: item.parentKind,
      parentKey: item.parentKey,
      metadata: item.metadata,
      source: {
        externalId: item.source.externalId,
        metadata: item.source.metadata,
      },
    }) >= 3 &&
    ownershipOpeningPattern.test(text) &&
    !semanticSensitivityPattern.test(text) &&
    !unsafeAutomaticQuantifierPattern.test(text)
  );
}

export function buildExactManualEvidenceFallback(input: {
  evidenceItems: EvidenceItemSnapshot[];
}) {
  const candidate = [...input.evidenceItems]
    .filter(isSafeExtractiveEvidence)
    .sort((left, right) => {
      const ownershipOrder =
        Number(isSystemOwnedDescription(left)) -
        Number(isSystemOwnedDescription(right));
      return ownershipOrder || left.externalId.localeCompare(right.externalId);
    })
    .flatMap((item) =>
      exactSentenceExcerpts(item.content).flatMap((text) =>
        isSafeExtractiveStatement(item, text) ? [{ item, text }] : []
      )
    )[0];
  if (!candidate) return null;
  const { item, text } = candidate;
  const fallback = {
    text,
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    summary: text,
    verificationNotes:
      `Exact user-authored manual Evidence accepted by ${MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION}; no model-authored wording was promoted.`,
    metadata: {
      generationStrategy: "exact_manual_evidence_fallback",
      extractivePolicyVersion: MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION,
      ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
      evidenceItemId: item.id,
    },
    evidence: {
      summary: text,
      verificationNotes:
        "The Highlight text is an exact user-authored Evidence excerpt.",
      sourceRefs: [
        {
          evidenceItemId: item.id,
          sourceId: item.sourceId,
          sourceLabel: item.source.label,
          sourceType: item.source.type,
          title: item.title,
          excerpt: text,
        },
      ],
    },
    tags: inferHighlightTags({
      text,
      summary: text,
      verificationNotes:
        "Exact user-authored manual Evidence extract for private review.",
    }),
  } satisfies ClaimDraft;
  return fallback;
}

export function markDraftsCitingRedactedEvidence(input: {
  drafts: ClaimDraft[];
  evidenceDlpCategories: ReadonlyMap<string, string[]>;
  workItemDlpCategories: string[];
}) {
  return input.drafts.map((draft) => {
    const citedCategories = Array.from(
      new Set(
        draft.evidence.sourceRefs.flatMap((reference) =>
          reference.evidenceItemId
            ? input.evidenceDlpCategories.get(reference.evidenceItemId) ?? []
            : [],
        ),
      ),
    ).sort();
    const categories = Array.from(
      new Set([...input.workItemDlpCategories, ...citedCategories]),
    ).sort();
    if (!categories.length) return draft;
    return {
      ...draft,
      sensitivityFlag: true,
      verificationStatus: "flagged",
      visibility: "private",
      risksSummary: [
        draft.risksSummary,
        "Provider-facing manual Evidence was redacted by the deterministic DLP gate.",
      ]
        .filter(Boolean)
        .join(" "),
      metadata: {
        ...(draft.metadata &&
        typeof draft.metadata === "object" &&
        !Array.isArray(draft.metadata)
          ? draft.metadata
          : {}),
        manualDlpCategories: categories,
      },
    } satisfies ClaimDraft;
  });
}
