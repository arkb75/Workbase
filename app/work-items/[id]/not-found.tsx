import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";

export default function WorkItemNotFound() {
  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Project unavailable"
        title="This work item is no longer available"
        description="Workbase could not find this item in your workspace. It may have been deleted, or the link may belong to a different workspace."
        actions={
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-5 py-3 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to projects
          </Link>
        }
      />
    </WorkbaseFrame>
  );
}
