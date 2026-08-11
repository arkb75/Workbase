import { describe, expect, it, vi } from "vitest";
import {
  executeProjectChatApplicationTurn,
  projectChatApplicationExecutionMode,
  projectChatTurnWorkflowReference,
} from "@/src/evals/project-chat-application-execution";
import {
  projectChatApplicationScenarios,
  type ProjectChatApplicationScenarioId,
} from "@/src/evals/project-chat-application-runner";

function scenario(id: ProjectChatApplicationScenarioId) {
  return projectChatApplicationScenarios.find((entry) => entry.id === id)!;
}

describe("project-chat application execution", () => {
  it("keeps the entire deterministic mock matrix on the inline path", () => {
    for (const entry of projectChatApplicationScenarios) {
      expect(projectChatApplicationExecutionMode({
        provider: "mock",
        scenario: entry,
      })).toBe("inline_agent");
    }
  });

  it("routes Bedrock freshness-required general chat through the durable workflow", () => {
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("strongest_accomplishments_freshness_follow_up"),
    })).toBe("durable_workflow");
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("repository_knowledge_data_flow"),
    })).toBe("durable_workflow");
  });

  it("routes OpenRouter freshness-required general chat through the same durable workflow", () => {
    expect(projectChatApplicationExecutionMode({
      provider: "openrouter",
      scenario: scenario("strongest_accomplishments_freshness_follow_up"),
    })).toBe("durable_workflow");
    expect(projectChatApplicationExecutionMode({
      provider: "openrouter",
      scenario: scenario("repository_knowledge_data_flow"),
    })).toBe("durable_workflow");
  });

  it("does not pay the workflow refresh cost for ordinary Bedrock memory answers or isolated research sandboxes", () => {
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("memory_answer"),
    })).toBe("inline_agent");
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("strongest_accomplishments"),
    })).toBe("inline_agent");
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("targeted_repository_research"),
    })).toBe("inline_agent");
    expect(projectChatApplicationExecutionMode({
      provider: "bedrock",
      scenario: scenario("prior_turn_provenance"),
    })).toBe("inline_agent");
  });

  it("starts and awaits the registered workflow without invoking inline persistence", async () => {
    const runInline = vi.fn();
    const startDurable = vi.fn().mockResolvedValue("wrun-freshness");
    const waitForDurable = vi.fn().mockResolvedValue(undefined);

    await expect(executeProjectChatApplicationTurn({
      provider: "bedrock",
      scenario: scenario("strongest_accomplishments_freshness_follow_up"),
      runInline,
      startDurable,
      waitForDurable,
    })).resolves.toEqual({
      mode: "durable_workflow",
      workflowId: "wrun-freshness",
    });

    expect(startDurable).toHaveBeenCalledOnce();
    expect(waitForDurable).toHaveBeenCalledExactlyOnceWith("wrun-freshness");
    expect(runInline).not.toHaveBeenCalled();
  });

  it("never falls back to inline writes after a durable start or wait failure", async () => {
    const runInline = vi.fn();
    await expect(executeProjectChatApplicationTurn({
      provider: "bedrock",
      scenario: scenario("strongest_accomplishments_freshness_follow_up"),
      runInline,
      startDurable: vi.fn().mockRejectedValue(new Error("start failed")),
      waitForDurable: vi.fn(),
    })).rejects.toThrow("start failed");
    expect(runInline).not.toHaveBeenCalled();

    await expect(executeProjectChatApplicationTurn({
      provider: "bedrock",
      scenario: scenario("strongest_accomplishments_freshness_follow_up"),
      runInline,
      startDurable: vi.fn().mockResolvedValue("wrun-failed"),
      waitForDurable: vi.fn().mockRejectedValue(new Error("workflow failed")),
    })).rejects.toThrow("workflow failed");
    expect(runInline).not.toHaveBeenCalled();
  });

  it("uses the Workflow SDK metadata identifier registered by the compiler", () => {
    expect(projectChatTurnWorkflowReference).toEqual({
      workflowId: "workflow//./workflows/project-chat//projectChatTurnWorkflow",
    });
  });
});
