import { describe, expect, it } from "vitest";

import { selectLatestStaticAnalysisCacheCandidates } from "@/src/services/knowledge-refresh-service";

describe("repository static-analysis cache selection", () => {
  it("keeps the newest preordered candidate for each source, path, and blob", () => {
    const newest = {
      id: "newest",
      path: "src/service.ts",
      blobSha: "blob-1",
      snapshot: { sourceId: "source-a" },
    };
    const older = { ...newest, id: "older" };
    const selected = selectLatestStaticAnalysisCacheCandidates([newest, older]);

    expect(selected.get("source-a:src/service.ts:blob-1")).toBe(newest);
    expect(selected).toHaveLength(1);
  });

  it("does not cross repository-source boundaries for identical paths and blobs", () => {
    const sourceA = {
      id: "source-a-cache",
      path: "src/service.ts",
      blobSha: "shared-blob",
      snapshot: { sourceId: "source-a" },
    };
    const sourceB = {
      id: "source-b-cache",
      path: "src/service.ts",
      blobSha: "shared-blob",
      snapshot: { sourceId: "source-b" },
    };
    const selected = selectLatestStaticAnalysisCacheCandidates([sourceA, sourceB]);

    expect(selected.get("source-a:src/service.ts:shared-blob")).toBe(sourceA);
    expect(selected.get("source-b:src/service.ts:shared-blob")).toBe(sourceB);
    expect(selected).toHaveLength(2);
  });
});
