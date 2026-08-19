export const HIGHLIGHT_OVERVIEW_LIMIT = 48;

export const highlightWorkspaceStatuses = [
  "needs_review",
  "approved",
  "lifecycle",
  "rejected",
] as const;

export type HighlightWorkspaceStatus =
  (typeof highlightWorkspaceStatuses)[number];

export type HighlightWorkspaceFilter = HighlightWorkspaceStatus | "all";

export type HighlightWorkspaceSourceRef = {
  evidenceItemId: string;
  sourceId: string;
  sourceLabel: string;
  sourceType: string;
  title: string;
  excerpt: string;
};

export type HighlightWorkspaceItem = {
  id: string;
  workItemId: string;
  text: string;
  summary: string;
  confidence: string;
  ownershipClarity: string;
  sensitivityFlag: boolean;
  verificationStatus: string;
  lifecycleStatus: string;
  reviewState: string;
  visibility: string;
  risksSummary: string | null;
  missingInfo: string | null;
  rejectionReason: string | null;
  verificationNotes: string | null;
  evidence: {
    summary: string;
    verificationNotes: string | null;
    sourceRefs: HighlightWorkspaceSourceRef[];
  };
  tags: Array<{
    dimension: string;
    tag: string;
    score: number | null;
  }>;
};

export type HighlightThemeGroup = {
  key: string;
  label: string;
  items: HighlightWorkspaceItem[];
};

export type HighlightAtlasCluster = HighlightThemeGroup & {
  color: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  hiddenCount: number;
};

export type HighlightAtlasNode = {
  item: HighlightWorkspaceItem;
  clusterKey: string;
  status: HighlightWorkspaceStatus;
  x: number;
  y: number;
};

export type HighlightAtlasEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  reason: string;
};

export type HighlightCoverageRow = HighlightThemeGroup & {
  cells: Record<HighlightWorkspaceStatus, HighlightWorkspaceItem[]>;
};

const dimensionPriority = [
  "domain",
  "competency",
  "emphasis",
  "audience_fit",
] as const;

const statusPriority: Record<HighlightWorkspaceStatus, number> = {
  needs_review: 0,
  lifecycle: 1,
  approved: 2,
  rejected: 3,
};

const clusterColors = [
  "#4fd1c5",
  "#7dd3fc",
  "#a5b4fc",
  "#86efac",
  "#fbbf24",
  "#f0abfc",
] as const;

type AtlasSlot = {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
};

const atlasLayouts: Record<number, AtlasSlot[]> = {
  1: [{ x: 50, y: 50, radiusX: 38, radiusY: 36 }],
  2: [
    { x: 25, y: 50, radiusX: 22, radiusY: 38 },
    { x: 75, y: 50, radiusX: 22, radiusY: 38 },
  ],
  3: [
    { x: 25, y: 31, radiusX: 22, radiusY: 25 },
    { x: 75, y: 31, radiusX: 22, radiusY: 25 },
    { x: 50, y: 75, radiusX: 27, radiusY: 20 },
  ],
  4: [
    { x: 25, y: 29, radiusX: 22, radiusY: 24 },
    { x: 75, y: 29, radiusX: 22, radiusY: 24 },
    { x: 25, y: 76, radiusX: 22, radiusY: 20 },
    { x: 75, y: 76, radiusX: 22, radiusY: 20 },
  ],
  5: [
    { x: 17, y: 29, radiusX: 15, radiusY: 24 },
    { x: 50, y: 29, radiusX: 15, radiusY: 24 },
    { x: 83, y: 29, radiusX: 15, radiusY: 24 },
    { x: 31, y: 76, radiusX: 21, radiusY: 20 },
    { x: 69, y: 76, radiusX: 21, radiusY: 20 },
  ],
  6: [
    { x: 17, y: 29, radiusX: 15, radiusY: 24 },
    { x: 50, y: 29, radiusX: 15, radiusY: 24 },
    { x: 83, y: 29, radiusX: 15, radiusY: 24 },
    { x: 17, y: 76, radiusX: 15, radiusY: 20 },
    { x: 50, y: 76, radiusX: 15, radiusY: 20 },
    { x: 83, y: 76, radiusX: 15, radiusY: 20 },
  ],
};

