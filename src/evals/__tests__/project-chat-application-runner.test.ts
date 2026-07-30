import { describe, expect, it, vi } from "vitest";
import {
  evaluateProjectChatApplicationObservation,
  projectChatApplicationScenarios,
  runProjectChatApplicationScenarios,
  type ProjectChatApplicationDriver,
  type ProjectChatApplicationMetrics,
  type ProjectChatApplicationObservation,
  type ProjectChatApplicationScenario,
} from "@/src/evals/project-chat-application-runner";

const zeroMetrics: ProjectChatApplicationMetrics = {
  latencyMs: 10,
  modelCalls: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  usageComplete: true,
  modelAttribution: {
    providers: [],
    configuredModelIds: [],
    actualModelIds: [],
    routedProviders: [],
    requestIds: [],
    failedModelIds: [],
    providerAttempts: 0,
    failedProviderAttempts: 0,
    fallbackUsed: false,
  },
  repositoryTreeLookups: 0,
  repositorySearches: 0,
  repositoryFileReads: 0,
  repositoryVisibleBytes: 0,
};

function citedProjectAnswer(
  base: ProjectChatApplicationObservation,
  answer: string,
): ProjectChatApplicationObservation {
  const citationOrdinals = Array.from(answer.matchAll(/\[citation:(\d+)\]/giu))
    .map((match) => Number(match[1]));
  const citationCount = Math.max(0, ...citationOrdinals);
  return {
    ...base,
    answer,
    citationCount,
    citationKinds: Array.from({ length: citationCount }, () => "project_fact"),
    citationOrdinals,
    citationMetadata: Array.from({ length: citationCount }, (_, index) => ({
      ordinal: index + 1,
      type: "project_fact",
      title: `Source ${index + 1}`,
      statement: answer,
    })),
  };
}

