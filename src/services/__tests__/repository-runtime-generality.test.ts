import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeFiles = [
  "src/services/repository-coverage-service.ts",
  "src/services/repository-knowledge-synthesis-service.ts",
  "src/services/repository-semantic-orchestrator-service.ts",
  "src/services/knowledge-staleness-service.ts",
];

describe("repository knowledge runtime generality", () => {
  it("does not encode the Workbase repository's paths, ontology, or accomplishments", () => {
    const runtime = runtimeFiles.map((path) =>
      readFileSync(resolve(process.cwd(), path), "utf8")
    ).join("\n");

    for (const repositorySpecificPattern of [
      /arkb75\/workbase/i,
      /src\/lib\/openrouter-client\.ts/i,
      /workflows\/project-chat\.ts/i,
      /src\/services\/project-chat-store\.ts/i,
      /src\/services\/agent-run-workflow-start-service\.ts/i,
      /project_chat_grounding/i,
      /repository_knowledge_lifecycle/i,
      /knowledge_review_lifecycle/i,
      /artifact_generation/i,
      /replays completed repository reconciliation/i,
      /claim a released shared refresh/i,
      /conditionally reserves an unstarted queued run/i,
      /serializes chat-run creation/i,
    ]) {
      expect(runtime).not.toMatch(repositorySpecificPattern);
    }
  });
});
