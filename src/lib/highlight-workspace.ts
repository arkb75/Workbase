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

export const highlightCoverageLensIds = [
  "narrative",
  "contribution",
  "value",
] as const;

export type HighlightCoverageLensId = (typeof highlightCoverageLensIds)[number];

export type HighlightCoverageRowDefinition = {
  key: string;
  label: string;
  description: string;
};

export type HighlightCoverageLensDefinition = {
  id: HighlightCoverageLensId;
  label: string;
  description: string;
  rows: readonly HighlightCoverageRowDefinition[];
  fallbackRowKey: string;
};

export const highlightCoverageLenses: readonly HighlightCoverageLensDefinition[] = [
  {
    id: "narrative",
    label: "Narrative",
    description: "Organizes highlights by the role they play in a concise work story.",
    rows: [
      {
        key: "challenge",
        label: "Challenge",
        description: "The problem, constraint, or risk that made the work necessary.",
      },
      {
        key: "action",
        label: "Action",
        description: "The concrete work, decision, or leadership applied.",
      },
      {
        key: "result",
        label: "Result",
        description: "The measured or stated effect of the work.",
      },
      {
        key: "other",
        label: "Other",
        description: "Highlights without enough narrative signal yet.",
      },
    ],
    fallbackRowKey: "other",
  },
  {
    id: "contribution",
    label: "Contribution",
    description: "Groups highlights by how the person contributed to the work.",
    rows: [
      {
        key: "built",
        label: "Built",
        description: "Created, implemented, designed, or integrated something tangible.",
      },
      {
        key: "improved",
        label: "Improved",
        description: "Made an existing system faster, safer, or more effective.",
      },
      {
        key: "led",
        label: "Led",
        description: "Owned direction, coordination, or accountable scope.",
      },
      {
        key: "enabled",
        label: "Enabled",
        description: "Unlocked, automated, standardized, or supported other work.",
      },
      {
        key: "other",
        label: "Other",
        description: "Highlights without a clear contribution signal yet.",
      },
    ],
    fallbackRowKey: "other",
  },
  {
    id: "value",
    label: "Value delivered",
    description: "Groups highlights by the kind of value the work appears to create.",
    rows: [
      {
        key: "speed",
        label: "Speed",
        description: "Reduced latency, time, or performance cost.",
      },
      {
        key: "reliability",
        label: "Reliability",
        description: "Improved availability, durability, recovery, or resilience.",
      },
      {
        key: "quality",
        label: "Quality",
        description: "Improved safety, correctness, validation, or review quality.",
      },
      {
        key: "scale",
        label: "Scale",
        description: "Supported more volume, concurrency, or distributed operation.",
      },
      {
        key: "team-leverage",
        label: "Team leverage",
        description: "Made other people or teams more effective.",
      },
      {
        key: "other",
        label: "Other",
        description: "Highlights without a clear value signal yet.",
      },
    ],
    fallbackRowKey: "other",
  },
];

export type HighlightCoverageLensSuggestion = {
  lens: HighlightCoverageLensDefinition;
  classifiedCount: number;
  unclassifiedCount: number;
  populatedRowCount: number;
  fitPercent: number;
  rowCounts: Array<HighlightCoverageRowDefinition & { count: number }>;
};

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
  updatedAt: string;
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
  key: string;
  label: string;
  cells: Record<string, HighlightWorkspaceItem[]>;
};

export type HighlightCoverageColumn = HighlightThemeGroup & {
  themeKeys: string[];
};

