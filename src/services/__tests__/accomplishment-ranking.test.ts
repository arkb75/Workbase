import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeHit } from "@/src/domain/project-chat";
import {
  buildMemoryCatalog,
  rankAccomplishmentHits,
} from "@/src/services/project-chat-agent-service";

function hit(input: {
  id: string;
  subsystem: string;
  score: number;
  title?: string;
  kind?: "highlight" | "project_fact";
}): ProjectKnowledgeHit {
  const kind = input.kind ?? "project_fact";
  return {
    id: input.id,
    kind,
    authority: kind === "highlight" ? "verified_highlight" : "verified_project_fact",
    title: input.title ?? `Capability ${input.id}`,
    content: `Evidence-backed implementation for ${input.id}`,
    score: input.score,
    subsystemKey: input.subsystem,
    validatedThroughSha: "c".repeat(40),
    accomplishmentRanking: {
      evidenceStrength: input.score,
      productImportance: input.score,
      implementationBreadth: input.score,
      technicalDifficulty: input.score,
      ownershipAuthority: input.score,
      distinctiveness: input.score,
      freshness: input.score,
      impactBonus: 0,
      uncertainty: null,
    },
    citations: [],
  };
}

describe("accomplishment synthesis ranking", () => {
  it("prioritizes substantial work while preserving subsystem diversity", () => {
    const ranked = rankAccomplishmentHits([
      hit({ id: "core-1", subsystem: "ai_runtime", score: 5 }),
      hit({ id: "core-2", subsystem: "ai_runtime", score: 5 }),
      hit({ id: "core-3", subsystem: "ai_runtime", score: 5 }),
      hit({ id: "workflow", subsystem: "workflow_orchestration", score: 4 }),
      hit({ id: "retrieval", subsystem: "retrieval_provenance", score: 4 }),
      hit({ id: "utility", subsystem: "demo_utility", score: 1 }),
    ], 5);

    // High-importance capabilities from distinct subsystems must be represented
    // before a second, redundant item from the same subsystem.
    expect(ranked.slice(0, 2).map((entry) => entry.id)).toEqual(["workflow", "core-1"]);
    expect(ranked.filter((entry) => entry.subsystemKey === "ai_runtime")).toHaveLength(2);
    expect(ranked.map((entry) => entry.id)).toContain("workflow");
    expect(ranked.map((entry) => entry.id)).toContain("retrieval");
    expect(ranked.at(-1)?.id).toBe("utility");
  });

  it("excludes repository facts that are not validated through a commit", () => {
    const unvalidated = hit({ id: "unvalidated", subsystem: "domain_data", score: 5 });
    unvalidated.validatedThroughSha = null;
    expect(rankAccomplishmentHits([unvalidated], 3)).toEqual([]);
  });

  it("keeps narrow module facts out when broad project coverage is available", () => {
    const broad = [
      "product_surface",
      "repository_knowledge_lifecycle",
      "project_chat_grounding",
      "artifact_generation",
      "knowledge_review_lifecycle",
      "workflow_orchestration",
      "ai_runtime",
    ].map((subsystem, index) => hit({
      id: `broad-${index + 1}`,
      subsystem,
      score: 4,
    }));
    const moduleFact = hit({ id: "module-helper", subsystem: "module:whitespace-helper", score: 5 });

    const ranked = rankAccomplishmentHits([...broad, moduleFact], 10);
    expect(ranked).toHaveLength(7);
    expect(ranked.map((entry) => entry.id)).not.toContain("module-helper");
  });

  it("reserves explicit self-reported ownership evidence before ordinary evidence", () => {
    const ordinaryEvidence: ProjectKnowledgeHit[] = Array.from({ length: 6 }, (_, index) => ({
      id: `commit-${index + 1}`,
      kind: "evidence",
      authority: "included_evidence",
      title: `Commit ${index + 1}`,
      content: `Repository commit ${index + 1}`,
      score: 100 - index,
      ownershipAuthority: 0,
      citations: [{
        kind: "evidence",
        label: `Commit ${index + 1}`,
        excerpt: `Repository commit ${index + 1}`,
        evidenceItemId: `commit-${index + 1}`,
      }],
    }));
    const selfReport: ProjectKnowledgeHit = {
      id: "work-item-description",
      kind: "evidence",
      authority: "included_evidence",
      title: "Work Item description",
      content: "Built Workbase as a full-stack career content platform.",
      score: 1,
      ownershipAuthority: 3,
      citations: [{
        kind: "evidence",
        label: "Work Item description",
        excerpt: "Built Workbase as a full-stack career content platform.",
        evidenceItemId: "work-item-description",
      }],
    };

    const catalog = buildMemoryCatalog({
      hits: [...ordinaryEvidence, selfReport],
      query: "Summarize my strongest accomplishments and make sure your information is up to date",
    });
    expect(catalog.selectedHits.map((entry) => entry.id)).toContain("work-item-description");
    expect(catalog.entries.find((entry) => entry.title === "Work Item description")?.ownershipAuthority).toBe(3);
  });
});
