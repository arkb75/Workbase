"use client";

import {
  useMemo,
  useOptimistic,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import {
  Archive,
  Check,
  CircleDashed,
  Clock3,
  Grid3X3,
  Network,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  renameHighlightCoverageRowAction,
  updateClaimAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  buildHighlightAtlas,
  buildHighlightCoverage,
  getHighlightCoverageRowLabel,
  getHighlightTheme,
  getHighlightWorkspaceStatus,
  groupHighlightsByTheme,
  highlightMatchesFilter,
  highlightWorkspaceStatuses,
  type HighlightAtlasEdge,
  type HighlightAtlasNode,
  type HighlightCoverageModel,
  type HighlightWorkspaceFilter,
  type HighlightWorkspaceItem,
  type HighlightWorkspaceStatus,
} from "@/src/lib/highlight-workspace";
import { visibilityOptions } from "@/src/lib/options";
import { cn, titleCase } from "@/src/lib/utils";

type WorkspaceView = "atlas" | "coverage";

const statusCopy: Record<
  HighlightWorkspaceStatus,
  { label: string; shortLabel: string; description: string }
> = {
  needs_review: {
    label: "Needs review",
    shortLabel: "Review",
    description: "Waiting for a human decision",
  },
  approved: {
    label: "Approved",
    shortLabel: "Approved",
    description: "Active and available to eligible artifacts",
  },
  lifecycle: {
    label: "Lifecycle",
    shortLabel: "Lifecycle",
    description: "Stale, superseded, quarantined, or retired",
  },
  rejected: {
    label: "Rejected",
    shortLabel: "Rejected",
    description: "Retained as negative guidance",
  },
};

const statusStyles: Record<HighlightWorkspaceStatus, string> = {
  needs_review:
    "border-amber-300/90 bg-[#172a31] text-white shadow-[0_0_0_3px_rgba(251,191,36,0.08)] [border-style:dashed]",
  approved:
    "border-emerald-300/70 bg-[#172a31] text-white shadow-[0_0_0_3px_rgba(110,231,183,0.07)]",
  lifecycle:
    "rounded-[18px] border-sky-200/65 bg-[#172a31] text-white shadow-[0_0_0_3px_rgba(186,230,253,0.06)] [border-style:double]",
  rejected:
    "border-rose-300/65 bg-[#172a31] text-white/72 shadow-[0_0_0_3px_rgba(253,164,175,0.05)]",
};

function statusIcon(status: HighlightWorkspaceStatus, className = "h-3.5 w-3.5") {
  if (status === "approved") return <Check className={className} aria-hidden="true" />;
  if (status === "needs_review") return <Clock3 className={className} aria-hidden="true" />;
  if (status === "rejected") return <X className={className} aria-hidden="true" />;
  return <CircleDashed className={className} aria-hidden="true" />;
}

function itemMatchesSearch(item: HighlightWorkspaceItem, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  return [
    item.text,
    item.summary,
    ...item.tags.map((tag) => tag.tag),
    ...item.evidence.sourceRefs.flatMap((reference) => [
      reference.sourceLabel,
      reference.title,
    ]),
  ].some((value) => value.toLowerCase().includes(normalized));
}

function itemMatches(
  item: HighlightWorkspaceItem,
  filter: HighlightWorkspaceFilter,
  query: string,
) {
  return highlightMatchesFilter(item, filter) && itemMatchesSearch(item, query);
}

function statusTone(status: HighlightWorkspaceStatus) {
  if (status === "approved") return "success" as const;
  if (status === "needs_review" || status === "lifecycle") return "warning" as const;
  return "danger" as const;
}

function HiddenReviewFields({
  item,
  returnTo,
}: {
  item: HighlightWorkspaceItem;
  returnTo: string;
}) {
  return (
    <>
      <input type="hidden" name="workItemId" value={item.workItemId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="text" value={item.text} />
      <input type="hidden" name="visibility" value={item.visibility} />
      <input
        type="hidden"
        name="verificationNotes"
        value={item.verificationNotes ?? ""}
      />
      <input
        type="hidden"
        name="rejectionReason"
        value={item.rejectionReason ?? ""}
      />
      {item.sensitivityFlag ? (
        <input type="hidden" name="sensitivityFlag" value="true" />
      ) : null}
    </>
  );
}

function HighlightInspector({
  item,
  itemsById,
  edges,
  returnTo,
  matchesCurrentView,
  onSelect,
}: {
  item: HighlightWorkspaceItem | null;
  itemsById: Map<string, HighlightWorkspaceItem>;
  edges: HighlightAtlasEdge[];
  returnTo: string;
  matchesCurrentView: boolean;
  onSelect: (id: string) => void;
}) {
  if (!item) {
    return (
      <aside className="flex min-h-80 items-center justify-center bg-white p-8 text-center lg:min-h-[660px]">
        <div className="max-w-xs space-y-3">
          <Network className="mx-auto h-6 w-6 text-[color:var(--accent)]" />
          <h3 className="font-display text-xl font-semibold tracking-[-0.03em]">
            Nothing selected
          </h3>
          <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
            Select a highlight to inspect its evidence, relationships, and review state.
          </p>
        </div>
      </aside>
    );
  }

  const status = getHighlightWorkspaceStatus(item);
  const action = updateClaimAction.bind(null, item.id);
  const connections = edges.flatMap((edge) => {
    if (edge.sourceId === item.id) {
      const connected = itemsById.get(edge.targetId);
      return connected ? [{ item: connected, reason: edge.reason }] : [];
    }
    if (edge.targetId === item.id) {
      const connected = itemsById.get(edge.sourceId);
      return connected ? [{ item: connected, reason: edge.reason }] : [];
    }
    return [];
  });
  const isActive = item.lifecycleStatus === "active";
  const isRejected = item.verificationStatus === "rejected";
  const isPending = status === "needs_review";
  const sensitivityId = `workspace-sensitive-${item.id}`;

  return (
      <aside className="min-w-0 bg-white lg:h-[660px] lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-black/8">
      <div className="border-b border-black/8 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(status)}>
            <span className="mr-1 inline-flex">{statusIcon(status)}</span>
            {statusCopy[status].label}
          </Badge>
          <Badge>{titleCase(item.confidence)} confidence</Badge>
          {item.sensitivityFlag ? (
            <Badge tone="danger">
              <ShieldAlert className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Sensitive
            </Badge>
          ) : null}
          {!matchesCurrentView ? <Badge>Outside current filter</Badge> : null}
        </div>
        <h2 className="mt-4 font-display text-xl font-semibold leading-[1.2] tracking-[-0.04em] text-[color:var(--ink-strong)]">
          {item.text}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[color:var(--ink-soft)]">
          {item.summary}
        </p>
      </div>

      <div className="divide-y divide-black/8">
        <section className="px-5 py-5 sm:px-6" aria-labelledby="highlight-evidence-heading">
          <div className="flex items-center justify-between gap-3">
            <h3
              id="highlight-evidence-heading"
              className="text-xs font-semibold uppercase tracking-[0.17em] text-[color:var(--ink-muted)]"
            >
              Evidence
            </h3>
            <span className="text-xs text-[color:var(--ink-muted)]">
              {item.evidence.sourceRefs.length} linked
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {item.evidence.sourceRefs.length ? (
              item.evidence.sourceRefs.slice(0, 3).map((reference) => (
                <div key={reference.evidenceItemId} className="border-l-2 border-cyan-700/40 pl-3">
                  <p className="text-xs font-medium text-[color:var(--ink-strong)]">
                    {reference.sourceLabel} · {reference.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--ink-soft)]">
                    {reference.excerpt}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No direct evidence reference is attached yet.
              </p>
            )}
          </div>
        </section>

        <section className="px-5 py-5 sm:px-6" aria-labelledby="highlight-connections-heading">
          <div className="flex items-center justify-between gap-3">
            <h3
              id="highlight-connections-heading"
              className="text-xs font-semibold uppercase tracking-[0.17em] text-[color:var(--ink-muted)]"
            >
              Connections
            </h3>
            <span className="text-xs text-[color:var(--ink-muted)]">
              {connections.length} explained
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {connections.length ? (
              connections.map((connection) => (
                <button
                  key={connection.item.id}
                  type="button"
                  onClick={() => onSelect(connection.item.id)}
                  className="block w-full border-l-2 border-black/12 pl-3 text-left transition hover:border-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600/35"
                >
                  <span className="line-clamp-1 text-xs font-medium text-[color:var(--ink-strong)]">
                    {connection.item.text}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-[color:var(--ink-muted)]">
                    Because they share {connection.reason.replace(/^shared /, "")}.
                  </span>
                </button>
              ))
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No explicit shared evidence or semantic tag in this overview.
              </p>
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-x-5 gap-y-4 px-5 py-5 text-sm sm:px-6">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
              Visibility
            </p>
            <p className="mt-1 font-medium text-[color:var(--ink-strong)]">
              {titleCase(item.visibility)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
              Ownership
            </p>
            <p className="mt-1 font-medium text-[color:var(--ink-strong)]">
              {titleCase(item.ownershipClarity)}
            </p>
          </div>
          <div className="col-span-2 flex flex-wrap gap-1.5">
            {item.tags.length ? (
              item.tags.slice(0, 6).map((tag) => (
                <span
                  key={`${tag.dimension}:${tag.tag}`}
                  className="rounded-full border border-black/8 px-2 py-1 text-[11px] text-[color:var(--ink-soft)]"
                >
                  {titleCase(tag.tag)}
                </span>
              ))
            ) : (
              <span className="text-xs text-[color:var(--ink-muted)]">No semantic tags</span>
            )}
          </div>
        </section>

        <section className="px-5 py-5 sm:px-6" aria-label="Highlight review actions">
          <div className="flex flex-wrap gap-2">
            {isActive && isPending ? (
              <form action={action}>
                <HiddenReviewFields item={item} returnTo={returnTo} />
                <input type="hidden" name="intent" value="approve" />
                <SubmitButton size="sm" pendingLabel="Approving…">
                  Approve
                </SubmitButton>
              </form>
            ) : null}
            {isActive && isRejected ? (
              <form action={action}>
                <HiddenReviewFields item={item} returnTo={returnTo} />
                <input type="hidden" name="intent" value="restore" />
                <SubmitButton size="sm" pendingLabel="Restoring…">
                  Restore to review
                </SubmitButton>
              </form>
            ) : null}
            {isActive && !isRejected ? (
              <form action={action}>
                <HiddenReviewFields item={item} returnTo={returnTo} />
                <input type="hidden" name="intent" value="reject" />
                <SubmitButton
                  size="sm"
                  variant={status === "approved" ? "ghost" : "danger"}
                  pendingLabel={status === "approved" ? "Retiring…" : "Rejecting…"}
                >
                  {status === "approved" ? "Retire" : "Reject"}
                </SubmitButton>
              </form>
            ) : null}
          </div>

          <details className="group mt-4 border-t border-black/8 pt-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-[color:var(--accent)]">
              {isActive ? "Edit details" : "Create an edited successor"}
              <span className="text-xs text-[color:var(--ink-muted)] group-open:hidden">Open</span>
              <span className="hidden text-xs text-[color:var(--ink-muted)] group-open:inline">Close</span>
            </summary>
            <form action={action} className="mt-4 grid gap-4">
              <input type="hidden" name="workItemId" value={item.workItemId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-[color:var(--ink-soft)]">
                  Highlight text
                </span>
                <Textarea name="text" defaultValue={item.text} className="min-h-28 rounded-2xl" />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-[color:var(--ink-soft)]">
                  Visibility
                </span>
                <Select name="visibility" defaultValue={item.visibility} className="rounded-xl">
                  {visibilityOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-2 text-sm text-[color:var(--ink-strong)]">
                <input
                  id={sensitivityId}
                  type="checkbox"
                  name="sensitivityFlag"
                  defaultChecked={item.sensitivityFlag}
                  className="h-4 w-4 rounded border-black/20 text-[color:var(--accent)]"
                />
                Sensitive material
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-[color:var(--ink-soft)]">
                  Review notes
                </span>
                <Textarea
                  name="verificationNotes"
                  defaultValue={item.verificationNotes ?? ""}
                  className="min-h-20 rounded-2xl"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-[color:var(--ink-soft)]">
                  Rejection reason
                </span>
                <Textarea
                  name="rejectionReason"
                  defaultValue={item.rejectionReason ?? ""}
                  className="min-h-20 rounded-2xl"
                />
              </label>
              <input type="hidden" name="intent" value="save" />
              <SubmitButton size="sm" pendingLabel="Saving successor…">
                Save as successor
              </SubmitButton>
            </form>
          </details>
        </section>
      </div>
    </aside>
  );
}

function HighlightNodeButton({
  node,
  selected,
  related,
  matches,
  onSelect,
}: {
  node: HighlightAtlasNode;
  selected: boolean;
  related: boolean;
  matches: boolean;
  onSelect: (id: string) => void;
}) {
  const status = node.status;
  return (
    <button
      type="button"
      aria-label={`${node.item.text}. ${statusCopy[status].label}.`}
      aria-pressed={selected}
      onClick={() => onSelect(node.item.id)}
      data-highlight-node={node.item.id}
      className={cn(
        "absolute z-20 flex h-[58px] w-[108px] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full border px-2.5 text-left transition-[opacity,transform,box-shadow] duration-200 focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#10212b]",
        statusStyles[status],
        selected && "z-30 scale-[1.06] ring-2 ring-white ring-offset-2 ring-offset-[#10212b]",
        !matches && "opacity-20",
        matches && !related && "opacity-70",
      )}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
    >
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          status === "approved" && "bg-emerald-300/16 text-emerald-200",
          status === "needs_review" && "bg-amber-300/16 text-amber-200",
          status === "lifecycle" && "bg-sky-200/14 text-sky-100",
          status === "rejected" && "bg-rose-300/12 text-rose-200",
        )}
      >
        {statusIcon(status)}
      </span>
      <span className="line-clamp-2 text-[11px] font-medium leading-[1.22]">
        {node.item.text}
      </span>
    </button>
  );
}

function HighlightAtlasView({
  items,
  filter,
  query,
  selectedId,
  onSelect,
}: {
  items: HighlightWorkspaceItem[];
  filter: HighlightWorkspaceFilter;
  query: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const atlas = useMemo(() => buildHighlightAtlas(items), [items]);
  const themeGroups = useMemo(() => groupHighlightsByTheme(items), [items]);
  const connectedIds = new Set([selectedId]);
  for (const edge of atlas.edges) {
    if (edge.sourceId === selectedId) connectedIds.add(edge.targetId);
    if (edge.targetId === selectedId) connectedIds.add(edge.sourceId);
  }
  const nodesById = new Map(atlas.nodes.map((node) => [node.item.id, node]));

  return (
    <section className="relative min-w-0 overflow-hidden bg-[#10212b] text-white lg:h-[660px]" aria-label="Highlight Atlas">
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(148, 191, 196, 0.55) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />

      <div className="relative hidden h-full min-h-[660px] md:block" data-atlas-canvas>
        {atlas.clusters.map((cluster) => (
          <div key={cluster.key}>
            <div
              data-cluster-halo={cluster.key}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-[48%] border bg-white/[0.015]"
              style={{
                left: `${cluster.x}%`,
                top: `${cluster.y}%`,
                width: `${cluster.radiusX * 2}%`,
                height: `${cluster.radiusY * 2}%`,
                borderColor: `${cluster.color}66`,
                boxShadow: `inset 0 0 70px ${cluster.color}0d`,
              }}
            />
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 text-center"
              style={{
                left: `${cluster.x}%`,
                top: `${Math.max(1.5, cluster.y - cluster.radiusY + 2)}%`,
              }}
            >
              <div className="flex items-center justify-center gap-2 whitespace-nowrap">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: cluster.color }}
                />
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/78">
                  {cluster.label}
                </p>
              </div>
              <p className="mt-1 text-[10px] text-white/45">
                {cluster.items.length + cluster.hiddenCount} highlight
                {cluster.items.length + cluster.hiddenCount === 1 ? "" : "s"}
                {cluster.hiddenCount ? ` · +${cluster.hiddenCount} in Coverage` : ""}
              </p>
            </div>
          </div>
        ))}

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {atlas.edges.map((edge) => {
            const source = nodesById.get(edge.sourceId);
            const target = nodesById.get(edge.targetId);
            if (!source || !target) return null;
            const bothMatch =
              itemMatches(source.item, filter, query) &&
              itemMatches(target.item, filter, query);
            const touchesSelected =
              !selectedId || edge.sourceId === selectedId || edge.targetId === selectedId;
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                vectorEffect="non-scaling-stroke"
                stroke="rgba(184, 218, 220, 0.58)"
                strokeWidth={touchesSelected ? 1.5 : 1}
                opacity={bothMatch && touchesSelected ? 0.72 : 0.12}
              />
            );
          })}
        </svg>

        {atlas.nodes.map((node) => (
          <HighlightNodeButton
            key={node.item.id}
            node={node}
            selected={selectedId === node.item.id}
            related={!selectedId || connectedIds.has(node.item.id)}
            matches={itemMatches(node.item, filter, query)}
            onSelect={onSelect}
          />
        ))}

        <div className="absolute bottom-4 left-5 z-30 flex flex-wrap gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-[#10212b]/88 px-3 py-2 text-[10px] text-white/62 backdrop-blur-sm">
          {highlightWorkspaceStatuses.map((status) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              {statusIcon(status, "h-3 w-3")}
              {statusCopy[status].shortLabel}
            </span>
          ))}
        </div>
      </div>

      <div className="relative divide-y divide-white/10 md:hidden">
        {themeGroups.map((row) => {
          const matches = row.items.filter((item) => itemMatches(item, filter, query));
          return (
            <section key={row.key} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  {row.label}
                </h3>
                <span className="text-xs text-white/45">{matches.length} shown</span>
              </div>
              <div className="mt-3 space-y-2">
                {matches.slice(0, 5).map((item) => {
                  const status = getHighlightWorkspaceStatus(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelect(item.id)}
                      aria-pressed={selectedId === item.id}
                      className={cn(
                        "flex w-full items-start gap-3 border-l-2 border-white/18 py-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                        selectedId === item.id && "border-cyan-300 bg-white/[0.04]",
                      )}
                    >
                      <span className="mt-0.5 text-white/65">{statusIcon(status)}</span>
                      <span>
                        <span className="line-clamp-2 text-sm font-medium leading-5 text-white">
                          {item.text}
                        </span>
                        <span className="mt-1 block text-[10px] uppercase tracking-[0.14em] text-white/45">
                          {statusCopy[status].label}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {matches.length > 5 ? (
                  <p className="pl-3 text-xs text-white/45">
                    +{matches.length - 5} more in Coverage
                  </p>
                ) : null}
                {!matches.length ? (
                  <p className="py-2 text-sm text-white/45">No matching highlights.</p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function CoverageHighlightCard({
  item,
  code,
  selected,
  showTheme,
  onSelect,
}: {
  item: HighlightWorkspaceItem;
  code: string;
  selected: boolean;
  showTheme: boolean;
  onSelect: (id: string) => void;
}) {
  const status = getHighlightWorkspaceStatus(item);
  const theme = getHighlightTheme(item);

  return (
    <article
      className={cn(
        "rounded-[18px] border bg-[#18292e] transition-[border-color,background-color,transform,box-shadow] duration-200",
        status === "approved" && "border-white/16",
        status === "needs_review" && "border-amber-300/45",
        status === "lifecycle" && "border-sky-200/45 [border-style:dashed]",
        status === "rejected" && "border-rose-300/35 opacity-75",
        selected &&
          "border-teal-300 bg-[#193236] shadow-[0_0_0_1px_rgba(94,234,212,0.55)]",
      )}
      data-coverage-highlight={item.id}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${item.text}. ${statusCopy[status].label}.`}
        onClick={() => onSelect(item.id)}
        className="block min-h-[112px] w-full px-3.5 pb-3 pt-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-200/80"
      >
        <span className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/48">
          <span>{code}</span>
          <span className="inline-flex items-center gap-1.5">
            {statusCopy[status].shortLabel}
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                status === "approved" && "bg-teal-300",
                status === "needs_review" && "bg-amber-300",
                status === "lifecycle" && "border border-sky-200",
                status === "rejected" && "bg-rose-300",
              )}
              aria-hidden="true"
            />
          </span>
        </span>
        {showTheme ? (
          <span className="mt-3 block text-[9px] font-semibold uppercase tracking-[0.14em] text-teal-200/55">
            {theme.label}
          </span>
        ) : null}
        <span className="mt-3 block max-h-[4.5rem] overflow-hidden text-[13px] font-semibold leading-[1.35] text-white/92">
          {item.text}
        </span>
      </button>
    </article>
  );
}

function CoverageRowLabelEditor({
  label,
  count,
  pending,
  vertical = false,
  onRename,
}: {
  label: string;
  count: number;
  pending: boolean;
  vertical?: boolean;
  onRename: (fromLabel: string, toLabel: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextLabel = draft.trim();
    if (nextLabel.length < 2 || nextLabel === label) {
      setDraft(label);
      setEditing(false);
      return;
    }
    onRename(label, nextLabel);
    setEditing(false);
  }

  if (editing) {
    return (
      <form
        onSubmit={submitRename}
        className={cn(
          "z-30 flex items-center gap-1.5 rounded-xl border border-teal-200/35 bg-[#18292e] p-1.5 shadow-2xl",
          vertical && "absolute left-2 top-1/2 w-48 -translate-y-1/2",
        )}
      >
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(label);
              setEditing(false);
            }
          }}
          aria-label={`Rename ${label} row`}
          maxLength={40}
          className="h-8 min-w-0 flex-1 rounded-lg border border-white/12 bg-white/[0.055] px-2.5 text-xs font-medium text-white outline-none focus:border-teal-200/70"
        />
        <button
          type="submit"
          aria-label="Save row name"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-300 text-[#112126] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Cancel row rename"
          onClick={() => {
            setDraft(label);
            setEditing(false);
          }}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/55 hover:bg-white/8 hover:text-white"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Edit ${label} row name`}
      onClick={() => setEditing(true)}
      className={cn(
        "group inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/58 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-teal-200/70 disabled:cursor-wait disabled:opacity-45",
        vertical && "flex-col",
      )}
    >
      <span
        style={
          vertical
            ? { writingMode: "vertical-rl", transform: "rotate(180deg)" }
            : undefined
        }
      >
        {label}
      </span>
      <span className="inline-flex items-center gap-1 text-[9px] tracking-normal text-white/34 group-hover:text-teal-200/75">
        {count}
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </span>
    </button>
  );
}

export function HighlightCoverageView({
  model,
  filter,
  query,
  selectedId,
  rowRenamePending,
  onSelect,
  onRenameRow,
}: {
  model: HighlightCoverageModel;
  filter: HighlightWorkspaceFilter;
  query: string;
  selectedId: string | null;
  rowRenamePending: boolean;
  onSelect: (id: string) => void;
  onRenameRow: (fromLabel: string, toLabel: string) => void;
}) {
  const allItems = model.columns
    .flatMap((column) => column.items)
    .sort((left, right) => left.id.localeCompare(right.id));
  const codeById = new Map(
    allItems.map((item, index) => [item.id, `H${String(index + 1).padStart(2, "0")}`]),
  );

  return (
    <section
      className="min-h-[660px] min-w-0 bg-[#112126] text-white lg:h-[660px] lg:min-h-0 lg:overflow-y-auto"
      aria-label="Highlight Coverage"
    >
      <header className="border-b border-white/12 px-5 py-5 sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
          Coverage system
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-[-0.04em]">
              Highlight matrix
            </h2>
            <p className="mt-2 max-w-xl text-xs leading-5 text-white/52">
              Themes form the columns. Edit a populated row name to regroup its highlights.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-white/62" aria-label="Coverage status legend">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-teal-300" /> Ready
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-300" /> Review
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-300" /> Rejected
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full border border-sky-200" /> Lifecycle
            </span>
          </div>
        </div>
      </header>

      <div className="hidden md:block">
        <table data-coverage-table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[72px]" />
            {model.columns.map((column) => (
              <col key={column.key} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-2 py-4" aria-label="Coverage layer" />
              {model.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-2 py-4 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-white/58"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => {
              const rowHasMatches = model.columns.some((column) =>
                (row.cells[column.key] ?? []).some((item) =>
                  itemMatches(item, filter, query),
                ),
              );
              const rowHeight = rowHasMatches ? "min-h-[154px]" : "min-h-[92px]";
              return (
                <tr key={row.key} className="border-b border-white/8 last:border-b-0">
                  <th
                    scope="row"
                    className="relative px-2 py-3 text-center align-middle font-normal"
                  >
                    <CoverageRowLabelEditor
                      key={row.label}
                      label={row.label}
                      count={row.items.length}
                      pending={rowRenamePending}
                      onRename={onRenameRow}
                      vertical
                    />
                  </th>
                  {model.columns.map((column) => {
                    const cellItems = row.cells[column.key] ?? [];
                    const matches = cellItems.filter((item) =>
                      itemMatches(item, filter, query),
                    );
                    return (
                      <td
                        key={column.key}
                        className="border-l border-white/8 p-2 align-top"
                      >
                        <div className={cn(rowHeight, "space-y-2")}>
                          {matches.slice(0, 2).map((item) => (
                            <CoverageHighlightCard
                              key={item.id}
                              item={item}
                              code={codeById.get(item.id) ?? "H—"}
                              selected={selectedId === item.id}
                              showTheme={column.key === "other-themes"}
                              onSelect={onSelect}
                            />
                          ))}
                          {matches.length > 2 ? (
                            <details className="group rounded-[16px] border border-white/10 bg-white/[0.025]">
                              <summary className="cursor-pointer list-none px-3 py-3 text-center text-[11px] font-medium text-white/55 transition hover:text-white/80">
                                <span className="group-open:hidden">
                                  +{matches.length - 2} more
                                </span>
                                <span className="hidden group-open:inline">Show fewer</span>
                              </summary>
                              <div className="space-y-2 border-t border-white/8 p-2">
                                {matches.slice(2).map((item) => (
                                  <CoverageHighlightCard
                                    key={item.id}
                                    item={item}
                                    code={codeById.get(item.id) ?? "H—"}
                                    selected={selectedId === item.id}
                                    showTheme={column.key === "other-themes"}
                                    onSelect={onSelect}
                                  />
                                ))}
                              </div>
                            </details>
                          ) : null}
                          {!matches.length ? (
                            <div
                              className={cn(
                                rowHeight,
                                "flex items-center justify-center rounded-[18px] border border-dashed border-white/16 px-3 text-center text-xs leading-5 text-white/34",
                              )}
                              aria-label={`${row.label}, ${column.label}: no matching highlights`}
                            >
                              {cellItems.length
                                ? "No matching highlights"
                                : "No classified highlights"}
                            </div>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-white/10 md:hidden">
        {model.rows.map((row) => {
          const matches = model.columns.flatMap((column) =>
            (row.cells[column.key] ?? []).filter((item) => itemMatches(item, filter, query)),
          );
          return (
            <section key={row.key} className="px-4 py-5">
              <div className="flex items-center justify-between gap-3">
                <CoverageRowLabelEditor
                  key={row.label}
                  label={row.label}
                  count={row.items.length}
                  pending={rowRenamePending}
                  onRename={onRenameRow}
                />
                <span className="text-xs text-white/40">{matches.length} shown</span>
              </div>
              <div className="mt-3 space-y-2">
                {matches.map((item) => (
                  <CoverageHighlightCard
                    key={item.id}
                    item={item}
                    code={codeById.get(item.id) ?? "H—"}
                    selected={selectedId === item.id}
                    showTheme
                    onSelect={onSelect}
                  />
                ))}
                {!matches.length ? (
                  <p className="rounded-[18px] border border-dashed border-white/16 px-4 py-8 text-center text-sm text-white/38">
                    No classified highlights
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function HighlightWorkspace({
  items,
  totalCount,
  overviewLimit,
  returnTo,
  initialView = "atlas",
}: {
  items: HighlightWorkspaceItem[];
  totalCount: number;
  overviewLimit: number;
  returnTo: string;
  initialView?: WorkspaceView;
}) {
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [filter, setFilter] = useState<HighlightWorkspaceFilter>("all");
  const [query, setQuery] = useState("");
  const [rowRenameError, setRowRenameError] = useState<string | null>(null);
  const [rowRenamePending, startRowRenameTransition] = useTransition();
  const [optimisticItems, setOptimisticRowRename] = useOptimistic<
    HighlightWorkspaceItem[],
    { fromLabel: string; toLabel: string }
  >(items, (currentItems, update) =>
    currentItems.map((item) =>
      getHighlightCoverageRowLabel(item).toLocaleLowerCase() ===
      update.fromLabel.toLocaleLowerCase()
        ? { ...item, coverageRowLabel: update.toLabel }
        : item,
    ),
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const firstReviewItem = items.find(
      (item) => getHighlightWorkspaceStatus(item) === "needs_review",
    );
    return firstReviewItem?.id ?? items[0]?.id ?? null;
  });

  const atlas = useMemo(() => buildHighlightAtlas(optimisticItems), [optimisticItems]);
  const coverage = useMemo(
    () => buildHighlightCoverage(optimisticItems),
    [optimisticItems],
  );
  const itemsById = useMemo(
    () => new Map(optimisticItems.map((item) => [item.id, item])),
    [optimisticItems],
  );
  const selected = selectedId ? itemsById.get(selectedId) ?? null : null;
  const matchingCount = optimisticItems.filter((item) =>
    itemMatches(item, filter, query),
  ).length;
  const hasActiveQuery = filter !== "all" || query.trim().length > 0;
  const statusCounts = Object.fromEntries(
    highlightWorkspaceStatuses.map((status) => [
      status,
      optimisticItems.filter((item) => getHighlightWorkspaceStatus(item) === status)
        .length,
    ]),
  ) as Record<HighlightWorkspaceStatus, number>;

  function resetView() {
    setFilter("all");
    setQuery("");
  }

  function applyFilter(nextFilter: HighlightWorkspaceFilter) {
    setFilter(nextFilter);
    if (nextFilter === "all") return;

    const firstMatch = optimisticItems.find(
      (item) => getHighlightWorkspaceStatus(item) === nextFilter,
    );
    if (firstMatch) setSelectedId(firstMatch.id);
  }

  function renameCoverageRow(fromLabel: string, toLabel: string) {
    setRowRenameError(null);
    startRowRenameTransition(async () => {
      setOptimisticRowRename({ fromLabel, toLabel });
      try {
        const result = await renameHighlightCoverageRowAction(
          optimisticItems[0]?.workItemId ?? "",
          fromLabel,
          toLabel,
        );
        if (!result.ok) setRowRenameError(result.error);
      } catch {
        setRowRenameError("The row name could not be saved. Try again.");
      }
    });
  }

  if (!items.length) {
    return (
      <section className="overflow-hidden rounded-[24px] border border-black/8 bg-white">
        <div className="flex min-h-[420px] items-center justify-center bg-[#10212b] px-6 text-center text-white">
          <div className="max-w-md space-y-4">
            <Network className="mx-auto h-7 w-7 text-cyan-300" />
            <h2 className="font-display text-3xl font-semibold tracking-[-0.05em]">
              Your highlight map starts here
            </h2>
            <p className="text-sm leading-6 text-white/65">
              Generate highlights from grounded evidence. Atlas will organize their
              relationships, and Coverage will make the review gaps visible.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-[24px] border border-black/8 bg-white shadow-[0_18px_50px_rgba(16,33,43,0.08)]">
      <header className="border-b border-black/8 bg-white px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="inline-flex rounded-xl bg-[color:var(--panel-muted)] p-1" aria-label="Highlight view">
              <button
                type="button"
                aria-pressed={view === "atlas"}
                onClick={() => setView("atlas")}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition",
                  view === "atlas"
                    ? "bg-white text-[color:var(--ink-strong)] shadow-sm"
                    : "text-[color:var(--ink-muted)] hover:text-[color:var(--ink-strong)]",
                )}
              >
                <Network className="h-4 w-4" aria-hidden="true" />
                Atlas
              </button>
              <button
                type="button"
                aria-pressed={view === "coverage"}
                onClick={() => setView("coverage")}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition",
                  view === "coverage"
                    ? "bg-white text-[color:var(--ink-strong)] shadow-sm"
                    : "text-[color:var(--ink-muted)] hover:text-[color:var(--ink-strong)]",
                )}
              >
                <Grid3X3 className="h-4 w-4" aria-hidden="true" />
                Coverage
              </button>
            </div>
            <p className="hidden text-xs text-[color:var(--ink-muted)] xl:block">
              {items.length} of {totalCount} in bounded overview
              {totalCount > overviewLimit ? ` · latest ${overviewLimit}` : ""}
            </p>
          </div>

          <label className="relative min-w-[12rem] flex-1 sm:max-w-[18rem]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-muted)]" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search highlights"
              className="h-10 w-full rounded-xl border border-black/10 bg-white pl-9 pr-3 text-sm outline-none transition placeholder:text-[color:var(--ink-muted)] focus:border-[color:var(--accent)] focus:ring-2 focus:ring-cyan-100"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => applyFilter("all")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition",
              filter === "all"
                ? "border-[color:var(--ink-strong)] bg-[color:var(--ink-strong)] text-white"
                : "border-black/10 text-[color:var(--ink-soft)] hover:bg-[color:var(--panel-muted)]",
            )}
          >
            All {items.length}
          </button>
          {highlightWorkspaceStatuses.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={filter === status}
              onClick={() => applyFilter(status)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                filter === status
                  ? "border-[color:var(--accent)] bg-cyan-50 text-cyan-900"
                  : "border-black/10 text-[color:var(--ink-soft)] hover:bg-[color:var(--panel-muted)]",
              )}
            >
              {statusIcon(status, "h-3 w-3")}
              {statusCopy[status].shortLabel} {statusCounts[status]}
            </button>
          ))}
          <span className="ml-auto text-xs text-[color:var(--ink-muted)]">
            {matchingCount} shown
          </span>
          {hasActiveQuery ? (
            <button
              type="button"
              onClick={resetView}
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-[color:var(--accent)] hover:bg-cyan-50"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Reset
            </button>
          ) : null}
        </div>
        {rowRenameError ? (
          <p className="mt-3 text-xs font-medium text-rose-700" role="alert">
            {rowRenameError}
          </p>
        ) : null}
      </header>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.7fr)] lg:items-start xl:grid-cols-[minmax(0,1fr)_360px]">
        {view === "atlas" ? (
          <HighlightAtlasView
            items={optimisticItems}
            filter={filter}
            query={query}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <HighlightCoverageView
            model={coverage}
            filter={filter}
            query={query}
            selectedId={selectedId}
            rowRenamePending={rowRenamePending}
            onSelect={setSelectedId}
            onRenameRow={renameCoverageRow}
          />
        )}
        <HighlightInspector
          item={selected}
          itemsById={itemsById}
          edges={atlas.edges}
          returnTo={returnTo}
          matchesCurrentView={selected ? itemMatches(selected, filter, query) : true}
          onSelect={setSelectedId}
        />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-black/8 bg-[color:var(--surface)] px-4 py-3 text-xs text-[color:var(--ink-muted)] sm:px-5">
        <span>
          Atlas stays fixed. Coverage regroups when a row name changes.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
          Older records remain available in the ledger below.
        </span>
      </footer>
    </section>
  );
}