export type HighlightCoverageModel = {
  lens: HighlightCoverageLensDefinition;
  columns: HighlightCoverageColumn[];
  rows: HighlightCoverageRow[];
  classifiedCount: number;
  unclassifiedCount: number;
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

export function getHighlightTheme(item: HighlightWorkspaceItem) {
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

type CoverageClassifiableHighlight = Pick<
  HighlightWorkspaceItem,
  "text" | "summary" | "tags" | "ownershipClarity"
>;

function coverageSearchText(item: CoverageClassifiableHighlight) {
  return [
    item.text,
    item.summary,
    `ownership:${item.ownershipClarity}`,
    ...item.tags.map((tag) => `${tag.dimension}:${tag.tag}`),
  ]
    .join(" ")
    .toLowerCase();
}

function classifyCoverageRowKey(
  item: CoverageClassifiableHighlight,
  lensId: HighlightCoverageLensId,
) {
  const content = coverageSearchText(item);

  if (lensId === "narrative") {
    if (
      /\b(?:result|outcome|impact|cut|reduced?|increased?|improved?|accelerated|saved|grew|growth|adoption|uptime|throughput|latency)\b/i.test(
        content,
      )
    ) {
      return "result";
    }
    if (
      /\b(?:built|implemented|created|designed|developed|integrated|migrated|launched|delivered|led|owned|drove|defined|coordinated|automated|standardized)\b/i.test(
        content,
      )
    ) {
      return "action";
    }
    if (
      /\b(?:challenge|problem|constraint|gap|risk|legacy|bottleneck|failure|unavailable|fragmented|manual)\b/i.test(
        content,
      )
    ) {
      return "challenge";
    }
    return "other";
  }

  if (lensId === "contribution") {
    if (
      /\b(?:led|owned|drove|directed|guided|coordinated|mentored|partnered|roadmap|stakeholder|leadership)\b/i.test(
        content,
      )
    ) {
      return "led";
    }
    if (
      /\b(?:improved?|optimized|reduced?|increased?|accelerated|hardened|stabilized|streamlined|cut)\b/i.test(
        content,
      )
    ) {
      return "improved";
    }
    if (
      /\b(?:built|implemented|created|designed|developed|integrated|migrated|launched|shipped|constructed)\b/i.test(
        content,
      )
    ) {
      return "built";
    }
    if (
      /\b(?:enabled|unlocked|automated|standardized|supported|governed|prevented|provided|combined|combines|routed|routes|validated|validates)\b/i.test(
        content,
      )
    ) {
      return "enabled";
    }
    return "other";
  }

  if (
    /\b(?:latency|performance|throughput|faster|speed|response time|execution time|optimization)\b/i.test(
      content,
    )
  ) {
    return "speed";
  }
  if (
    /\b(?:reliability|availability|uptime|downtime|retry|recovery|resilien\w*|durab\w*|failure|fault|stale|freshness)\b/i.test(
      content,
    )
  ) {
    return "reliability";
  }
  if (
    /\b(?:quality|safety|validation|validated|accuracy|correctness|test|review|verification|redaction|guard|governance|provenance)\b/i.test(
      content,
    )
  ) {
    return "quality";
  }
  if (
    /\b(?:scale|scalable|distributed|concurrency|concurrent|contention|volume|traffic|multi[- ]tenant)\b/i.test(
      content,
    )
  ) {
    return "scale";
  }
  if (
    /\b(?:cross[- ]team|platform|developer experience|workflow|collaboration|enablement|self[- ]service|automation)\b/i.test(
      content,
    )
  ) {
    return "team-leverage";
  }
  return "other";
}

export function getHighlightCoverageLens(lensId: HighlightCoverageLensId) {
  return (
    highlightCoverageLenses.find((lens) => lens.id === lensId) ??
    highlightCoverageLenses[0]
  );
}

export function getHighlightCoverageRow(
  item: Pick<
    HighlightWorkspaceItem,
    "text" | "summary" | "tags" | "ownershipClarity"
  >,
  lensId: HighlightCoverageLensId,
) {
  const lens = getHighlightCoverageLens(lensId);
  const rowKey = classifyCoverageRowKey(item, lensId);
  return (
    lens.rows.find((row) => row.key === rowKey) ??
    lens.rows.find((row) => row.key === lens.fallbackRowKey) ??
    lens.rows[0]
  );
}

export function buildHighlightCoverageLensSuggestions(
  items: HighlightWorkspaceItem[],
): HighlightCoverageLensSuggestion[] {
  const rankedSuggestions = highlightCoverageLenses
    .map((lens, lensIndex) => {
      const counts = new Map(lens.rows.map((row) => [row.key, 0]));
      for (const item of items) {
        const row = getHighlightCoverageRow(item, lens.id);
        counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
      }

      const rowCounts = lens.rows.map((row) => ({
        ...row,
        count: counts.get(row.key) ?? 0,
      }));
      const unclassifiedCount = counts.get(lens.fallbackRowKey) ?? 0;
      const classifiedCount = Math.max(0, items.length - unclassifiedCount);
      const populatedRowCount = rowCounts.filter(
        (row) => row.key !== lens.fallbackRowKey && row.count > 0,
      ).length;

      return {
        lens,
        classifiedCount,
        unclassifiedCount,
        populatedRowCount,
        fitPercent: items.length
          ? Math.round((classifiedCount / items.length) * 100)
          : 0,
        rowCounts,
        lensIndex,
      };
    })
    .sort(
      (left, right) =>
        right.classifiedCount - left.classifiedCount ||
        right.populatedRowCount - left.populatedRowCount ||
        left.lensIndex - right.lensIndex,
    );

  return rankedSuggestions.map((ranked) => ({
    lens: ranked.lens,
    classifiedCount: ranked.classifiedCount,
    unclassifiedCount: ranked.unclassifiedCount,
    populatedRowCount: ranked.populatedRowCount,
    fitPercent: ranked.fitPercent,
    rowCounts: ranked.rowCounts,
  }));
}

export function getRecommendedHighlightCoverageLens(
  items: HighlightWorkspaceItem[],
): HighlightCoverageLensId {
  return buildHighlightCoverageLensSuggestions(items)[0]?.lens.id ?? "contribution";
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
    const theme = getHighlightTheme(item);
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
  lensId: HighlightCoverageLensId = "contribution",
): HighlightCoverageModel {
  const lens = getHighlightCoverageLens(lensId);
  const themes = groupHighlightsByTheme(items);
  const columns: HighlightCoverageColumn[] =
    themes.length <= 4
      ? themes.map((theme) => ({ ...theme, themeKeys: [theme.key] }))
      : [
          ...themes.slice(0, 3).map((theme) => ({
            ...theme,
            themeKeys: [theme.key],
          })),
          {
            key: "other-themes",
            label: "Other themes",
            items: themes.slice(3).flatMap((theme) => theme.items),
            themeKeys: themes.slice(3).map((theme) => theme.key),
          },
        ];
  const themeKeyByItemId = new Map(
    themes.flatMap((theme) => theme.items.map((item) => [item.id, theme.key] as const)),
  );
  const rowItems = new Map<string, HighlightWorkspaceItem[]>();
  for (const item of items) {
    const row = getHighlightCoverageRow(item, lensId);
    const itemsForRow = rowItems.get(row.key) ?? [];
    itemsForRow.push(item);
    rowItems.set(row.key, itemsForRow);
  }
  const rows = lens.rows.flatMap<HighlightCoverageRow>((rowDefinition) => {
    const itemsForRow = rowItems.get(rowDefinition.key) ?? [];
    if (!itemsForRow.length) return [];

    const cells = Object.fromEntries(
      columns.map((column) => [column.key, [] as HighlightWorkspaceItem[]]),
    );

    for (const item of itemsForRow) {
      const themeKey = themeKeyByItemId.get(item.id);
      const column = columns.find((candidate) =>
        themeKey ? candidate.themeKeys.includes(themeKey) : false,
      );
      if (column) cells[column.key]?.push(item);
    }

    for (const cellItems of Object.values(cells)) {
      cellItems.sort(compareItems);
    }

    return {
      key: rowDefinition.key,
      label: rowDefinition.label,
      items: itemsForRow,
      cells,
    };
  });
  const unclassifiedCount = rowItems.get(lens.fallbackRowKey)?.length ?? 0;

  return {
    lens,
    columns,
    rows,
    classifiedCount: Math.max(0, items.length - unclassifiedCount),
    unclassifiedCount,
  };
}
