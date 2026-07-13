function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface OwnershipEvidenceDescriptor {
  type: string;
  metadata: unknown;
  source: { metadata?: unknown };
}

/**
 * Repository evidence proves implementation, not who performed it. Only
 * explicit, user-authored project descriptions and chat statements establish
 * private-chat ownership authority without an approved Highlight.
 */
export function explicitSelfReportedOwnershipAuthority(item: OwnershipEvidenceDescriptor) {
  if (item.type === "chat_user_statement") return 3;
  if (item.type !== "manual_note_excerpt") return 0;
  return objectValue(item.metadata)?.kind === "work_item_description" ||
    objectValue(item.source.metadata)?.kind === "work_item_description"
    ? 3
    : 0;
}
