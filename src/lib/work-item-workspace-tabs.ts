export const workItemWorkspaceTabs = [
  "sources",
  "highlights",
  "chat",
  "artifacts",
] as const;

export type WorkItemWorkspaceTab = (typeof workItemWorkspaceTabs)[number];

export type WorkItemWorkspaceSearchParams = Record<
  string,
  string | string[] | undefined
>;

function toSearchParams(searchParams: WorkItemWorkspaceSearchParams) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }

  return params;
}

export function readWorkItemWorkspaceTab(
  value: string | undefined,
): WorkItemWorkspaceTab {
  return workItemWorkspaceTabs.includes(value as WorkItemWorkspaceTab)
    ? (value as WorkItemWorkspaceTab)
    : "sources";
}

export function readWorkItemWorkspacePage(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function buildWorkItemWorkspaceHref(input: {
  pathname: string;
  searchParams: WorkItemWorkspaceSearchParams;
  updates: Record<string, string | number | null | undefined>;
}) {
  const params = toSearchParams(input.searchParams);

  for (const [key, value] of Object.entries(input.updates)) {
    if (value == null || value === "") {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return query ? `${input.pathname}?${query}` : input.pathname;
}

export function buildWorkItemWorkspaceTabHrefs(input: {
  pathname: string;
  searchParams: WorkItemWorkspaceSearchParams;
}) {
  const baseParams = toSearchParams(input.searchParams);

  return Object.fromEntries(
    workItemWorkspaceTabs.map((tab) => {
      const params = new URLSearchParams(baseParams);
      params.set("tab", tab);
      return [tab, `${input.pathname}?${params.toString()}`];
    }),
  ) as Record<WorkItemWorkspaceTab, string>;
}