const localNodeLayouts: Record<number, Array<{ x: number; y: number }>> = {
  1: [{ x: 0, y: 0 }],
  2: [
    { x: -9, y: 0 },
    { x: 9, y: 0 },
  ],
  3: [
    { x: 0, y: -8 },
    { x: -9, y: 7 },
    { x: 9, y: 7 },
  ],
  4: [
    { x: -9, y: -7 },
    { x: 9, y: -7 },
    { x: -9, y: 7 },
    { x: 9, y: 7 },
  ],
  5: [
    { x: 0, y: -9 },
    { x: -10, y: 0 },
    { x: 10, y: 0 },
    { x: -7, y: 9 },
    { x: 7, y: 9 },
  ],
};

function humanize(value: string) {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function compareItems(left: HighlightWorkspaceItem, right: HighlightWorkspaceItem) {
  const statusDelta =
    statusPriority[getHighlightWorkspaceStatus(left)] -
    statusPriority[getHighlightWorkspaceStatus(right)];
  if (statusDelta) return statusDelta;

  const confidence = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const confidenceDelta =
    (confidence[left.confidence] ?? 3) - (confidence[right.confidence] ?? 3);
  return confidenceDelta || left.id.localeCompare(right.id);
}

function primaryTheme(item: HighlightWorkspaceItem) {
  for (const dimension of dimensionPriority) {
    const candidates = item.tags
      .filter((tag) => tag.dimension === dimension && tag.tag.trim())
      .sort(
        (left, right) =>
          (right.score ?? Number.NEGATIVE_INFINITY) -
            (left.score ?? Number.NEGATIVE_INFINITY) ||
          left.tag.localeCompare(right.tag),
      );
    const primary = candidates[0];
    if (primary) {
      return {
        key: `${dimension}:${normalizeKey(primary.tag)}`,
        label: humanize(primary.tag),
      };
    }
  }

  return { key: "uncategorized", label: "Uncategorized" };
}

export function getHighlightWorkspaceStatus(
  item: Pick<
    HighlightWorkspaceItem,
    "lifecycleStatus" | "verificationStatus" | "reviewState"
  >,
): HighlightWorkspaceStatus {
  if (item.lifecycleStatus !== "active") return "lifecycle";
  if (item.verificationStatus === "rejected") return "rejected";
  if (
    item.reviewState === "pending_review" ||
    item.verificationStatus === "draft" ||
    item.verificationStatus === "flagged"
  ) {
    return "needs_review";
  }

  return item.verificationStatus === "approved" ? "approved" : "needs_review";
}

export function highlightMatchesFilter(
  item: HighlightWorkspaceItem,
  filter: HighlightWorkspaceFilter,
) {
  return filter === "all" || getHighlightWorkspaceStatus(item) === filter;
}

export function groupHighlightsByTheme(
  items: HighlightWorkspaceItem[],
): HighlightThemeGroup[] {
  const groups = new Map<string, HighlightThemeGroup>();

  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    const theme = primaryTheme(item);
    const group = groups.get(theme.key) ?? { ...theme, items: [] };
    group.items.push(item);
    groups.set(theme.key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, items: [...group.items].sort(compareItems) }))
    .sort(
      (left, right) =>
        right.items.length - left.items.length || left.label.localeCompare(right.label),
    );
}

function atlasGroups(items: HighlightWorkspaceItem[]) {
  const groups = groupHighlightsByTheme(items);
  if (groups.length <= 6) return groups;

  const visibleGroups = groups.slice(0, 5);
  const overflowItems = groups
    .slice(5)
    .flatMap((group) => group.items)
    .sort(compareItems);

  return [
    ...visibleGroups,
    { key: "other-signals", label: "Other signals", items: overflowItems },
  ];
}

