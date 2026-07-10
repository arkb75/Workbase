"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowUp,
  BookOpenCheck,
  Check,
  FileText,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RotateCcw,
  SearchCode,
  Sparkles,
  X,
} from "lucide-react";
import {
  archiveChatThreadAction,
  cancelAgentRunAction,
  createChatThreadAction,
  renameChatThreadAction,
  retryAgentRunAction,
  resolveAgentCandidateAction,
  sendProjectChatMessageAction,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime, titleCase } from "@/src/lib/utils";

export interface ChatWorkspaceThread {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatWorkspaceCitation {
  id: string;
  kind: "highlight" | "evidence" | "artifact" | "github_file";
  label: string;
  excerpt: string;
  url?: string | null;
  path?: string | null;
  commitSha?: string | null;
  highlightId?: string | null;
  evidenceItemId?: string | null;
  artifactId?: string | null;
}

export interface ChatWorkspaceMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  createdAt: string;
  citations: ChatWorkspaceCitation[];
}

export interface ChatWorkspaceEvent {
  id: string;
  runId: string;
  message: string;
  eventType: string;
  createdAt: string;
}

export interface ChatWorkspaceCandidate {
  id: string;
  runId: string;
  kind: "new_highlight" | "revision";
  status: "pending" | "approved" | "denied";
  text: string;
  summary: string;
  visibility: "private" | "resume_safe" | "linkedin_safe" | "public_safe";
  sensitivityFlag: boolean;
  evidenceLabels: string[];
  confidence: "low" | "medium" | "high";
  ownershipClarity: "unclear" | "partial" | "clear";
  risksSummary: string | null;
  missingInfo: string | null;
  tags: string[];
  verificationNotes: string | null;
}

export interface ChatWorkspaceRun {
  id: string;
  status:
    | "queued"
    | "running"
    | "awaiting_review"
    | "completed"
    | "insufficient_context"
    | "failed"
    | "cancelled";
  kind: string;
}

const starterPrompts = [
  {
    icon: BookOpenCheck,
    label: "Summarize my strongest accomplishments",
  },
  {
    icon: SearchCode,
    label: "How does the main architecture work?",
  },
  {
    icon: FileText,
    label: "Write resume bullets emphasizing ownership",
  },
];

function citationHref(citation: ChatWorkspaceCitation, workItemId: string) {
  return (
    citation.url ??
    (citation.highlightId
      ? `/work-items/${workItemId}?tab=highlights`
      : citation.evidenceItemId
        ? `/work-items/${workItemId}?tab=sources`
        : citation.artifactId
          ? `/work-items/${workItemId}?tab=artifacts&artifactId=${citation.artifactId}`
          : null)
  );
}

function MessageContent({
  content,
  citations,
  workItemId,
}: {
  content: string;
  citations: ChatWorkspaceCitation[];
  workItemId: string;
}) {
  return (
    <div className="whitespace-pre-wrap">
      {content.split(/(\[citation:\d+\])/gi).map((part, index) => {
        const match = /^\[citation:(\d+)\]$/i.exec(part);
        if (!match) return <span key={`${index}-${part.slice(0, 12)}`}>{part}</span>;
        const ordinal = Number(match[1]);
        const citation = citations[ordinal - 1];
        if (!citation) return null;
        const href = citationHref(citation, workItemId);
        const chip = (
          <span className="mx-0.5 inline-flex translate-y-[-1px] items-center rounded-full bg-[color:var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[color:var(--accent)] ring-1 ring-[color:var(--accent)]/18">
            {ordinal}
          </span>
        );
        return href ? (
          <a
            key={`${index}-${citation.id}`}
            href={href}
            title={citation.label}
            target={citation.url ? "_blank" : undefined}
            rel={citation.url ? "noreferrer" : undefined}
          >
            {chip}
          </a>
        ) : (
          <span key={`${index}-${citation.id}`} title={citation.label}>{chip}</span>
        );
      })}
    </div>
  );
}

