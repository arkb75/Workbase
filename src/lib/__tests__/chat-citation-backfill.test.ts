import { describe, expect, it } from "vitest";
import {
  canonicalCitationOrdinalsOutsideCode,
  isExactLegacyVerificationFailure,
  normalizeLegacyPlainCitationMarkers,
  remapCanonicalCitationMarkers,
  uncitedHistoricalProseBlockCount,
} from "@/src/lib/chat-citation-backfill";

describe("historical chat citation backfill", () => {
  it("repairs only an exact failed generic verifier message with no citations", () => {
    expect(isExactLegacyVerificationFailure({
      content: "The answer could not be verified against its sources.",
      status: "failed",
      citationCount: 0,
    })).toBe(true);
    expect(isExactLegacyVerificationFailure({
      content: "The prior answer quoted “The answer could not be verified against its sources,” but this explanation is valid.",
      status: "failed",
      citationCount: 0,
    })).toBe(false);
    expect(isExactLegacyVerificationFailure({
      content: "The answer could not be verified against its sources.",
      status: "completed",
      citationCount: 0,
    })).toBe(false);
    expect(isExactLegacyVerificationFailure({
      content: "The answer could not be verified against its sources.",
      status: "failed",
      citationCount: 1,
    })).toBe(false);
  });

  it("normalizes only line-ending prose citation clusters", () => {
    const result = normalizeLegacyPlainCitationMarkers(
      [
        "Implemented durable review resumption. [2][4]",
        "The lookup uses `items[2]`, not a citation.",
        "const other = values[4]",
        "```ts",
        "const fenced = values[2]",
        "```",
      ].join("\n"),
      new Set([2, 4]),
    );

    expect(result.content).toContain(
      "Implemented durable review resumption. [citation:2][citation:4]",
    );
    expect(result.content).toContain("`items[2]`");
    expect(result.content).toContain("values[4]");
    expect(result.content).toContain("const fenced = values[2]");
    expect(result.convertedClusterCount).toBe(1);
    expect(result.invalidLegacyCluster).toBe(false);
  });

  it("does not count or rewrite canonical-looking markers inside code", () => {
    const content = [
      "Supported prose. [citation:5]",
      "`[citation:99]`",
      "```txt",
      "[citation:77]",
      "```",
    ].join("\n");

    expect(canonicalCitationOrdinalsOutsideCode(content)).toEqual([5]);
    expect(remapCanonicalCitationMarkers(content, new Map([[5, 1]]))).toBe([
      "Supported prose. [citation:1]",
      "`[citation:99]`",
      "```txt",
      "[citation:77]",
      "```",
    ].join("\n"));
  });

  it("flags factual prose blocks without their own source marker", () => {
    expect(uncitedHistoricalProseBlockCount([
      "### Supported capability",
      "",
      "The implementation uses a durable workflow. [citation:1]",
      "",
      "It also guarantees a global deployment topology.",
    ].join("\n"))).toBe(1);
    expect(uncitedHistoricalProseBlockCount([
      "### Supported capability",
      "",
      "The implementation uses a durable workflow. [citation:1]",
    ].join("\n"))).toBe(0);
  });

  it("reports an invalid legacy cluster instead of deleting its unmatched source", () => {
    const result = normalizeLegacyPlainCitationMarkers(
      "This statement points to an unavailable source. [8]",
      new Set([1, 2]),
    );

    expect(result.content).toContain("[8]");
    expect(result.invalidLegacyCluster).toBe(true);
  });

  it("does not rewrite a reference-style Markdown link as a citation", () => {
    const result = normalizeLegacyPlainCitationMarkers(
      "Read [the architecture guide][1]",
      new Set([1]),
    );

    expect(result.content).toBe("Read [the architecture guide][1]");
    expect(result.convertedClusterCount).toBe(0);
    expect(result.invalidLegacyCluster).toBe(false);
  });

  it("does not rewrite four-space or tab-indented code", () => {
    const result = normalizeLegacyPlainCitationMarkers(
      [
        "    const first = values[1]; [1]",
        "\tconst second = values[1]; [1]",
        "Supported prose statement. [1]",
      ].join("\n"),
      new Set([1]),
    );

    expect(result.content).toContain("    const first = values[1]; [1]");
    expect(result.content).toContain("\tconst second = values[1]; [1]");
    expect(result.content).toContain(
      "Supported prose statement. [citation:1]",
    );
    expect(result.convertedClusterCount).toBe(1);
  });

  it("keeps non-closing fence-like lines inside code until a valid CommonMark closer", () => {
    const result = normalizeLegacyPlainCitationMarkers(
      [
        "```ts",
        "```not-a-close",
        "const first = values[1]; [1]",
        "``` trailing-text-is-not-a-close",
        "const second = values[1]; [1]",
        "```",
        "Supported prose statement. [1]",
      ].join("\n"),
      new Set([1]),
    );

    expect(result.content).toContain("const first = values[1]; [1]");
    expect(result.content).toContain("const second = values[1]; [1]");
    expect(result.content).toContain(
      "Supported prose statement. [citation:1]",
    );
    expect(result.convertedClusterCount).toBe(1);
  });

  it("treats each list item as an independent factual coverage block", () => {
    expect(uncitedHistoricalProseBlockCount([
      "- Durable review resumption is implemented. [citation:1]",
      "- Global deployment is guaranteed in every region.",
    ].join("\n"))).toBe(1);

    expect(uncitedHistoricalProseBlockCount([
      "1. Durable review resumption is implemented. [citation:1]",
      "2. Repository refresh is commit-pinned. [citation:2]",
    ].join("\n"))).toBe(0);
  });
});
