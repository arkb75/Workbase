import { describe, expect, it } from "vitest";
import { filterSupersededProjectClaims } from "@/src/services/project-knowledge-policy";

describe("project knowledge conflict policy", () => {
  it("removes stale blanket review claims from every source kind when current lifecycle memory exists", () => {
    const current = {
      subsystemKey: "knowledge_review_lifecycle",
      title: "Safe changes auto-apply",
      content: "Safe knowledge changes are auto-applied and shown in an update inbox for later review.",
    };
    const staleReadme = {
      subsystemKey: null,
      title: "Imported README",
      content: "A mandatory human review gate requires every Claim to be approved before any use.",
    };
    const architecture = {
      subsystemKey: "ai_runtime",
      title: "Bounded agent runtime",
      content: "The agent runtime enforces bounded tool and token budgets.",
    };

    expect(filterSupersededProjectClaims([staleReadme, architecture], [current, staleReadme, architecture]))
      .toEqual([architecture]);
  });

  it("retains the separately scoped public-artifact approval invariant", () => {
    const entries = [{
      subsystemKey: "artifact_generation",
      title: "Public artifact policy",
      content: "Public artifacts use approved Highlights only.",
    }];
    expect(filterSupersededProjectClaims(entries, [{
      subsystemKey: "knowledge_review_lifecycle",
      title: "Review later",
      content: "Safe changes auto-apply for later review.",
    }, ...entries])).toEqual(entries);
  });
});
