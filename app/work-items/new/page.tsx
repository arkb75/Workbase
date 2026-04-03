import { createWorkItemAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { workItemTypeOptions } from "@/src/lib/options";

export default function NewWorkItemPage() {
  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="New Work Item"
        title="Capture a project or experience."
        description="Keep the first draft short and concrete. The notes and claim review flow will add the detail later."
      />

      <Card className="max-w-3xl">
        <form action={createWorkItemAction}>
          <CardHeader>
            <CardTitle>Work Item details</CardTitle>
            <CardDescription>
              Start with the core metadata. Sources and claims come next.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Title
              </span>
              <Input name="title" placeholder="Example: Internal data quality dashboard" />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Type
              </span>
              <Select name="type" defaultValue="project">
                {workItemTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Description
              </span>
              <Textarea
                name="description"
                placeholder="Describe the technical surface, the users, and the problem you were solving."
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Start date
                </span>
                <Input name="startDate" type="date" />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                  End date
                </span>
                <Input name="endDate" type="date" />
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