function sharedRelationship(
  left: HighlightWorkspaceItem,
  right: HighlightWorkspaceItem,
) {
  const rightEvidenceIds = new Set(
    right.evidence.sourceRefs.map((reference) => reference.evidenceItemId),
  );
  const sharedEvidence = left.evidence.sourceRefs.find((reference) =>
    rightEvidenceIds.has(reference.evidenceItemId),
  );

  const rightTags = new Set(
    right.tags.map((tag) => `${tag.dimension}:${tag.tag.toLowerCase()}`),
  );
  const sharedTag = [...left.tags]
    .sort((a, b) => a.tag.localeCompare(b.tag))
    .find((tag) => rightTags.has(`${tag.dimension}:${tag.tag.toLowerCase()}`));

  if (!sharedEvidence && !sharedTag) return null;

  const reasons = [
    sharedEvidence ? `shared evidence from ${sharedEvidence.sourceLabel}` : null,
    sharedTag ? `shared ${humanize(sharedTag.tag)} tag` : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    score: (sharedEvidence ? 4 : 0) + (sharedTag ? 1 : 0),
    reason: reasons.join(" and "),
  };
}

function buildEdges(nodes: HighlightAtlasNode[]): HighlightAtlasEdge[] {
  const candidates: Array<HighlightAtlasEdge & { score: number }> = [];

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const relationship = sharedRelationship(left.item, right.item);
      if (!relationship) continue;

      candidates.push({
        id: `${left.item.id}:${right.item.id}`,
        sourceId: left.item.id,
        targetId: right.item.id,
        reason: relationship.reason,
        score: relationship.score,
      });
    }
  }

  const degrees = new Map<string, number>();
  return candidates
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .flatMap((candidate) => {
      const edge: HighlightAtlasEdge = {
        id: candidate.id,
        sourceId: candidate.sourceId,
        targetId: candidate.targetId,
        reason: candidate.reason,
      };
      const sourceDegree = degrees.get(edge.sourceId) ?? 0;
      const targetDegree = degrees.get(edge.targetId) ?? 0;
      if (sourceDegree >= 2 || targetDegree >= 2) return [];
      degrees.set(edge.sourceId, sourceDegree + 1);
      degrees.set(edge.targetId, targetDegree + 1);
      return [edge];
    });
}

export function buildHighlightAtlas(
  items: HighlightWorkspaceItem[],
): {
  clusters: HighlightAtlasCluster[];
  nodes: HighlightAtlasNode[];
  edges: HighlightAtlasEdge[];
} {
  const groups = atlasGroups(items);
  const layout = atlasLayouts[Math.max(1, groups.length)];
  const clusters = groups.map((group, index) => {
    const slot = layout[index];
    const visibleItems = group.items.slice(0, 5);
    return {
      ...group,
      ...slot,
      items: visibleItems,
      color: clusterColors[index % clusterColors.length],
      hiddenCount: Math.max(0, group.items.length - visibleItems.length),
    };
  });

  const nodes = clusters.flatMap((cluster) =>
    cluster.items.map((item, index) => {
      const position = localNodeLayouts[cluster.items.length][index];
      return {
        item,
        clusterKey: cluster.key,
        status: getHighlightWorkspaceStatus(item),
        x: cluster.x + position.x,
        y: cluster.y + position.y,
      };
    }),
  );

  return { clusters, nodes, edges: buildEdges(nodes) };
}

export function buildHighlightCoverage(
  items: HighlightWorkspaceItem[],
): HighlightCoverageRow[] {
  return groupHighlightsByTheme(items).map((group) => {
    const cells: Record<HighlightWorkspaceStatus, HighlightWorkspaceItem[]> = {
      needs_review: [],
      approved: [],
      lifecycle: [],
      rejected: [],
    };

    for (const item of group.items) {
      cells[getHighlightWorkspaceStatus(item)].push(item);
    }

    return { ...group, cells };
  });
}
