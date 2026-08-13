import {
  isExplicitUserAuthoredManualNoteMetadata,
  isExplicitUserAuthoredManualNoteSourceMetadata,
} from "@/src/lib/evidence-items";

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isWorkItemDescriptionMetadata(value: unknown) {
  const record = objectValue(value);
  return record?.kind === "work_item_description" && record.systemOwned === true;
}

export interface OwnershipEvidenceDescriptor {
  type: string;
  content?: string;
  externalId?: string;
  parentKind?: string | null;
  parentKey?: string | null;
  metadata: unknown;
  source: { externalId?: string | null; metadata?: unknown };
}

const explicitManualSelfReportPattern =
  /^(?:I\s+)?(?:architected|automated|built|created|delivered|designed|developed|drove|established|implemented|improved|integrated|introduced|launched|led|migrated|optimized|owned|preserved|reduced|shipped)\b/iu;
const passiveThirdPartyPattern =
  /\b(?:architected|automated|built|created|delivered|designed|developed|driven|established|implemented|improved|integrated|introduced|launched|led|migrated|optimized|owned|preserved|reduced|shipped)\s+by\b/iu;

/**
 * Repository evidence proves implementation, not who performed it. Only
 * explicit, user-authored project descriptions, source-note excerpts, and
 * chat statements establish private-chat ownership authority without an
 * approved Highlight. Generic or legacy manual evidence remains untrusted
 * unless ingestion recorded its user-authored origin explicitly.
 */
export function explicitSelfReportedOwnershipAuthority(item: OwnershipEvidenceDescriptor) {
  if (item.type === "chat_user_statement") return 3;
  if (item.type !== "manual_note_excerpt") return 0;
  if (
    typeof item.content === "string" &&
    passiveThirdPartyPattern.test(item.content.trim())
  ) {
    return 0;
  }
  const explicitUserNote =
    isExplicitUserAuthoredManualNoteMetadata(item.metadata) &&
    isExplicitUserAuthoredManualNoteSourceMetadata(item.source.metadata) &&
    typeof item.content === "string" &&
    explicitManualSelfReportPattern.test(item.content.trim()) &&
    !passiveThirdPartyPattern.test(item.content.trim());
  const workItemDescription =
    isWorkItemDescriptionMetadata(item.metadata) &&
    isWorkItemDescriptionMetadata(item.source.metadata) &&
    item.parentKind === "work_item" &&
    typeof item.parentKey === "string" &&
    item.externalId === `${item.parentKey}:work-item-description` &&
    item.source.externalId === `${item.parentKey}:work-item-description-source`;
  return workItemDescription || explicitUserNote
    ? 3
    : 0;
}