function CitationList({
  citations,
  workItemId,
}: {
  citations: ChatWorkspaceCitation[];
  workItemId: string;
}) {
  if (!citations.length) {
    return null;
  }

  return (
    <details className="group mt-4 border-t border-black/7 pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-[color:var(--ink-muted)] transition hover:text-[color:var(--ink-strong)]">
        <GitBranch className="h-3.5 w-3.5" />
        {citations.length} source{citations.length === 1 ? "" : "s"}
        <span className="transition group-open:rotate-90">›</span>
      </summary>
      <div className="mt-3 grid gap-2">
        {citations.map((citation, index) => {
          const body = (
            <div className="grid gap-1.5 border-l-2 border-[color:var(--accent)]/30 pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[color:var(--ink-strong)]">
                  {index + 1}. {citation.label}
                </span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                  {titleCase(citation.kind)}
                </span>
              </div>
              <p className="line-clamp-3 text-xs leading-5 text-[color:var(--ink-soft)]">
                {citation.excerpt}
              </p>
              {citation.path ? (
                <p className="font-mono text-[10px] text-[color:var(--ink-muted)]">
                  {citation.path}
                  {citation.commitSha ? ` · ${citation.commitSha.slice(0, 8)}` : ""}
                </p>
              ) : null}
            </div>
          );

          const href = citationHref(citation, workItemId);

          return href ? (
            <a
              key={citation.id}
              href={href}
              target={citation.url ? "_blank" : undefined}
              rel={citation.url ? "noreferrer" : undefined}
              className="rounded-xl py-1 transition hover:bg-black/[0.025]"
            >
              {body}
            </a>
          ) : (
            <div key={citation.id}>{body}</div>
          );
        })}
      </div>
    </details>
  );
}