function successfulObservation(
  scenario: ProjectChatApplicationScenario,
  historyMessageCount: number,
): ProjectChatApplicationObservation {
  const base: ProjectChatApplicationObservation = {
    scenarioId: scenario.id,
    runId: `run-${scenario.id}`,
    threadId: `thread-${scenario.threadKey}`,
    workItemId: `work-item-${scenario.workspace}`,
    outcome: "answered",
    answer: "The workflow retries a bounded step because doing so preserves durable progress. [citation:1]",
    citationCount: 1,
    citationKinds: ["project_fact"],
    citationOrdinals: [1],
    citationMetadata: [{
      ordinal: 1,
      type: "project_fact",
      title: "Bounded durable workflow",
      statement: "The workflow retries a bounded step because doing so preserves durable progress.",
    }],
    tools: [],
    historyMessageCount,
    historyCharacterCount: historyMessageCount * 200,
    historyCitationManifestCount: Math.floor(historyMessageCount / 2),
    rollingSummaryCharacterCount: 0,
    rollingSummaryPreservedOpeningDecision: false,
    rollingSummaryPreservedCitationManifest: false,
    historyPreservedCurrentRuntimeContext: false,
    candidate: null,
    artifact: null,
    coverageGaps: [],
    metrics: { ...zeroMetrics },
    error: null,
  };
  switch (scenario.id) {
    case "memory_answer":
      return citedProjectAnswer(
        base,
        "The career-content product uses repository knowledge refresh and grounded multi-turn project chat. [citation:1][citation:2][citation:3]",
      );
    case "strongest_accomplishments":
      return citedProjectAnswer(base, `## Strongest accomplishments

### 1. Career-content product and trusted artifacts
Built a career-content platform that turns repository evidence into resume bullets, LinkedIn content, and project summaries. It does this by routing reusable Highlights into artifact generation, which keeps outputs useful while preserving source-backed trust. [citation:1]

### 2. Repository intelligence
Designed a repository knowledge lifecycle that snapshots current code, performs semantic analysis, and reconciles the result into reusable Project Facts. This gives the product current implementation memory without forcing every question to rescan the repository. [citation:2]

### 3. Grounded project agent
Implemented multi-turn project chat using retrieval, claim-local citations, and bounded repository research when approved memory is insufficient. The separation keeps routine questions fast while still allowing focused code investigation without exposing raw explored files as peer sources. [citation:3]

### 4. Durable AI platform
Combined Bedrock structured generation with durable workflow orchestration, explicit budgets, and retry-safe boundaries. This allows long-running AI work to recover from transient failures without losing progress or silently returning unsupported claims. [citation:4]

### 5. Governed knowledge lifecycle
Built review, supersession, staleness reconciliation, and provenance handling around Highlights and Project Facts. By preserving reviewed successors and evidence links, Workbase can update what it knows while keeping downstream artifacts and answers auditable. [citation:5]`);
    case "recruiter_top_three":
      return citedProjectAnswer(base, `## Top three accomplishments

1. **Built the career-content product end to end.** Workbase turns repository evidence into grounded resume bullets and project summaries by using reviewed Highlights, which makes the product outcome both practical and trustworthy. [citation:1]

2. **Designed repository intelligence rather than a one-shot summarizer.** A semantic refresh pipeline converts current code into reusable Project Facts and reconciles stale knowledge, enabling fast future answers while preserving commit-backed provenance. [citation:2]

3. **Implemented a grounded, durable AI agent.** Multi-turn project chat combines retrieval, citations, bounded research, Bedrock structured generation, and retry-safe workflow boundaries, which supports technically deep answers without sacrificing control or recovery. [citation:3]`);
    case "concise_project_overview":
      return citedProjectAnswer(base, `Workbase is a career-content product that turns evidence from a software project into trustworthy resume bullets, LinkedIn content, and project summaries. It uses reviewed Highlights and Project Facts rather than sending raw notes directly to public artifact generation, which lets a hiring manager see useful outcomes while preserving a clear source trail and review lifecycle. [citation:1]

The notable engineering is the repository intelligence and grounded project agent behind that experience. Workbase refreshes and reconciles code into reusable knowledge, then combines multi-turn retrieval and citations with bounded research only when current memory is insufficient; Bedrock generation runs inside durable workflow boundaries so longer operations can recover without inventing unsupported results. [citation:2]`);
    case "repository_knowledge_data_flow":
      return citedProjectAnswer(base, `### 1. Pin and scope the repository view
Workbase uses repository refresh to pin each attached GitHub repository to a current immutable snapshot. It selects bounded, relevant files and rejects unsafe or unsupported content, which enables later analysis to work from a stable evidence boundary rather than an arbitrary live file view. [citation:1]

### 2. Analyze and synthesize supported knowledge
Semantic workers inspect capability-focused batches and preserve exact excerpts in a compact notebook. The synthesis stage turns only supported observations into Project Fact or Highlight candidates, retaining provenance so reusable knowledge can be checked against the repository evidence that produced it. [citation:2]

### 3. Reconcile the durable knowledge lifecycle
Reconciliation applies safe candidates, supersedes stale statements, and retains quarantined items for review. By separating current reviewed memory from rejected or stale knowledge, retrieval can favor trustworthy facts without erasing the audit trail. [citation:3]

### 4. Decide whether chat memory is sufficient
Project chat first uses conversation history and retrieved Project Facts or Highlights. If those sources leave a specific gap, it delegates bounded targeted research; supported findings become durable memory with provenance, while an unsupported gap returns as insufficient context instead of an invented answer. [citation:4]`);
    case "architecture_assessment":
      return citedProjectAnswer(base, `### Strength: knowledge is a governed product primitive
The architecture turns repository and user evidence into reviewed Project Facts and Highlights before reusing it. By coupling retrieval to provenance and lifecycle state, Workbase can support grounded chat and career artifacts without treating every raw input as equally authoritative. [citation:1]

### Strength: broad refresh and targeted research are separate
Repository intelligence handles broad currency, while the project agent delegates bounded research for a focused gap. This separation enables reusable coverage without paying the cost of a full scan on every question, and keeps exploratory files out of the final source list unless promoted into durable memory. [citation:2]

### Risk: semantic coverage and freshness are operational dependencies
The quality of answers still depends on repository analysis selecting the right files and reconciling current facts promptly. That constraint matters because incomplete refresh coverage can leave a real capability underrepresented even when the answer is technically grounded in the sources it did retrieve. [citation:3]

### Trade-off: stronger safeguards add latency and complexity
Structured verification, citation pruning, durable workflows, and review state make unsupported output less likely, but they cost extra model calls and lifecycle coordination. The architecture is strongest when caching and incremental refresh keep those safeguards proportionate to the question. [citation:4]`);
    case "design_tradeoffs":
      return citedProjectAnswer(base, `## Three design tradeoffs

1. **Durable memory versus direct raw-code answers.** Workbase routes repository knowledge refresh through Project Facts and Highlights, which enables reuse, review, and stable citations without exposing raw explored files. The cost is extra synthesis and reconciliation before new discoveries can become ordinary project memory. [citation:1]

2. **Broad refresh versus targeted research.** Semantic refresh builds wide current coverage, while bounded research resolves a specific gap. This enables fast memory-backed chat most of the time, but requires routing logic and can return a declared coverage limit when the bounded pass cannot support an answer. [citation:2]

3. **Strict grounding versus latency and flexibility.** Citation pruning and source verification prevent explored-but-unused files from appearing as support and reduce unsupported claims. The benefit is trust; the cost is additional validation work and occasional insufficient-context responses instead of a fluent guess. [citation:3]`);
    case "compare_refresh_and_research":
      return citedProjectAnswer(base, `| Path | Best for | How it works | Trusted-memory outcome |
| --- | --- | --- | --- |
| Repository knowledge refresh | Broad currency across the attached repository | Uses commit-pinned snapshots and semantic capability batches, then reconciles supported findings against existing knowledge | Applies supported Project Facts and Highlights while marking stale memory for review [citation:1] |
| Targeted repository research | A focused code question that current memory cannot answer | Uses a bounded tree, search, and file-read pass around the explicit gap | Promotes supported findings into Project Facts or Highlights with nested provenance; otherwise reports the gap [citation:2] |

By using refresh for broad coverage and targeted research for a specific gap, Workbase keeps common chat turns fast while preserving a trustworthy path from new repository evidence to reusable memory.`);
    case "focused_citation_behavior":
      return citedProjectAnswer(base, `Workbase separates **exploration** from **final support**. Repository search hits and file reads can help the specialist understand a gap, but they remain internal explored evidence; they do not automatically become citations shown beside the answer.

Before persistence, the answer pipeline keeps only citation ordinals that its factual blocks actually reference and compacts those ordinals. If an explored excerpt supports reusable knowledge, Workbase promotes it beneath a reviewed Project Fact or Highlight as nested provenance, so the durable memory—not every explored file—appears as the peer source. This filtering allows focused research without presenting unused repository files as evidence for claims they did not support. [citation:1]`);
    case "durable_runtime_deep_dive":
      return citedProjectAnswer(base, `## Bedrock tool-loop boundary

The Bedrock agent runtime owns one bounded reasoning turn: it normalizes tool-use stop reasons, counts iterations and tool calls, applies token budgets, and stops additional exploration when a limit is reached. By enforcing those controls inside the tool loop, a single model invocation cannot expand into unbounded repository work, and the runtime can preserve a partial notebook for supported output. [citation:1]

## Durable workflow boundary

The durable workflow owns progress across turns and failures. It persists the agent run, progress events, review state, and resume points around chat or artifact steps; this lets transient execution retry without replaying already durable decisions or duplicating candidates and artifacts. [citation:2]

## Recovery across both layers

When the tool loop reaches a budget, Workbase finalizes from accumulated supported findings rather than starting more reads. When a durable step fails, persisted state supports retry or an explicit insufficient-context result, so recovery preserves verified work while avoiding unrelated subsystem scans or silent guesses. [citation:3]`);
    case "security_posture":
      return citedProjectAnswer(base, "Workbase redacts credentials and secrets before exposing model events, and bounded repository authorization limits reads to attached repositories. The model-facing runtime also enforces tool, token, and iteration budgets, so repository content remains untrusted input inside a constrained execution boundary rather than becoming an instruction source. [citation:1]");
    case "repository_auth_permissions":
      return citedProjectAnswer(base, "GitHub OAuth authorizes repository access, while project ownership and the attached-repository relationship enforce permission boundaries. The research specialist receives only read-only tools for those authorized sources, which keeps an arbitrary repository name in chat from expanding the project’s access scope. [citation:1]");
    case "resilience_recovery":
      return citedProjectAnswer(base, "Durable workflow state persists progress and supports resume or explicit recovery when a bounded model turn or dependency fails. Agent runs and progress events preserve the observable state around each step, while idempotent persistence prevents a resumed attempt from duplicating already-saved knowledge or artifacts. [citation:1]");
    case "artifact_fallback_behavior":
      return citedProjectAnswer(base, "Artifact generation starts from approved Highlights; when they are insufficient, bounded research identifies an evidence gap or produces supported memory instead of fabricating an artifact. Supported discoveries enter the governed knowledge lifecycle before generation resumes, while a missing metric remains an explicit insufficient-evidence result. [citation:1]");
    case "frontend_review_experience":
      return citedProjectAnswer(base, `Workbase provides a project workspace where a user can move between source evidence, Highlights, Project Facts, generated artifacts, and multi-turn chat without losing the project boundary. Inline citation navigation connects an answer or artifact back to the durable memory that supports it, so the interface exposes why a claim is trustworthy instead of presenting AI output as an unexplained result. [citation:1]

The review experience distinguishes lifecycle state from review state. Safe new or updated knowledge can become active immediately while remaining visibly pending for later review; unsafe or ambiguous candidates stay quarantined. Users can edit, supersede, reject, restore, or retire knowledge, and dependent artifacts retain their provenance rather than silently inheriting a changed statement. [citation:2]`);
    case "data_model_lifecycle":
      return citedProjectAnswer(base, `## Project-knowledge lifecycle

1. **Persist typed durable memory.** The Prisma data model stores Evidence, Highlights, Project Facts, Artifacts, chat messages and citations, repository snapshots, and AgentRuns as related project-scoped records. Exact provenance relations preserve which immutable evidence supported each reusable statement, while embeddings and searchable text make approved memory retrievable. [citation:1]

2. **Correct knowledge without rewriting history.** Edits create a new version that supersedes the prior statement; repository reconciliation can mark knowledge stale when its supporting code changes, and retirement removes an item from active retrieval without deleting its audit trail. Embeddings and downstream dependency state are refreshed or invalidated as the lifecycle changes, so chat and artifacts do not quietly reuse an obsolete version. [citation:2]`);
    case "testing_strategy":
      return citedProjectAnswer(base, `Workbase uses Vitest unit and integration tests for the rules that make AI output trustworthy: retrieval authority, citation pruning and grounding, candidate lifecycle transitions, artifact safety, GitHub authorization and bounded exploration, Bedrock tool-loop limits, and durable workflow recovery. That coverage tests failure behavior as well as happy paths, including unsupported questions and provider failures. [citation:1]

It also maintains scenario evaluations for multi-turn chat, broad and focused project questions, missing evidence, repository research, artifact routing, and cost or latency budgets. Those application-level checks are meaningful because they measure the user-visible contract—useful, prioritized, cited answers without unrelated repository work—not merely whether individual functions execute. [citation:2]`);
    case "github_ingestion_flow":
      return citedProjectAnswer(base, `GitHub OAuth establishes the authenticated connection, and Workbase then authorizes access through the current user, Work Item, and repository attachment rather than trusting an arbitrary repository name from chat. The bounded importer turns repository metadata, the README, commits, pull requests, issues, releases, and changed paths into project-scoped Sources and Evidence that can be reused without live API work on every question. [citation:1]

Code-level exploration is a separate path for a specific unresolved gap. Its tree, search, file-read, byte, and time budgets constrain what the specialist can inspect at a pinned commit, with binary, oversized, generated, and secret-like content rejected. Useful findings are promoted into a Project Fact or Highlight with exact nested excerpts; raw explored files do not become peer citations merely because the agent opened them. [citation:2]`);
    case "known_limitations":
      return citedProjectAnswer(base, `## Three current limitations

1. **Knowledge quality depends on semantic coverage.** Repository refresh uses bounded capability batches rather than unbounded inspection, so an important implementation can remain underrepresented if routing or synthesis misses the decisive files. This matters because a grounded answer can still be incomplete when the durable memory itself lacks a major capability; coverage audits and explicit gaps reduce, but do not eliminate, that dependency. [citation:1]

2. **Strict grounding adds latency and operational complexity.** Verification, citation pruning, durable persistence, and lifecycle reconciliation protect against unsupported claims, but each mechanism adds work around a model response. This matters for interactive chat cost and speed, making incremental refresh, caching, and history-first routing essential rather than optional optimizations. [citation:2]

3. **Unsupported real-world impact remains unknowable from code alone.** Workbase separates repository-backed architecture from production outcomes that require telemetry or user-supplied evidence, which prevents code from being misrepresented as proof of adoption, p95 latency, or business impact. This matters for career artifacts because the safest behavior is an explicit evidence gap, even when a more impressive quantified claim would sound better. [citation:3]`);
    case "typo_repository_refresh":
      return citedProjectAnswer(base, `Workbase refreshes repository knowledge from a commit-pinned view of each attached repository. It inventories safe files, routes capability-focused batches through semantic analysis, synthesizes only evidence-backed observations, and reconciles the resulting Project Facts or Highlights into durable memory. That makes later chat retrieval cheaper than rescanning the repo for every question. [citation:1]

It avoids stale facts by comparing snapshot and analyzer state, preserving exact provenance, and marking or superseding knowledge whose supporting files changed. Unchanged files and reusable synthesis can be skipped, while coverage gaps remain explicit; this keeps old statements out of normal retrieval without erasing the historical audit trail. [citation:2]`);
    case "product_value_and_difficulty":
      return citedProjectAnswer(base, `1. **Turned evidence into trustworthy career output.** Workbase routes reviewed Highlights into resume and artifact generation, which enables users to receive useful career content while retaining provenance and review boundaries around the deepest backend work. [citation:1]

2. **Built reusable repository intelligence.** A semantic repository refresh analyzes current code and reconciles it into Project Facts, enabling future questions to reuse grounded knowledge without rescanning the entire codebase. [citation:2]

3. **Created grounded multi-turn project chat.** Retrieval, citation pruning, conversation history, and bounded research work together so the agent can answer deeply while refusing claims that current memory cannot support. [citation:3]

4. **Controlled long-running AI work.** Bedrock tool limits and durable workflow orchestration persist progress and review state, which enables recovery and transparent partial outcomes rather than silent guesses or unbounded execution. [citation:4]`);
    case "team_value_gist":
      return citedProjectAnswer(base, `1. **Trustworthy product output.** Workbase builds a career content product by turning repository evidence into reviewed resume bullets and project summaries, which lets an engineering team communicate delivered value without severing the source trail or treating unreviewed notes as publishable claims. [citation:1]

2. **Reusable repository intelligence.** Workbase refreshes and reconciles current code into durable Project Facts with semantic analysis and commit-pinned provenance, which lets future answers stay fast while stale-memory handling remains explicit instead of rescanning the repository for every question. [citation:2]

3. **Controlled grounded project agent.** Workbase combines multi-turn project chat, retrieval, claim-local citations, bounded research, and durable Bedrock workflows, which allows a team to explore technical questions without turning every request into an uncontrolled repository scan or an unsupported answer. [citation:3]`);
    case "senior_backend_exact_four":
      return citedProjectAnswer(base, `1. **Architected the evidence-to-artifact backend.** Typed services route reviewed Highlights into career artifacts, separating raw inputs from publishable output so the system preserves data integrity across the full generation path. [citation:1]

2. **Built repository knowledge and provenance controls.** Commit-pinned semantic analysis reconciles supported observations into Project Facts, enabling current reusable memory while preserving evidence links and stale-knowledge handling. [citation:2]

3. **Implemented a bounded Bedrock agent runtime.** Tool-loop iteration and token budgets constrain AI execution, while citation verification keeps unsupported claims out of grounded answers and makes runtime behavior observable. [citation:3]

4. **Designed durable recovery boundaries.** Persisted agent runs, progress events, and review/resume states preserve long-running workflow progress, allowing safe recovery or explicit partial results when limits are reached. [citation:4]`);
    case "mixed_workflow_missing_p95":
      return citedProjectAnswer(base, `## Durable workflow behavior

Workbase persists project-chat runs, progress events, and review or resume boundaries around the model turn. This durable workflow preserves supported progress across a long-running operation and allows an interrupted run to continue from recorded state instead of silently inventing a result. [citation:1]

The workflow boundary matters because a chat or research operation can retain its observable state while the answer remains constrained by what its durable sources actually establish. This supports a useful explanation of the implemented recovery path without converting an operational unknown into a claim.

> **Evidence boundary:** The cited memory does not establish a measured production p95 latency. Production telemetry would be required to answer that part of the request.`);
    case "conversation_follow_up":
      return citedProjectAnswer(
        base,
        "The chat layer fails closed when current supporting evidence is missing instead of guessing. [citation:1]",
      );
    case "prior_turn_provenance":
      return { ...base, citationCount: 0, citationKinds: [], citationOrdinals: [], tools: ["inspect_prior_turn_provenance"], answer: "No. The prior turn did not inspect the repository." };
    case "historical_source_baseline":
      return citedProjectAnswer(base, "Workbase combines repository knowledge, grounded project chat, and durable artifact workflows. [citation:1]");
    case "prior_turn_source_scope":
      return {
        ...base,
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
        tools: ["inspect_prior_turn_provenance"],
        answer: "No new repository research was performed. Sources actually used by the prior turn were the cited durable Project Facts already present in project memory.",
      };
    case "long_thread_rollover":
      return {
        ...citedProjectAnswer(base, `| Context | Decision and effect |
| --- | --- |
| Earlier decision | Repository discoveries become reviewed Project Facts in durable memory before ordinary chat reuses them, preserving provenance rather than exposing raw exploration. [citation:1] |
| Current runtime | The bounded Bedrock tool loop enforces tool and token limits inside the durable workflow boundary, controlling one current project-chat turn while preserving run progress. [citation:2] |`),
        historyMessageCount: 16,
        historyCharacterCount: 65_600,
        historyCitationManifestCount: 8,
        rollingSummaryCharacterCount: 6_000,
        rollingSummaryPreservedOpeningDecision: true,
        rollingSummaryPreservedCitationManifest: true,
        historyPreservedCurrentRuntimeContext: true,
      };
    case "missing_metric":
      return { ...base, outcome: "insufficient_context", citationCount: 0, citationKinds: [], citationOrdinals: [], coverageGaps: ["No production telemetry is present."], answer: "No measured production request volume is available." };
    case "unsupported_deployment_topology":
      return { ...base, outcome: "insufficient_context", citationCount: 0, citationKinds: [], citationOrdinals: [], answer: "The active approved project memory does not establish a CDN or production deployment topology." };
    case "insufficient_context_follow_up":
      return {
        ...base,
        answer: "The previous answer stopped at an evidence boundary: the project memory did not establish a CDN or production deployment topology. Answering anyway would have required guessing, so Workbase returned the specific missing evidence instead.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
      };
    case "greeting":
      return {
        ...base,
        answer: "Hi! I can help you understand this project, inspect its current architecture, or turn its strongest supported work into career content.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
      };
    case "artifact_routing":
      return { ...base, outcome: "artifact_requested", citationCount: 0, citationKinds: [], citationOrdinals: [], answer: "Artifact workflow selected." };
    case "artifact_from_approved_context":
      return {
        ...base,
        outcome: "artifact_completed",
        answer: "- Built a typed backend orchestration layer.",
        citationCount: 1,
        citationKinds: ["highlight"],
        citationOrdinals: [],
        artifact: {
          exists: true,
          lifecycleStatus: "active",
          publicSafetyStatus: "verified",
          usedHighlightCount: 1,
          usedEvidenceCount: 1,
        },
      };
    case "artifact_missing_impact":
      return {
        ...base,
        outcome: "insufficient_context",
        answer: "No measured impact metric is available for a quantified artifact.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
        coverageGaps: ["No measured impact evidence is available."],
      };
    case "artifact_review_gate":
      return {
        ...base,
        outcome: "awaiting_review",
        answer: "Artifact generation is waiting for candidate review.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
        candidate: {
          exists: true,
          status: "pending",
          kind: "new_highlight",
          highlightLifecycleStatus: "quarantined",
          highlightReviewState: "pending_review",
          evidenceTypes: [],
        },
      };
    case "unattached_repository_security":
      return { ...base, outcome: "insufficient_context", citationCount: 0, citationKinds: [], citationOrdinals: [], answer: "No attached repository is authorized." };
    case "self_reported_context":
      return {
        ...base,
        candidate: {
          exists: true,
          status: "approved",
          kind: "new_highlight",
          highlightLifecycleStatus: "active",
          highlightReviewState: "pending_review",
          evidenceTypes: ["chat_user_statement"],
        },
      };
    case "targeted_repository_research":
      return {
        ...citedProjectAnswer(
          base,
          "No retry policy was found. The loop exits by throwing when `iterations >= maxIterations`, and `stopReason` controls response exits. [citation:1]",
        ),
        tools: ["list_repository_paths", "search_repository", "read_repository_file"],
        metrics: {
          ...zeroMetrics,
          latencyMs: 1_000,
          repositoryTreeLookups: 1,
          repositorySearches: 1,
          repositoryFileReads: 3,
          repositoryVisibleBytes: 12_000,
        },
      };
    default:
      return base;
  }
}

