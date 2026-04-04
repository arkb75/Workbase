import { createWorkItemAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { workItemTypeOptions } from "@/src/lib/options";

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
  } = await searchParams;

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
        description="Keep the first draft short and concrete. The notes and claim review flow will add the detail later."
      />

      {error === "invalid" ? (
        <Card className="max-w-3xl border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not create that Work Item yet. Review the highlighted fields
              and try again.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="max-w-3xl">
        <form action={createWorkItemAction}>
          <CardHeader>
            <CardTitle>Work Item details</CardTitle>
            <CardDescription>
              Start with the core metadata. Sources and claims come next.
              Keep the description concrete enough to explain the technical surface and the
              work you actually did.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Title
              </span>
              <Input
                name="title"
                defaultValue={title}
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
                defaultValue={description}
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
                ) : null}
              </label>
            </div>

            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Creating Work Item...">
                Create Work Item
              </SubmitButton>
            </div>
          </CardContent>
        </form>
      </Card>
    </WorkbaseFrame>
  );
}
