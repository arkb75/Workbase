import { beforeEach, describe, expect, it, vi } from "vitest";

const notFoundSignal = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
const notFoundMock = vi.hoisted(() => vi.fn((): never => {
  throw notFoundSignal;
}));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

import {
  isMissingPrismaRecordError,
  loadWorkItemRouteData,
} from "@/src/lib/work-item-route";

describe("work item route loading", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
  });

  it("returns successfully loaded route data unchanged", async () => {
    const value = { id: "work-item-1" };

    await expect(loadWorkItemRouteData(async () => value)).resolves.toBe(value);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("turns Prisma P2025 into the Next.js not-found boundary", async () => {
    const missing = Object.assign(new Error("No record was found for a query."), {
      code: "P2025",
    });

    expect(isMissingPrismaRecordError(missing)).toBe(true);
    await expect(loadWorkItemRouteData(async () => {
      throw missing;
    })).rejects.toBe(notFoundSignal);
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("preserves unexpected database failures for the error boundary", async () => {
    const unavailable = Object.assign(new Error("Database unavailable"), {
      code: "P1001",
    });

    expect(isMissingPrismaRecordError(unavailable)).toBe(false);
    await expect(loadWorkItemRouteData(async () => {
      throw unavailable;
    })).rejects.toBe(unavailable);
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
