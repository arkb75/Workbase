import { describe, expect, it } from "vitest";
import {
  buildProjectChatTurnPlanPrompts,
  compactProjectChatPlanningTranscript,
  PROJECT_CHAT_TURN_PLAN_VERSION,
  readStoredProjectChatTurnPlan,
  sanitizeProjectChatTurnPlanPromptInput,
} from "@/src/services/project-chat-turn-planner-service";

const conversation = [
  {
    role: "user",
    content: "Summarize my strongest accomplishments.",
    usedSources: [],
  },
  {
    role: "assistant",
    content: "You built the repository knowledge lifecycle.",
    usedSources: [{ ordinal: 1, kind: "project_fact", label: "Knowledge lifecycle" }],
  },
];

function prompts(currentRequest: string) {
  return buildProjectChatTurnPlanPrompts({
    currentRequest,
    conversation,
    rollingSummary: "The conversation is about accomplishments.",
    workItem: { title: "Workbase", type: "software_project" },
    repositories: [{
      sourceId: "source-1",
      label: "arkb75/Workbase",
      repository: "arkb75/Workbase",
    }],
  });
}

describe("project-chat semantic planning contract", () => {
  it.each([
    "make sure your understanding is up to date",
    "is that current?",
    "refresh what you know, then answer that again",
    "recheck the repo and update the answer",
  ])("passes freshness paraphrase %j with the same complete context", (currentRequest) => {
    const result = prompts(currentRequest);
    const input = JSON.parse(result.userPrompt) as Record<string, unknown>;
    expect(input.currentRequest).toBe(currentRequest);
    expect(input.conversation).toEqual(conversation);
    expect(input.rollingSummary).toBe("The conversation is about accomplishments.");
    expect(result.systemPrompt).toContain("Resolve pronouns, ellipsis, freshness follow-ups");
    expect(result.systemPrompt).toContain("Small wording changes must not change the objective");
  });

  it.each([
    "give me a matrix of the models and what each is for",
    "put the model-to-purpose mapping in a grid",
    "show rows by purpose and columns for provider and model",
    "compare the active models side by side",
  ])("leaves format paraphrase %j intact for semantic interpretation", (currentRequest) => {
    const result = prompts(currentRequest);
    const input = JSON.parse(result.userPrompt) as Record<string, unknown>;
    expect(input.currentRequest).toBe(currentRequest);
    expect(result.systemPrompt).toContain("matrix, grid, comparison table, columns");
    expect(input.availableAnswerTools).toContain("inspect_runtime_model_profiles");
  });

  it("accepts only a versioned durable model plan", () => {
    const plan = {
      version: PROJECT_CHAT_TURN_PLAN_VERSION,
      objective: "Show the active runtime model mapping.",
      action: "answer",
      allowRepositoryResearch: false,
      knowledgeQueries: [],
      outputFormat: "comparison grid",
      outputRequirements: ["Include the purpose of every profile."],
      reasonCodes: ["runtime_configuration"],
      confidence: 0.95,
      generationRunId: "generation-1",
    };
    expect(readStoredProjectChatTurnPlan({ projectChatTurnPlan: plan })).toEqual(plan);
    expect(readStoredProjectChatTurnPlan({
      projectChatTurnPlan: { ...plan, version: "legacy-regex-router-v1" },
    })).toBeNull();
  });

  it("keeps the newest chronological context window on long threads", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index + 1}`,
      sequence: index + 1,
      role: index % 2 ? "assistant" : "user",
      status: "completed",
      content: `turn ${index + 1}`,
      citations: [],
    })).reverse();
    const compacted = compactProjectChatPlanningTranscript(messages, "not-present");
    expect(compacted).toHaveLength(12);
    expect(compacted[0]?.content).toBe("turn 19");
    expect(compacted.at(-1)?.content).toBe("turn 30");
  });

  it("redacts credential-shaped text from every planner prompt field", () => {
    const secret = `ghp_${"a".repeat(32)}`;
    const safe = sanitizeProjectChatTurnPlanPromptInput({
      currentRequest: `Use ${secret}`,
      conversation: [{
        role: "user",
        content: `Earlier ${secret}`,
        usedSources: [{ ordinal: 1, kind: "evidence", label: secret }],
      }],
      rollingSummary: `Summary ${secret}`,
      workItem: { title: secret, type: "project" },
      repositories: [{ sourceId: "source-1", label: secret, repository: secret }],
    });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED GITHUB TOKEN]");
  });
});
