import { redirect } from "next/navigation";
import {
  buildWorkItemWorkspaceHref,
  type WorkItemWorkspaceSearchParams,
} from "@/src/lib/work-item-workspace-tabs";

export default async function LegacyArtifactGeneratorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<WorkItemWorkspaceSearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;

  redirect(buildWorkItemWorkspaceHref({
    pathname: `/work-items/${id}`,
    searchParams: query,
    updates: { tab: "artifacts" },
  }));
}
