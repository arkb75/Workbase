import { z } from "zod";

export const PROJECT_CHAT_CLAIM_LEDGER_VERSION = "project-chat-claim-ledger-v1";

export const projectChatClaimSupportSchema = z.enum([
  "direct",
  "synthesis",
  "reasonable_inference",
  "ambiguous",
  "unfounded",
  "contradicted",
  "misleading",
]);

export const projectChatClaimActionSchema = z.enum([
  "keep_direct",
  "keep_synthesis",
  "keep_inference",
  "qualify",
  "repair_citation",
  "research",
  "remove_unfounded",
  "remove_contradicted",
  "remove_misleading",
]);

export const projectChatClaimLedgerEntrySchema = z.object({
  id: z.string().regex(/^claim_[1-9]\d*$/).max(30),
  quote: z.string().trim().min(1).max(1_200),
  centrality: z.enum(["central", "supporting"]),
  support: projectChatClaimSupportSchema,
  action: projectChatClaimActionSchema,
  citationIndexes: z.array(z.number().int().positive()).max(20),
  missingOrContradictedPremise: z.string().trim().min(1).max(700).nullable(),
  rationale: z.string().trim().min(1).max(700),
  confidence: z.enum(["low", "medium", "high"]),
});

export const projectChatClaimLedgerSchema = z.object({
  version: z.literal(PROJECT_CHAT_CLAIM_LEDGER_VERSION),
  entries: z.array(projectChatClaimLedgerEntrySchema).max(40),
});

export type ProjectChatClaimLedgerEntry = z.infer<
  typeof projectChatClaimLedgerEntrySchema
>;
export type ProjectChatClaimLedger = z.infer<typeof projectChatClaimLedgerSchema>;

const KEEP_ACTIONS = new Set<ProjectChatClaimLedgerEntry["action"]>([
  "keep_direct",
  "keep_synthesis",
  "keep_inference",
]);

const REMOVE_ACTIONS = new Set<ProjectChatClaimLedgerEntry["action"]>([
  "remove_unfounded",
  "remove_contradicted",
  "remove_misleading",
]);

export function claimActionKeepsAsWritten(
  action: ProjectChatClaimLedgerEntry["action"],
) {
  return KEEP_ACTIONS.has(action);
}

export function claimActionRemoves(
  action: ProjectChatClaimLedgerEntry["action"],
) {
  return REMOVE_ACTIONS.has(action);
}

export function claimLedgerHasUsefulContent(ledger: ProjectChatClaimLedger) {
  return ledger.entries.some((entry) =>
    !claimActionRemoves(entry.action) && entry.action !== "research"
  );
}

export function claimLedgerNeedsResearch(ledger: ProjectChatClaimLedger) {
  return ledger.entries.some((entry) => entry.action === "research");
}

export function claimLedgerNeedsRevision(ledger: ProjectChatClaimLedger) {
  return ledger.entries.some((entry) => !claimActionKeepsAsWritten(entry.action));
}

export function claimLedgerHasGaps(ledger: ProjectChatClaimLedger) {
  return ledger.entries.some((entry) =>
    [
      "qualify",
      "research",
      "remove_unfounded",
      "remove_contradicted",
      "remove_misleading",
    ].includes(entry.action)
  );
}

export function claimLedgerCoverageGaps(ledger: ProjectChatClaimLedger) {
  return ledger.entries.flatMap((entry) =>
    ["qualify", "research", "remove_unfounded", "remove_contradicted", "remove_misleading"]
        .includes(entry.action)
      ? [entry.missingOrContradictedPremise ?? entry.rationale]
      : []
  );
}

export function claimLedgerValidationIssues(ledger: ProjectChatClaimLedger) {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const entry of ledger.entries) {
    if (ids.has(entry.id)) issues.push(`Claim ledger ID ${entry.id} is duplicated.`);
    ids.add(entry.id);
    if (
      claimActionRemoves(entry.action) && entry.confidence !== "high"
    ) {
      issues.push(`Removing ${entry.id} requires high confidence.`);
    }
    if (
      ["ambiguous", "unfounded", "contradicted", "misleading"].includes(
        entry.support,
      ) && !entry.missingOrContradictedPremise
    ) {
      issues.push(
        `${entry.id} must identify the missing or contradicted premise.`,
      );
    }
    if (entry.action === "research" && entry.centrality !== "central") {
      issues.push(`Research is reserved for central claims (${entry.id}).`);
    }
    const validPair = (
      (entry.support === "direct" && ["keep_direct", "repair_citation"].includes(entry.action)) ||
      (entry.support === "synthesis" && ["keep_synthesis", "repair_citation"].includes(entry.action)) ||
      (entry.support === "reasonable_inference" && ["keep_inference", "qualify", "repair_citation"].includes(entry.action)) ||
      (entry.support === "ambiguous" && ["qualify", "research"].includes(entry.action)) ||
      (entry.support === "unfounded" && entry.action === "remove_unfounded") ||
      (entry.support === "contradicted" && entry.action === "remove_contradicted") ||
      (entry.support === "misleading" && entry.action === "remove_misleading")
    );
    if (!validPair) {
      issues.push(
        `${entry.id} has incompatible support ${entry.support} and action ${entry.action}.`,
      );
    }
  }
  return issues;
}

function citationMarkers(indexes: number[]) {
  return Array.from(new Set(indexes)).map((index) => `[citation:${index}]`).join(" ");
}

/**
 * Last-resort publication from the audited ledger. The normal path remains a
 * model-authored projection; this prevents a provider failure during that
 * projection from discarding claims the verifier already approved.
 */
export function supportedClaimLedgerAnswer(ledger: ProjectChatClaimLedger) {
  const surviving = ledger.entries.filter((entry) =>
    claimActionKeepsAsWritten(entry.action) ||
    (entry.action === "qualify" && entry.support === "reasonable_inference")
  );
  if (!surviving.length) return null;
  return surviving.map((entry) => {
    const quote = entry.quote
      .replace(/\[citation:[^\]]*\]/gi, "")
      .trim();
    const prefix = entry.action === "keep_inference"
      ? "Reasonable inference: "
      : entry.action === "qualify"
        ? "Based on the inspected evidence: "
        : "";
    const citations = citationMarkers(entry.citationIndexes);
    return `- ${prefix}${quote}${citations ? ` ${citations}` : ""}`;
  }).join("\n");
}