function CandidateCard({
  workItemId,
  threadId,
  candidate,
}: {
  workItemId: string;
  threadId: string;
  candidate: ChatWorkspaceCandidate;
}) {
  if (candidate.status !== "pending") {
    return null;
  }

  return (
    <section className="my-5 overflow-hidden rounded-[24px] border border-[color:var(--accent)]/22 bg-[color:var(--accent-soft)]/45">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--accent)]/12 px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[color:var(--accent)]" />
          <p className="text-sm font-semibold text-[color:var(--ink-strong)]">
            {candidate.kind === "revision" ? "Suggested revision" : "New highlight candidate"}
          </p>
        </div>
        <Badge tone="accent">Review required</Badge>
      </div>
      <div className="grid gap-4 p-5">
        <p className="text-sm leading-6 text-[color:var(--ink-soft)]">{candidate.summary}</p>
        <div className="flex flex-wrap gap-2">
          <Badge>{candidate.confidence} confidence</Badge>
          <Badge>{candidate.ownershipClarity} ownership</Badge>
          <Badge>{candidate.visibility.replace(/_/g, " ")}</Badge>
          {candidate.sensitivityFlag ? <Badge tone="warning">Sensitive</Badge> : null}
          {candidate.tags.slice(0, 4).map((tag) => (
            <Badge key={`${candidate.id}-tag-${tag}`}>{tag.replace(/_/g, " ")}</Badge>
          ))}
        </div>
        {candidate.risksSummary || candidate.missingInfo ? (
          <div className="grid gap-1 rounded-2xl border border-black/7 bg-white/55 px-4 py-3 text-xs leading-5 text-[color:var(--ink-soft)]">
            {candidate.risksSummary ? <p><strong>Risk:</strong> {candidate.risksSummary}</p> : null}
            {candidate.missingInfo ? <p><strong>Missing:</strong> {candidate.missingInfo}</p> : null}
          </div>
        ) : null}
        {candidate.evidenceLabels.length ? (
          <div className="flex flex-wrap gap-2">
            {candidate.evidenceLabels.slice(0, 4).map((label) => (
              <Badge key={`${candidate.id}-${label}`}>{label}</Badge>
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 border-t border-[color:var(--accent)]/12 pt-4 sm:grid-cols-2">
          <form action={resolveAgentCandidateAction} className="grid gap-3">
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="threadId" value={threadId} />
            <input type="hidden" name="candidateId" value={candidate.id} />
            <input type="hidden" name="decision" value="approve" />
            <Textarea
              name="editedText"
              defaultValue={candidate.text}
              aria-label="Edit candidate before approval"
              className="min-h-24 bg-white/75 text-sm leading-6"
              minLength={10}
              maxLength={240}
            />
            <div className="grid grid-cols-[1fr_auto] items-center gap-3">
              <Select name="visibility" defaultValue={candidate.visibility} aria-label="Visibility">
                <option value="private">Private</option>
                <option value="resume_safe">Resume safe</option>
                <option value="linkedin_safe">LinkedIn safe</option>
                <option value="public_safe">Public safe</option>
              </Select>
              <label className="flex items-center gap-2 text-xs text-[color:var(--ink-soft)]">
                <input type="hidden" name="sensitivityFlagPresent" value="true" />
                <input
                  type="checkbox"
                  name="sensitivityFlag"
                  defaultChecked={candidate.sensitivityFlag}
                  className="h-4 w-4 rounded border-black/15 accent-[color:var(--accent)]"
                />
                Sensitive
              </label>
            </div>
            <Textarea
              name="reviewNotes"
              placeholder="Optional review note"
              defaultValue={candidate.verificationNotes ?? ""}
              aria-label="Review notes"
              className="min-h-16 bg-white/75 text-sm leading-6"
              maxLength={1200}
            />
            <Button type="submit" className="w-full gap-2">
              <Check className="h-4 w-4" /> Approve this text
            </Button>
          </form>
          <form action={resolveAgentCandidateAction} className="grid gap-3">
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="threadId" value={threadId} />
            <input type="hidden" name="candidateId" value={candidate.id} />
            <input type="hidden" name="decision" value="deny" />
            <Textarea
              name="feedback"
              placeholder="Why should this be denied? Feedback focuses the final research pass."
              aria-label="Review feedback"
              className="min-h-24 bg-white/75 text-sm leading-6"
              maxLength={1000}
            />
            <Button type="submit" variant="secondary" className="w-full gap-2">
              <X className="h-4 w-4" /> Deny
            </Button>
          </form>
        </div>
      </div>
    </section>
  );
}

export function ProjectChatWorkspace({
  workItemId,
  workItemTitle,
  activeThreadId,
  threads,
  messages,
  events,
  candidates,
  runs,
  sensitiveContextAvailable,
}: {
  workItemId: string;
  workItemTitle: string;
  activeThreadId: string | null;
  threads: ChatWorkspaceThread[];
  messages: ChatWorkspaceMessage[];
  events: ChatWorkspaceEvent[];
  candidates: ChatWorkspaceCandidate[];
  runs: ChatWorkspaceRun[];
  sensitiveContextAvailable: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const activeRuns = runs.filter((run) =>
    ["queued", "running", "awaiting_review"].includes(run.status),
  );
  const activeRunId = activeRuns[0]?.id ?? null;
  const retryableRun = [...runs]
    .reverse()
    .find((run) => ["failed", "insufficient_context", "cancelled"].includes(run.status));
  const latestEvents = useMemo(() => events.slice(-4), [events]);

  useEffect(() => {
    if (!activeRunId) {
      return;
    }

    const source = new EventSource(`/api/agent-runs/${activeRunId}/stream`);
    const refresh = () => router.refresh();
    source.addEventListener("progress", refresh);

    // Persistence in the product database is the source of truth. This slower
    // fallback also recovers UI state if a proxy interrupts the progress stream.
    const interval = window.setInterval(refresh, 8_000);
    return () => {
      source.removeEventListener("progress", refresh);
      source.close();
      window.clearInterval(interval);
    };
  }, [activeRunId, router]);

  return (
    <section className="overflow-hidden rounded-[30px] border border-black/8 bg-white/88 shadow-[0_24px_70px_rgba(15,23,42,0.08)]">
      <div className="grid min-h-[720px] lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="flex flex-col border-b border-black/7 bg-[color:var(--panel-muted)]/72 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-3 border-b border-black/7 px-4 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                Project chat
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-[color:var(--ink-strong)]">
                {workItemTitle}
              </p>
            </div>
            <form action={createChatThreadAction}>
              <input type="hidden" name="workItemId" value={workItemId} />
              <button
                type="submit"
                aria-label="New conversation"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-[color:var(--accent)] shadow-sm ring-1 ring-black/7 transition hover:-translate-y-0.5"
              >
                <Plus className="h-4 w-4" />
              </button>
            </form>
          </div>

          <nav className="grid max-h-64 gap-1 overflow-y-auto p-2 lg:max-h-none lg:flex-1">
            {threads.map((thread) => {
              const active = thread.id === activeThreadId;

              return (
                <div key={thread.id} className="group relative">
                  <Link
                    href={`/work-items/${workItemId}?tab=chat&thread=${thread.id}`}
                    className={cn(
                      "grid gap-1 rounded-2xl px-3 py-3 pr-10 transition",
                      active
                        ? "bg-[color:var(--ink-strong)] text-white shadow-[0_12px_28px_rgba(16,33,43,0.14)]"
                        : "text-[color:var(--ink-soft)] hover:bg-white hover:text-[color:var(--ink-strong)]",
                    )}
                  >
                    <span className={cn("truncate text-sm font-medium", active && "text-white")}>
                      {thread.title}
                    </span>
                    <span className={cn("text-[10px]", active ? "text-white/55" : "text-[color:var(--ink-muted)]")}>
                      {formatDateTime(thread.updatedAt)}
                    </span>
                  </Link>
                  {active ? (
                    <details className="absolute top-2.5 right-2 z-10">
                      <summary className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white">
                        ···
                      </summary>
                      <div className="absolute top-8 right-0 z-20 w-56 rounded-2xl border border-black/8 bg-white p-3 shadow-xl">
                        <form action={renameChatThreadAction} className="grid gap-2">
                          <input type="hidden" name="workItemId" value={workItemId} />
                          <input type="hidden" name="threadId" value={thread.id} />
                          <input
                            name="title"
                            defaultValue={thread.title}
                            maxLength={80}
                            className="h-9 rounded-xl border border-black/10 px-3 text-xs text-[color:var(--ink-strong)] outline-none focus:border-[color:var(--accent)]"
                          />
                          <Button type="submit" size="sm">Rename</Button>
                        </form>
                        <form action={archiveChatThreadAction} className="mt-2">
                          <input type="hidden" name="workItemId" value={workItemId} />
                          <input type="hidden" name="threadId" value={thread.id} />
                          <Button type="submit" size="sm" variant="secondary" className="w-full gap-2">
                            <Archive className="h-3.5 w-3.5" /> Archive
                          </Button>
                        </form>
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </nav>

          <div className="border-t border-black/7 p-4">
            <div className="flex items-start gap-2.5 text-xs leading-5 text-[color:var(--ink-muted)]">
              <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
              <p>Verified highlights lead. Research is cited and repository access stays read-only.</p>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col bg-white">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-black/7 px-5 py-4 sm:px-7">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
                <MessageSquareText className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-[color:var(--ink-strong)]">
                  {threads.find((thread) => thread.id === activeThreadId)?.title ?? "New conversation"}
                </p>
                <p className="text-xs text-[color:var(--ink-muted)]">
                  Private project context · citation-backed answers
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {sensitiveContextAvailable ? <Badge tone="warning">Sensitive context available</Badge> : null}
              {activeRuns.length ? (
                <form action={cancelAgentRunAction}>
                  <input type="hidden" name="workItemId" value={workItemId} />
                  <input type="hidden" name="threadId" value={activeThreadId ?? ""} />
                  <input type="hidden" name="runId" value={activeRuns[0]?.id ?? ""} />
                  <button className="text-xs font-medium text-[color:var(--ink-muted)] hover:text-[color:var(--danger)]">
                    Stop
                  </button>
                </form>
              ) : retryableRun ? (
                <form action={retryAgentRunAction}>
                  <input type="hidden" name="workItemId" value={workItemId} />
                  <input type="hidden" name="runId" value={retryableRun.id} />
                  <button className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--accent)] hover:text-[color:var(--accent-strong)]">
                    <RotateCcw className="h-3.5 w-3.5" /> Retry
                  </button>
                </form>
              ) : null}
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-7">
            {!activeThreadId || !messages.length ? (
              <div className="mx-auto flex min-h-[430px] max-w-2xl flex-col justify-center py-12">
                <p className="font-display text-3xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)] sm:text-4xl">
                  Ask the project, not the prompt.
                </p>
                <p className="mt-3 max-w-xl text-sm leading-6 text-[color:var(--ink-soft)]">
                  Workbase starts with reviewed memory, then calls a bounded research specialist only when the answer needs deeper repository context.
                </p>
                <div className="mt-8 grid gap-2">
                  {starterPrompts.map((prompt) => {
                    const Icon = prompt.icon;
                    return (
                      <button
                        key={prompt.label}
                        type="button"
                        onClick={() => setDraft(prompt.label)}
                        className="group flex items-center gap-3 border-t border-black/7 px-1 py-3 text-left text-sm text-[color:var(--ink-soft)] transition hover:pl-2 hover:text-[color:var(--ink-strong)]"
                      >
                        <Icon className="h-4 w-4 text-[color:var(--accent)]" />
                        <span className="flex-1">{prompt.label}</span>
                        <span className="opacity-0 transition group-hover:opacity-100">→</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-7">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={cn(
                      "grid gap-2",
                      message.role === "user" ? "justify-items-end" : "justify-items-start",
                    )}
                  >
                    <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                      {message.role === "user" ? "You" : "Workbase"}
                    </p>
                    <div
                      className={cn(
                        "max-w-[92%] text-sm leading-7 sm:max-w-[85%]",
                        message.role === "user"
                          ? "rounded-[22px] rounded-br-md bg-[color:var(--ink-strong)] px-5 py-3.5 text-white"
                          : "w-full border-l border-black/8 pl-5 text-[color:var(--ink-strong)]",
                      )}
                    >
                      {message.status === "pending" && !message.content ? (
                        <span className="inline-flex items-center gap-2 text-[color:var(--ink-muted)]">
                          <LoaderCircle className="h-4 w-4 animate-spin" /> Thinking through the project…
                        </span>
                      ) : (
                        <MessageContent
                          content={message.content}
                          citations={message.citations}
                          workItemId={workItemId}
                        />
                      )}
                      {message.role === "assistant" ? (
                        <CitationList citations={message.citations} workItemId={workItemId} />
                      ) : null}
                    </div>
                    <span className="px-1 text-[10px] text-[color:var(--ink-muted)]">
                      {formatDateTime(message.createdAt)}
                    </span>
                  </article>
                ))}

                {latestEvents.length && activeRuns.length ? (
                  <div className="grid gap-2 border-l border-[color:var(--accent)]/20 py-1 pl-5">
                    {latestEvents.map((event, index) => (
                      <div
                        key={event.id}
                        className={cn(
                          "flex items-center gap-2 text-xs",
                          index === latestEvents.length - 1
                            ? "text-[color:var(--ink-strong)]"
                            : "text-[color:var(--ink-muted)]",
                        )}
                      >
                        {index === latestEvents.length - 1 ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[color:var(--accent)]" />
                        ) : (
                          <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
                        )}
                        {event.message}
                      </div>
                    ))}
                  </div>
                ) : null}

                {activeThreadId
                  ? candidates.map((candidate) => (
                      <CandidateCard
                        key={candidate.id}
                        workItemId={workItemId}
                        threadId={activeThreadId}
                        candidate={candidate}
                      />
                    ))
                  : null}
              </div>
            )}
          </div>

          <footer className="border-t border-black/7 bg-white px-4 py-4 sm:px-7">
            {activeThreadId ? (
              <form
                action={sendProjectChatMessageAction}
                className="mx-auto max-w-3xl"
                onSubmit={() => window.setTimeout(() => setDraft(""), 0)}
              >
                <input type="hidden" name="workItemId" value={workItemId} />
                <input type="hidden" name="threadId" value={activeThreadId} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`chat:${activeThreadId}:${messages.length}`}
                />
                <div className="relative rounded-[24px] border border-black/10 bg-[color:var(--panel-muted)]/60 p-2 pr-14 transition focus-within:border-[color:var(--accent)]/45 focus-within:bg-white focus-within:shadow-[0_16px_40px_rgba(15,23,42,0.07)]">
                  <Textarea
                    name="message"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Ask about the work, inspect an implementation, or request an artifact…"
                    className="min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                    required
                    minLength={2}
                    maxLength={4000}
                  />
                  <button
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim() || activeRuns.length > 0}
                    className="absolute right-3 bottom-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--accent)] text-white shadow-[0_10px_24px_rgba(15,118,110,0.25)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-2 px-2 text-[10px] leading-4 text-[color:var(--ink-muted)]">
                  Repository research is read-only. Public artifacts use approved, visibility-safe highlights only.
                </p>
              </form>
            ) : (
              <form action={createChatThreadAction} className="mx-auto max-w-3xl">
                <input type="hidden" name="workItemId" value={workItemId} />
                <Button type="submit" className="w-full gap-2">
                  <Plus className="h-4 w-4" /> Start a conversation
                </Button>
              </form>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}
