import type { ProjectChatApplicationScenario } from "@/src/evals/project-chat-application-runner";
import { requiresLiveRepositoryResearch } from "@/src/services/project-chat-agent-service";

export type ProjectChatApplicationProvider = "mock" | "bedrock";
export type ProjectChatApplicationExecutionMode =
  | "inline_agent"
  | "durable_workflow";

/**
 * `tsx` does not apply the Workflow SDK compiler transform, so a CLI entrypoint
 * cannot pass the source workflow function to `start()`. WorkflowMetadata is a
 * supported `start()` input and addresses the same compiler-registered
 * workflow that the Next.js action starts.
 */
export const projectChatTurnWorkflowReference = {
  workflowId: "workflow//./workflows/project-chat//projectChatTurnWorkflow",
} as const;

function isGeneralProjectChatScenario(
  scenario: ProjectChatApplicationScenario,
) {
  return scenario.workspace === "project_memory" &&
    !scenario.id.startsWith("artifact_");
}

export function projectChatApplicationExecutionMode(input: {
  provider: ProjectChatApplicationProvider;
  scenario: ProjectChatApplicationScenario;
}): ProjectChatApplicationExecutionMode {
  if (
    input.provider === "bedrock" &&
    isGeneralProjectChatScenario(input.scenario) &&
    requiresLiveRepositoryResearch(input.scenario.question)
  ) {
    return "durable_workflow";
  }
  return "inline_agent";
}

export async function executeProjectChatApplicationTurn(input: {
  provider: ProjectChatApplicationProvider;
  scenario: ProjectChatApplicationScenario;
  runInline: () => Promise<void>;
  startDurable: () => Promise<string>;
  waitForDurable: (workflowId: string) => Promise<void>;
}): Promise<{
  mode: ProjectChatApplicationExecutionMode;
  workflowId: string | null;
}> {
  const mode = projectChatApplicationExecutionMode(input);
  if (mode === "inline_agent") {
    await input.runInline();
    return { mode, workflowId: null };
  }

  const workflowId = await input.startDurable();
  await input.waitForDurable(workflowId);
  return { mode, workflowId };
}
