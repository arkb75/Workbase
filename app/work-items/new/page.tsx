import { createWorkItemAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { ChevronDown, FileText, FolderGit2 } from "lucide-react";
import { getDemoUser } from "@/src/lib/demo-user";
import { workItemTypeOptions } from "@/src/lib/options";
import { titleCase } from "@/src/lib/utils";
import { githubAuthService } from "@/src/services/github-auth-service";

function buildWorkItemTitleFromRepoName(repoName: string) {
  return repoName
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => titleCase(segment))
    .join(" ");
}

function buildWorkItemDescriptionFromRepo(input: {
  fullName: string;
  description: string | null;
}) {
  const repoDescription = input.description?.trim();

  if (repoDescription) {
    return repoDescription;
  }

  return `Imported from GitHub repository ${input.fullName}. Add the specific technical surface and ownership details before generating highlights.`;
}

export default async function NewWorkItemPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    title?: string;
    type?: string;
    description?: string;
    startDate?: string;
    endDate?: string;
    titleError?: string;
    typeError?: string;
    descriptionError?: string;
    startDateError?: string;
    endDateError?: string;
    repoQuery?: string;
    repoId?: string;
    repoFullName?: string;
    attachRepositoryOnCreate?: string;
    githubError?: string;
    manualNotes?: string;
  }>;
}) {
  const {
    error,
    title,
    type,
    description,
    startDate,
    endDate,
    titleError,
    typeError,
    descriptionError,
    startDateError,
    endDateError,
    repoQuery,
    repoId,
    attachRepositoryOnCreate,
    githubError,
    manualNotes,
  } = await searchParams;
  const demoUser = await getDemoUser();
  const githubConnection = await githubAuthService.getConnection(demoUser.id);
  const repositories = githubConnection
    ? await githubAuthService.listRepositories({
        userId: demoUser.id,
        query: repoQuery,
        limit: 18,
      })
    : [];
  const selectedRepository =
    repositories.find((repository) => repository.id === repoId) ??
    (githubConnection && repoId
      ? (
          await githubAuthService.listRepositories({
            userId: demoUser.id,
            limit: 60,
          })
        ).find((repository) => repository.id === repoId)
      : null);

  const effectiveTitle =
    title?.trim() ||
    (selectedRepository ? buildWorkItemTitleFromRepoName(selectedRepository.name) : "");
  const effectiveDescription =
    description?.trim() ||
    (selectedRepository
      ? buildWorkItemDescriptionFromRepo({
          fullName: selectedRepository.fullName,
          description: selectedRepository.description,
        })
      : "");
  const shouldAttachRepositoryOnCreate =
    attachRepositoryOnCreate === "false"
      ? false
      : Boolean(selectedRepository ?? repoId);

  function fieldTone(errorMessage?: string) {
    return errorMessage
      ? "border-rose-300 focus-visible:ring-rose-200"
      : "";
  }

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="New Work Item"
        title="Capture a project or experience."
        description="Keep the first draft short and concrete. Sources and highlight review will add the detail later."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(440px,520px)] lg:items-start">
        <div className="grid gap-6">
          {error === "invalid" ? (
            <Card className="w-full border-amber-200 bg-amber-50 shadow-none">
              <CardContent className="py-4">
                <p className="text-sm leading-6 text-amber-900">
                  Workbase could not create that Work Item yet. Review the highlighted fields
                  and try again.
                </p>
              </CardContent>
            </Card>
          ) : null}

          <Card className="w-full">
            <form id="new-work-item-form" action={createWorkItemAction}>
              <CardHeader>
                <CardTitle>Work Item details</CardTitle>
                <CardDescription>
                  Start with the core metadata. Sources and highlight review come next. Keep the
                  description concrete enough to explain the technical surface and the work you
                  actually did.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Title
              </span>
              <Input
                name="title"
                defaultValue={effectiveTitle}
                placeholder="Example: Internal data quality dashboard"
                aria-invalid={Boolean(titleError)}
                className={fieldTone(titleError)}
              />
              {titleError ? (
                <span className="text-xs leading-5 text-rose-700">{titleError}</span>
              ) : null}
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Type
              </span>
              <Select
                name="type"
                defaultValue={type || "project"}
                aria-invalid={Boolean(typeError)}
                className={fieldTone(typeError)}
              >
                {workItemTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              {typeError ? (
                <span className="text-xs leading-5 text-rose-700">{typeError}</span>
              ) : null}
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Description
              </span>
              <Textarea
                name="description"
                defaultValue={effectiveDescription}
                placeholder="Describe the technical surface, the users, and the problem you were solving."
                aria-invalid={Boolean(descriptionError)}
                className={fieldTone(descriptionError)}
              />
              {descriptionError ? (
                <span className="text-xs leading-5 text-rose-700">{descriptionError}</span>
              ) : (
                <span className="text-xs leading-5 text-[color:var(--ink-muted)]">
                  Minimum 16 characters.
                </span>
              )}
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Start date
                </span>
                <Input
                  name="startDate"
                  type="date"
                  defaultValue={startDate}
                  aria-invalid={Boolean(startDateError)}
                  className={fieldTone(startDateError)}
                />
                {startDateError ? (
                  <span className="text-xs leading-5 text-rose-700">{startDateError}</span>
                ) : null}
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  End date
                </span>
                <Input
                  name="endDate"
                  type="date"
                  defaultValue={endDate}
                  aria-invalid={Boolean(endDateError)}
                  className={fieldTone(endDateError)}
                />
                {endDateError ? (
                  <span className="text-xs leading-5 text-rose-700">{endDateError}</span>
                ) : (
                  <span className="text-xs leading-5 text-[color:var(--ink-muted)]">
                    Optional. Leave blank if it is ongoing.
                  </span>
                )}
              </label>
            </div>

            {selectedRepository ? (
              <>
                <input type="hidden" name="repositoryId" value={selectedRepository.id} />
                <input
                  type="hidden"
                  name="repositoryFullName"
                  value={selectedRepository.fullName}
                />
                <label className="flex items-start gap-3 rounded-[22px] border border-black/8 bg-[color:var(--panel-muted)] px-4 py-4">
                  <input
                    type="checkbox"
                    name="attachRepositoryOnCreate"
                    value="true"
                    defaultChecked={shouldAttachRepositoryOnCreate}
                    className="mt-1 h-4 w-4 rounded border-black/20"
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-[color:var(--ink-strong)]">
                      Attach and import {selectedRepository.fullName} after creation
                    </span>
                    <span className="block text-sm leading-6 text-[color:var(--ink-soft)]">
                      This creates the Work Item first, then imports bounded GitHub evidence
                      into the attached source automatically.
                    </span>
                  </span>
                </label>
              </>
            ) : null}

                <div className="flex items-center gap-3">
                  <SubmitButton pendingLabel="Creating Work Item...">
                    Create Work Item
                  </SubmitButton>
                </div>
              </CardContent>
            </form>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-24">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-black/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,247,242,0.92))]">
              <CardTitle>Sources</CardTitle>
              <CardDescription>
                Start this Work Item from one or more sources. Everything here is optional
                and stays collapsed until you need it.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 bg-[color:var(--surface)] p-4">
              <details className="source-panel" open={Boolean(selectedRepository || githubError)}>
                <summary className="source-panel__summary">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="source-panel__icon source-panel__icon--github">
                      <FolderGit2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[color:var(--ink-strong)]">GitHub</p>
                        <span className="rounded-full bg-black/4 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[color:var(--ink-muted)]">
                          Repo source
                        </span>
                        <span className="rounded-full bg-[rgba(15,118,110,0.08)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[color:var(--accent)]">
                          {githubConnection
                            ? selectedRepository
                              ? selectedRepository.fullName
                              : `Connected as @${githubConnection.login}`
                            : "Not connected"}
                        </span>
                      </div>
                      <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                        Select a repo to prefill the Work Item and attach it on creation.
                      </p>
                    </div>
                  </div>
                  <div className="source-panel__meta">
                    <a
                      href="/api/github/connect?returnTo=/work-items/new"
                      className={`inline-flex h-10 min-w-24 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition ${
                        githubConnection
                          ? "bg-white text-[color:var(--ink-strong)] ring-1 ring-black/10 hover:bg-[color:var(--panel-muted)]"
                          : "bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent-strong)]"
                      }`}
                    >
                      {githubConnection ? "Reconnect" : "Connect"}
                    </a>
                    <span className="source-panel__chevron" aria-hidden="true">
                      <ChevronDown className="h-4 w-4" />
                    </span>
                  </div>
                </summary>

                <div className="source-panel__body">
                  <div className="source-panel__inner">
                    <div className="grid gap-4 border-t border-black/6 bg-[color:var(--panel-muted)] px-4 py-4">
                      {githubConnection ? (
                        <>
                          <form method="GET" className="grid gap-3 md:grid-cols-[1fr_auto]">
                            <Input
                              name="repoQuery"
                              defaultValue={repoQuery}
                              placeholder="Filter by owner, repo, or description"
                            />
                            {repoId ? <input type="hidden" name="repoId" value={repoId} /> : null}
                            {manualNotes ? (
                              <input type="hidden" name="manualNotes" value={manualNotes} />
                            ) : null}
                            <Button type="submit" variant="secondary">
                              Search repos
                            </Button>
                          </form>

                          <div className="grid gap-3">
                            {repositories.length ? (
                              repositories.map((repository) => {
                                const isSelected = repository.id === repoId;

                                return (
                                  <form
                                    key={repository.id}
                                    method="GET"
                                    className={`rounded-[22px] border px-4 py-4 transition ${
                                      isSelected
                                        ? "border-[color:var(--accent)]/30 bg-[rgba(15,118,110,0.06)] shadow-[0_16px_36px_rgba(15,118,110,0.08)]"
                                        : "border-black/8 bg-white hover:border-black/12 hover:bg-[rgba(255,255,255,0.96)]"
                                    }`}
                                  >
                                    <input type="hidden" name="repoId" value={repository.id} />
                                    {repoQuery ? (
                                      <input type="hidden" name="repoQuery" value={repoQuery} />
                                    ) : null}
                                    {manualNotes ? (
                                      <input type="hidden" name="manualNotes" value={manualNotes} />
                                    ) : null}
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div className="space-y-2">
                                        <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em] text-[color:var(--ink-muted)]">
                                          <span>{repository.private ? "Private repo" : "Public repo"}</span>
                                          <span>{repository.defaultBranch}</span>
                                          {isSelected ? <span>Selected</span> : null}
                                        </div>
                                        <div className="space-y-1">
                                          <p className="text-base font-semibold text-[color:var(--ink-strong)]">
                                            {repository.fullName}
                                          </p>
                                          <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                                            {repository.description?.trim() ||
                                              "No repository description provided."}
                                          </p>
                                        </div>
                                      </div>
                                      <Button
                                        type="submit"
                                        variant={isSelected ? "primary" : "secondary"}
                                        size="sm"
                                      >
                                        {isSelected ? "Selected" : "Use repo"}
                                      </Button>
                                    </div>
                                  </form>
                                );
                              })
                            ) : (
                              <div className="rounded-[22px] border border-dashed border-black/10 bg-white px-4 py-5 text-sm leading-6 text-[color:var(--ink-soft)]">
                                {repoQuery
                                  ? "No repositories matched that search."
                                  : "No accessible repositories were returned for this account."}
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="rounded-[22px] border border-dashed border-black/10 bg-white px-4 py-5 text-sm leading-6 text-[color:var(--ink-soft)]">
                          Connect GitHub here to pick a repository and prefill the title and
                          description before you create the Work Item.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </details>

              <details className="source-panel">
                <summary className="source-panel__summary">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="source-panel__icon source-panel__icon--notes">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[color:var(--ink-strong)]">
                          Manual notes
                        </p>
                        <span className="rounded-full bg-black/4 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[color:var(--ink-muted)]">
                          Typed source
                        </span>
                        <span className="rounded-full bg-[rgba(16,33,43,0.05)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[color:var(--ink-muted)]">
                          {manualNotes?.trim() ? "Included on create" : "Optional"}
                        </span>
                      </div>
                      <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                        Add a few concrete notes now if you already know the technical details.
                      </p>
                    </div>
                  </div>
                  <div className="source-panel__meta">
                    <span className="source-panel__chevron" aria-hidden="true">
                      <ChevronDown className="h-4 w-4" />
                    </span>
                  </div>
                </summary>

                <div className="source-panel__body">
                  <div className="source-panel__inner">
                    <div className="border-t border-black/6 bg-[color:var(--panel-muted)] px-4 py-4">
                      <label className="grid gap-2">
                        <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                          Source notes
                        </span>
                        <Textarea
                          name="manualNotes"
                          form="new-work-item-form"
                          defaultValue={manualNotes}
                          placeholder="Example: Built the dashboard in Next.js, added Prisma filters for internal/public data, and created CSV normalization scripts."
                          className="min-h-32"
                        />
                        <span className="text-xs leading-5 text-[color:var(--ink-muted)]">
                          If you add notes here, Workbase will create a manual-note source
                          automatically after the Work Item is created.
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </details>

              {selectedRepository ? (
                <div className="rounded-[22px] border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm leading-6 text-emerald-900">
                  <p className="font-medium">Selected repository: {selectedRepository.fullName}</p>
                  <p>
                    Workbase is prefilling the title and description from this repo and will
                    attach and import it after creation unless you turn that off below.
                  </p>
                </div>
              ) : null}

              {githubError === "config" ? (
                <div className="rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900">
                  GitHub is not fully configured in this environment yet.
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </WorkbaseFrame>
  );
}
