import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({
  deleteWorkItemAction: vi.fn(),
}));

import { DeleteWorkItemButton } from "@/components/work-items/delete-work-item-button";

describe("DeleteWorkItemButton", () => {
  it("renders an accessible destructive action for the selected Work Item", () => {
    const html = renderToStaticMarkup(
      <DeleteWorkItemButton workItemId="work-1" title="Campus research search platform" />,
    );

    expect(html).toContain('name="workItemId" value="work-1"');
    expect(html).toContain('aria-label="Delete Campus research search platform"');
    expect(html).toContain('title="Delete Campus research search platform"');
    expect(html).toContain("cursor-pointer");
  });
});
