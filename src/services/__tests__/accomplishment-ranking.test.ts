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
  content?: string;
  kind?: "highlight" | "project_fact";
}): ProjectKnowledgeHit {
  const kind = input.kind ?? "project_fact";
  return {
    id: input.id,
    kind,
    authority: kind === "highlight" ? "verified_highlight" : "verified_project_fact",
    title: input.title ?? `Capability ${input.id}`,
    content: input.content ?? `Evidence-backed implementation for ${input.id}`,
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

  it("selects one top-level subsystem representative before an extra member", () => {
    const ranked = rankAccomplishmentHits([
      hit({ id: "artifact-primary", subsystem: "artifact_generation", score: 5 }),
      hit({ id: "artifact-extra", subsystem: "artifact_generation", score: 5 }),
      hit({ id: "product-representative", subsystem: "product_surface", score: 1 }),
    ], 2);

    expect(ranked.map((entry) => entry.id)).toEqual([
      "product-representative",
      "artifact-primary",
    ]);
  });

  it.each([
    {
      subsystem: "ingestion_integrations",
      broadTitle: "Implemented GitHub OAuth repository import",
      broadContent: "GitHub OAuth connect and callback routes authorize bounded repository source imports.",
      narrowTitle: "Added an internal byte-budget counter",
    },
    {
      subsystem: "domain_data",
      broadTitle: "Designed the Prisma and PostgreSQL data model",
      broadContent: "The Prisma schema persists normalized application state in Neon PostgreSQL.",
      narrowTitle: "Versioned one capability-ledger column",
    },
    {
      subsystem: "review_ui",
      broadTitle: "Built the project workspace user interface",
      broadContent: "The project workspace provides chat, source, review, artifact, citation, and progress views.",
      narrowTitle: "Rendered a citation popover",
    },
    {
      subsystem: "tests_operations",
      broadTitle: "Built broad automated Vitest coverage",
      broadContent: "Automated unit, integration, workflow, and UI tests run through the Vitest test suite.",
      narrowTitle: "Designed a three-tier semantic fallback",
    },
  ])("chooses broad $subsystem coverage before a higher-ranked narrow implementation detail", ({
    subsystem,
    broadTitle,
    broadContent,
    narrowTitle,
  }) => {
    const ranked = rankAccomplishmentHits([
      hit({ id: "narrow", subsystem, score: 5, title: narrowTitle }),
      hit({ id: "broad", subsystem, score: 3, title: broadTitle, content: broadContent }),
    ], 1);

    expect(ranked.map((entry) => entry.id)).toEqual(["broad"]);
  });

  it("preserves broad representatives before the 12-item accomplishment catalog is pruned", () => {
    const subsystems = [
      "product_surface",
      "repository_knowledge_lifecycle",
      "project_chat_grounding",
      "artifact_generation",
      "knowledge_review_lifecycle",
      "workflow_orchestration",
      "ai_runtime",
      "retrieval_provenance",
      "ingestion_integrations",
      "domain_data",
      "review_ui",
      "tests_operations",
    ];
    const broadBySubsystem: Record<string, { title: string; content: string }> = {
      ingestion_integrations: {
        title: "Implemented GitHub OAuth repository import",
        content: "GitHub OAuth connect and callback routes authorize bounded repository source imports.",
      },
      domain_data: {
        title: "Designed the Prisma and PostgreSQL data model",
        content: "The Prisma schema persists normalized application state in Neon PostgreSQL.",
      },
      review_ui: {
        title: "Built the project workspace user interface",
        content: "The project workspace provides chat, source, review, artifact, citation, and progress views.",
      },
      tests_operations: {
        title: "Built broad automated Vitest coverage",
        content: "Automated unit, integration, workflow, and UI tests run through the Vitest test suite.",
      },
    };
    const hits = subsystems.flatMap((subsystem, index) => {
      const broad = broadBySubsystem[subsystem] ?? {
        title: `Broad ${subsystem} capability`,
        content: `Broad evidence-backed ${subsystem} implementation.`,
      };
      return [
        hit({ id: `narrow-${index}`, subsystem, score: 5, title: `Narrow ${subsystem} detail` }),
        hit({ id: `broad-${index}`, subsystem, score: 3, title: broad.title, content: broad.content }),
      ];
    });

    const catalog = buildMemoryCatalog({
      hits,
      query: "Summarize my strongest accomplishments and make sure your information is up to date",
    });

    for (const subsystem of Object.keys(broadBySubsystem)) {
      expect(catalog.selectedHits.some((entry) =>
        entry.subsystemKey === subsystem && entry.title === broadBySubsystem[subsystem]!.title
      )).toBe(true);
    }
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