describe("project-chat application scenario runner", () => {
  it("covers real conversation, provenance, missing context, user context, artifact, research, and security paths", () => {
    expect(projectChatApplicationScenarios.map((scenario) => scenario.id)).toEqual([
      "memory_answer",
      "strongest_accomplishments",
      "recruiter_top_three",
      "concise_project_overview",
      "repository_knowledge_data_flow",
      "architecture_assessment",
      "design_tradeoffs",
      "compare_refresh_and_research",
      "focused_citation_behavior",
      "durable_runtime_deep_dive",
      "security_posture",
      "repository_auth_permissions",
      "resilience_recovery",
      "artifact_fallback_behavior",
      "frontend_review_experience",
      "data_model_lifecycle",
      "testing_strategy",
      "github_ingestion_flow",
      "known_limitations",
      "typo_repository_refresh",
      "product_value_and_difficulty",
      "team_value_gist",
      "senior_backend_exact_four",
      "mixed_workflow_missing_p95",
      "conversation_follow_up",
      "prior_turn_provenance",
      "historical_source_baseline",
      "prior_turn_source_scope",
      "long_thread_rollover",
      "missing_metric",
      "unsupported_deployment_topology",
      "insufficient_context_follow_up",
      "greeting",
      "artifact_routing",
      "artifact_from_approved_context",
      "artifact_missing_impact",
      "artifact_review_gate",
      "unattached_repository_security",
      "self_reported_context",
      "targeted_repository_research",
    ]);
  });

  it("runs scenarios in order, shares conversation state, evaluates each result, and cleans up", async () => {
    const messageCountByThread = new Map<string, number>();
    const cleanup = vi.fn(async () => undefined);
    const driver: ProjectChatApplicationDriver = {
      async run(scenario) {
        const historyMessageCount = messageCountByThread.get(scenario.threadKey) ?? 0;
        messageCountByThread.set(scenario.threadKey, historyMessageCount + 2);
        return successfulObservation(scenario, historyMessageCount);
      },
      cleanup,
    };

    const suite = await runProjectChatApplicationScenarios({ driver });

    expect(suite.results.flatMap((result) =>
      result.checks.filter((check) => !check.passed).map((check) =>
        `${result.scenario.id}: ${check.name} (${String(check.actual)}/${String(check.expected)})`
      ),
    )).toEqual([]);
    expect(suite.passed).toBe(true);
    expect(suite.results).toHaveLength(40);
    expect(suite.results.find((result) => result.scenario.id === "conversation_follow_up")?.observation.historyMessageCount).toBe(2);
    expect(suite.results.find((result) => result.scenario.id === "prior_turn_provenance")?.observation.historyMessageCount).toBe(4);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("aggregates secret-safe model attribution and fallback contamination", async () => {
    let index = 0;
    const suite = await runProjectChatApplicationScenarios({
      scenarioIds: ["design_tradeoffs", "testing_strategy"],
      driver: {
        async run(scenario) {
          const observation = successfulObservation(scenario, 0);
          const fallback = index++ === 1;
          return {
            ...observation,
            metrics: {
              ...observation.metrics,
              modelCalls: 1,
              totalTokens: 100,
              estimatedCostUsd: 0.001,
              modelAttribution: {
                providers: ["openrouter"],
                configuredModelIds: ["openai/gpt-5.6-terra"],
                actualModelIds: [
                  fallback
                    ? "anthropic/claude-sonnet-5"
                    : "openai/gpt-5.6-terra",
                ],
                routedProviders: [fallback ? "anthropic" : "openai"],
                requestIds: [`request-${index}`],
                failedModelIds: fallback ? ["openai/gpt-5.6-terra"] : [],
                providerAttempts: 1,
                failedProviderAttempts: fallback ? 1 : 0,
                fallbackUsed: fallback,
              },
            },
          };
        },
        async cleanup() {},
      },
    });

    expect(suite.aggregate).toMatchObject({
      modelCalls: 2,
      totalTokens: 200,
      estimatedCostUsd: 0.002,
      usageComplete: true,
      modelAttribution: {
        providers: ["openrouter"],
        configuredModelIds: ["openai/gpt-5.6-terra"],
        actualModelIds: [
          "anthropic/claude-sonnet-5",
          "openai/gpt-5.6-terra",
        ],
        routedProviders: ["anthropic", "openai"],
        requestIds: ["request-1", "request-2"],
        failedModelIds: ["openai/gpt-5.6-terra"],
        providerAttempts: 2,
        failedProviderAttempts: 1,
        fallbackUsed: true,
      },
    });
  });

  it("fails inconsistent zero-call telemetry and repository work on a memory path", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "memory_answer")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      tools: ["read_repository_file"],
      metrics: { ...observation.metrics, totalTokens: 25 },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(expect.arrayContaining([
      "memory answer avoided repository work",
      "zero-call telemetry is internally consistent",
    ]));
  });

  it("fails the performance gate when provider usage metadata is incomplete", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "memory_answer")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      metrics: { ...observation.metrics, usageComplete: false },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "provider usage telemetry is complete")?.passed).toBe(false);
  });

  it("never accepts user-visible verifier or durable-run failure copy", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "strongest_accomplishments")!;
    const observation = successfulObservation(scenario, 0);
    for (const answer of [
      "The answer could not be verified against its sources.",
      "The durable agent run failed unexpectedly.",
      "The verification stage failed.",
    ]) {
      const result = evaluateProjectChatApplicationObservation(scenario, {
        ...observation,
        answer,
        outcome: "answered",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
      });
      expect(result.passed).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: "answer does not expose an internal verification or agent failure",
        passed: false,
      }));
    }
  });

  it("enforces exact requested counts, claim-local citations, and reader-facing prioritization", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "recruiter_top_three")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      answer: `## Implementation inventory

1. RepositoryCapabilityLedger stores analyzerVersion.
2. RepositoryFileSnapshot stores policyVersion.
3. Prisma stores fields.
4. Utility files define helpers.`,
      citationCount: 0,
      citationKinds: [],
      citationOrdinals: [],
    });

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(expect.arrayContaining([
      "answer does not expose internal coverage bookkeeping or schema inventory",
      "answer contains the exact requested number of primary items",
      "answer grounds its major points with claim-local citations",
      "answer opens with a developed, high-value capability and explains why it matters",
    ]));
  });

  it("fails answered observations with dangling citation rows or retained internal exceptions", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "focused_citation_behavior")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      citationCount: 2,
      citationKinds: ["project_fact", "project_fact"],
      citationOrdinals: [1],
      error: "finalizer parse failed",
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "run did not retain an internal exception", passed: false }));
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "answer citation rows match canonical markers", passed: false }));
  });

  it("always cleans up when a driver throws", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(runProjectChatApplicationScenarios({
      scenarioIds: ["memory_answer"],
      driver: {
        run: vi.fn(async () => { throw new Error("boom"); }),
        cleanup,
      },
    })).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("automatically runs persisted-history prerequisites for a provenance-only request", async () => {
    const executed: string[] = [];
    const messageCountByThread = new Map<string, number>();
    const suite = await runProjectChatApplicationScenarios({
      scenarioIds: ["prior_turn_provenance"],
      driver: {
        async run(scenario) {
          executed.push(scenario.id);
          const history = messageCountByThread.get(scenario.threadKey) ?? 0;
          messageCountByThread.set(scenario.threadKey, history + 2);
          return successfulObservation(scenario, history);
        },
        async cleanup() {},
      },
    });
    expect(executed).toEqual(["memory_answer", "conversation_follow_up", "prior_turn_provenance"]);
    expect(suite.passed).toBe(true);
  });

  it("fails a provenance turn that silently attached a repository refresh", () => {
    const provenance = projectChatApplicationScenarios.find(
      (entry) => entry.id === "prior_turn_provenance",
    )!;
    const observation = successfulObservation(provenance, 4);
    const result = evaluateProjectChatApplicationObservation(provenance, {
      ...observation,
      knowledgeRefreshRunId: "refresh-should-not-exist",
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "provenance avoided new repository work",
      passed: false,
    }));
  });

  it("runs a real cited baseline before the exact historical source-scope follow-up", async () => {
    const executed: string[] = [];
    const messageCountByThread = new Map<string, number>();
    const suite = await runProjectChatApplicationScenarios({
      scenarioIds: ["prior_turn_source_scope"],
      driver: {
        async run(scenario) {
          executed.push(scenario.id);
          const history = messageCountByThread.get(scenario.threadKey) ?? 0;
          messageCountByThread.set(scenario.threadKey, history + 2);
          return successfulObservation(scenario, history);
        },
        async cleanup() {},
      },
    });
    expect(executed).toEqual(["historical_source_baseline", "prior_turn_source_scope"]);
    expect(suite.passed).toBe(true);
  });

  it("runs the insufficient-context turn before its history-only explanation", async () => {
    const executed: string[] = [];
    const messageCountByThread = new Map<string, number>();
    const suite = await runProjectChatApplicationScenarios({
      scenarioIds: ["insufficient_context_follow_up"],
      driver: {
        async run(scenario) {
          executed.push(scenario.id);
          const history = messageCountByThread.get(scenario.threadKey) ?? 0;
          messageCountByThread.set(scenario.threadKey, history + 2);
          return successfulObservation(scenario, history);
        },
        async cleanup() {},
      },
    });
    expect(executed).toEqual(["unsupported_deployment_topology", "insufficient_context_follow_up"]);
    expect(suite.results.at(-1)?.observation.historyMessageCount).toBe(2);
    expect(suite.passed).toBe(true);
  });
});
