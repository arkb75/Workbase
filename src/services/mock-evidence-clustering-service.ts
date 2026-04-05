import type { EvidenceClusterDraft, EvidenceItemSnapshot } from "@/src/domain/types";
import type { EvidenceClusteringService } from "@/src/services/types";

const clusterHeuristics = [
  {
    theme: "dashboard",
    title: "Dashboard and product surface",
    keywords: ["dashboard", "ui", "search", "frontend", "annotat"],
  },
  {
    theme: "backend",
    title: "Backend and access control",
    keywords: ["api", "prisma", "postgres", "access", "role", "query"],
  },
  {
    theme: "data_pipeline",
    title: "Data ingestion and pipeline work",
    keywords: ["csv", "import", "ingest", "pipeline", "etl", "normalize"],
  },
  {
    theme: "reliability",
    title: "Testing and reliability",
    keywords: ["test", "reliability", "incident", "monitor", "fix"],
  },
];

function chooseClusterKey(item: EvidenceItemSnapshot) {
  const lowered = `${item.title} ${item.content}`.toLowerCase();
  const matched = clusterHeuristics.find((heuristic) =>
    heuristic.keywords.some((keyword) => lowered.includes(keyword)),
  );

  return matched?.theme ?? "general";
}

function buildClusterDraft(
  theme: string,
  evidenceItems: EvidenceItemSnapshot[],
): EvidenceClusterDraft {
  const heuristic = clusterHeuristics.find((item) => item.theme === theme);
  const title = heuristic?.title ?? "General implementation work";

  return {
    title,
    summary: evidenceItems
      .slice(0, 3)
      .map((item) => item.title)
      .join("; "),
    theme,
    confidence: evidenceItems.length >= 3 ? "high" : evidenceItems.length === 2 ? "medium" : "low",
    metadata: {
      strategy: "mock_keyword_grouping",
    },
    items: evidenceItems.map((item) => ({
      evidenceItemId: item.id,
      relevanceScore: 0.8,
    })),
  };
}

export const mockEvidenceClusteringService: EvidenceClusteringService = {
  async cluster({ evidenceItems }) {
    const grouped = new Map<string, EvidenceItemSnapshot[]>();

    for (const evidenceItem of evidenceItems) {
      const key = chooseClusterKey(evidenceItem);
      const group = grouped.get(key) ?? [];
      group.push(evidenceItem);
      grouped.set(key, group);
    }

    return {
      generationRunId: null,
      clusters: Array.from(grouped.entries()).map(([theme, items]) =>
        buildClusterDraft(theme, items),
      ),
    };
  },
};
