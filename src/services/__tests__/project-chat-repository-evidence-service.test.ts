import { describe, expect, it } from "vitest";
import {
  compactProjectRepositoryEvidence,
  createProjectRepositoryRawEvidence,
  expandProjectRepositoryEvidence,
} from "@/src/services/project-chat-repository-evidence-service";

function evidence(output: string, args = ["log", "--stat", "-50"]) {
  return createProjectRepositoryRawEvidence({
    sourceId: "source-1",
    repository: "acme/ledger",
    commitSha: "a".repeat(40),
    args,
    output,
  });
}

describe("project repository evidence boundary", () => {
  it("returns a small command as one exact citable segment", () => {
    const raw = evidence("commit a1\nAuthor: Ada\n\n    add ledger reconciliation");
    const [segment] = compactProjectRepositoryEvidence({
      evidence: raw,
      objective: "Who added reconciliation?",
      maximumBytes: 8_192,
      maximumSegments: 3,
    });
    expect(segment?.excerpt).toBe(raw.output);
    expect(segment).toMatchObject({
      evidenceId: raw.evidenceId,
      startLine: 1,
      endLine: 4,
      truncated: false,
    });
  });

  it("selects bounded exact slices for varied objectives without summarizing source text", () => {
    const lines = Array.from({ length: 600 }, (_, index) =>
      index === 377
        ? "src/payments/reconcile.ts:88: export function settleOutstandingBalance()"
        : `src/generated/module-${index}.ts:1: export const value${index} = ${index};`
    );
    const raw = evidence(lines.join("\n"), ["grep", "-n", "settle", "HEAD", "--", "src"]);
    const segments = compactProjectRepositoryEvidence({
      evidence: raw,
      objective: "Where does the project settle outstanding balances?",
      maximumBytes: 8_192,
      maximumSegments: 3,
    });
    const visible = segments.map((segment) => segment.excerpt).join("\n");
    expect(Buffer.byteLength(visible, "utf8")).toBeLessThanOrEqual(8_192);
    expect(visible).toContain("settleOutstandingBalance");
    expect(visible).not.toContain("module-250.ts");
    for (const segment of segments) {
      expect(raw.output.split("\n").slice(
        segment.startLine - 1,
        segment.endLine,
      ).join("\n")).toContain(segment.excerpt);
      expect(segment.outputHash).toBe(raw.outputHash);
      expect(segment.truncated).toBe(true);
    }
  });

  it("expands an exact requested line range while preserving immutable provenance", () => {
    const raw = evidence(Array.from({ length: 200 }, (_, index) =>
      `line ${index + 1}`
    ).join("\n"));
    const segment = expandProjectRepositoryEvidence({
      evidence: raw,
      startLine: 95,
      maximumLines: 12,
      maximumBytes: 8_192,
    });
    expect(segment).toMatchObject({
      evidenceId: raw.evidenceId,
      outputHash: raw.outputHash,
      startLine: 95,
      endLine: 106,
      truncated: true,
    });
    expect(segment?.excerpt).toBe(
      Array.from({ length: 12 }, (_, index) => `line ${index + 95}`).join("\n"),
    );
  });
});
