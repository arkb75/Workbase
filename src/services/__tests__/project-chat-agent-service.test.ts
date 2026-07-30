import { describe, expect, it } from "vitest";
import {
  applyProjectAnswerEditorialPresentation,
  buildBedrockProjectChatHistory,
  buildContextualRetrievalQuery,
  buildMemoryCatalog,
  buildStandaloneResearchQuestion,
  explicitPriorEvidenceGapExplanation,
  explicitPriorRetryExplanation,
  isContextOnlyProjectStatement,
  isRetryFollowUp,
  projectAnswerGroundingModeForQuestion,
  requiresLiveRepositoryResearch,
  selectProjectChatHistory,
  usesDeterministicEditorialSynthesis,
} from "@/src/services/project-chat-agent-service";
import { classifyProjectAnswerEditorialProfile } from "@/src/services/project-answer-editorial-service";

describe("project chat repository intent", () => {
  it.each([
    {
      question: "Give me exactly two concise bullets.",
      expected: "- **Product:** Delivers value [citation:1]\n- **Runtime:** Controls execution [citation:2]",
    },
    {
      question: "Explain this in two paragraphs.",
      expected: "**Product.** Delivers value [citation:1]\n\n**Runtime.** Controls execution [citation:2]",
    },
    {
      question: "Compare these systems in a table.",
      expected: [
        "| Theme | Assessment |",
        "| --- | --- |",
        "| Product | Delivers value [citation:1] |",
        "| Runtime | Controls execution [citation:2] |",
      ].join("\n"),
    },
  ])("presents a canonical grounded answer in the requested format: $question", ({ question, expected }) => {
    const markdown = [
      "### Product",
      "Delivers value [citation:1]",
      "",
      "### Runtime",
      "Controls execution [citation:2]",
    ].join("\n");
    expect(applyProjectAnswerEditorialPresentation(
      markdown,
      classifyProjectAnswerEditorialProfile(question),
    )).toBe(expected);
  });

  it.each([
    {
      question: "Give me exactly four concise bullets.",
      expected: "- **Product:** Delivers value [citation:1]\n- **Runtime:** Controls execution [citation:2]",
    },
    {
      question: "Explain this in exactly four paragraphs.",
      expected: "**Product.** Delivers value [citation:1]\n\n**Runtime.** Controls execution [citation:2]",
    },
    {
      question: "Give me a table with exactly four accomplishments.",
      expected: [
        "| Theme | Assessment |",
        "| --- | --- |",
        "| Product | Delivers value [citation:1] |",
        "| Runtime | Controls execution [citation:2] |",
      ].join("\n"),
    },
  ])("keeps the exact-count coverage limit outside $question presentation", ({
    question,
    expected,
  }) => {
    const coverageLimit =
      "> **Coverage limit:** Current approved project memory supports 2 of the requested 4 independently cited items. I kept the supported subset instead of inventing the remainder.";
    const markdown = [
      "### Product",
      "Delivers value [citation:1]",
      "",
      "### Runtime",
      "Controls execution [citation:2]",
      "",
      coverageLimit,
    ].join("\n");

    expect(applyProjectAnswerEditorialPresentation(
      markdown,
      classifyProjectAnswerEditorialProfile(question),
    )).toBe(`${expected}\n\n${coverageLimit}`);
  });

  it.each([
    "Pull more recent information from the repo.",
    "Inspect the GitHub repository before answering.",
    "Inspect arkb75/PrivateOtherRepo and compare its architecture.",
    "Can you check the repo for the latest implementation?",
    "Summarize my strongest accomplishments and make sure your information is up to date.",
  ])("forces live research for %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(true);
  });

  it("does not force repository access for an ordinary memory-backed question", () => {
    expect(requiresLiveRepositoryResearch("Summarize my strongest accomplishments.")).toBe(false);
  });

  it.each([
    "Compare repository knowledge refresh with targeted repository research.",
    "How does the repository refresh scheduler differ from incremental ingestion?",
    "Explain the trade-off between a codebase refresh and a targeted search.",
  ])("treats a conceptual refresh mention as memory-backed analysis: %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(false);
  });

  it.each([
    "Refresh the repository before answering.",
    "Please run a repository knowledge refresh, then compare the approaches.",
    "Can you check the codebase for the newest implementation?",
  ])("requires live repository work for an explicit action: %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(true);
  });

  it.each([
    "Summarize my strongest accomplishments and make sure your information is up to date.",
    "How does the repository refresh work?",
    "Give me exactly four implementation highlights.",
  ])("uses deterministic citation verification for factual synthesis: %s", (question) => {
    expect(projectAnswerGroundingModeForQuestion(question)).toBe("deterministic");
  });

  it.each([
    "Assess the architecture and its trade-offs.",
    "Compare repository refresh with targeted research.",
    "What should we change, and what risks matter most?",
  ])("retains semantic verification for analytical judgment: %s", (question) => {
    expect(projectAnswerGroundingModeForQuestion(question)).toBe("hybrid");
  });

  it("uses zero-model synthesis for factual and bounded source-backed assessment, but not open-ended recommendations", () => {
    expect(usesDeterministicEditorialSynthesis(
      "Summarize my strongest accomplishments and make sure your information is up to date.",
    )).toBe(true);
    expect(usesDeterministicEditorialSynthesis(
      "Assess the architecture and explain its trade-offs.",
    )).toBe(true);
    expect(usesDeterministicEditorialSynthesis(
      "What should we change to improve the architecture?",
    )).toBe(false);
  });

  it("does not mistake a prior-turn repository provenance question for new research intent", () => {
    expect(requiresLiveRepositoryResearch(
      "Did you inspect the repository for your previous answer?",
    )).toBe(false);
  });

  it.each([
    "Compare this with my recent answer.",
    "What are the current review statuses?",
    "Show the latest message in this thread.",
  ])("does not refresh repositories for conversational freshness in %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(false);
  });

  it.each([
    "Explain the current Workbase architecture.",
    "What changed in the latest project implementation?",
  ])("refreshes repository-backed project state in %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(true);
  });

  it.each([
    "I measured a 37% reduction in import latency after adding batching.",
    "I owned the GitHub ingestion implementation and rollout.",
    "The pilot supported 120 repository imports.",
  ])("recognizes reusable self-reported context without treating it as a question: %s", (statement) => {
    expect(isContextOnlyProjectStatement(statement)).toBe(true);
  });

  it.each([
    "Did I measure a 37% reduction in import latency?",
    "How does the import batching work?",
    "Summarize my strongest accomplishments.",
    "Write a resume bullet about the 37% improvement.",
    "Turn my 37% latency reduction into a resume bullet.",
    "Use the 37% result in a LinkedIn summary.",
    "Please review the import pipeline.",
    "I reduced latency by 37%. Check the repository to verify that.",
    "Approve the claim that I reduced latency by 37%.",
    "Delete the claim that I reduced latency by 37%.",
    "Does this mean I reduced latency by 37%.",
    "Sources for the claim that I reduced latency by 37%.",
    "I reduced latency by 37% — cite the sources.",
    "We plan to support 100 users.",
    "Our target is 99.9% uptime.",
    "I think the batching change reduced latency by 37%.",
    'The prior assistant said "I reduced import latency by 37%."',
  ])("does not intercept questions, summaries, or artifact commands as context: %s", (request) => {
    expect(isContextOnlyProjectStatement(request)).toBe(false);
  });

  it("resolves a follow-up into a standalone research objective", () => {
    expect(
      buildStandaloneResearchQuestion({
        currentQuestion: "Pull more recent information from the repo too.",
        delegatedQuestion: "Find what changed recently.",
        history: [
          {
            id: "user-1",
            role: "user",
            content: "Summarize my strongest accomplishments.",
            citations: [],
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Earlier summary.",
            citations: [],
          },
        ],
      }),
    ).toBe(
      [
        "Prior user objective: Summarize my strongest accomplishments.",
        "Prior assistant answer: Earlier summary.",
        "Current follow-up: Pull more recent information from the repo too.",
        "Specific research request: Find what changed recently.",
      ].join("\n"),
    );
  });

  it("passes an already standalone research question through without controller labels", () => {
    expect(
      buildStandaloneResearchQuestion({
        currentQuestion: "Inspect the repository and explain the exact iteration guard.",
        history: [],
      }),
    ).toBe("Inspect the repository and explain the exact iteration guard.");
  });

  it("explains a prior insufficient-context turn directly from conversation history", () => {
    expect(explicitPriorEvidenceGapExplanation({
      question: "Why couldn't you answer that?",
      history: [{
        id: "assistant-gap",
        role: "assistant",
        content: "The active approved project memory does not establish the production deployment topology.",
        citations: [],
      }],
    })).toContain("does not establish the production deployment topology");
  });

  it("rewrites an elliptical follow-up with bounded prior context and citation manifests", () => {
    const query = buildContextualRetrievalQuery({
      currentQuestion: "Which part of that flow is retried, and why?",
      history: [
        {
          id: "user-1",
          role: "user",
          content: "How does the main architecture work?",
          citations: [],
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "A durable workflow coordinates project chat and artifact generation.",
          citations: [{ ordinal: 1, kind: "project_fact", label: "Durable workflow orchestration" }],
        },
      ],
    });

    expect(query).toContain("Current question: Which part of that flow is retried, and why?");
    expect(query).toContain("Prior user objective: How does the main architecture work?");
    expect(query).toContain("Prior assistant answer: A durable workflow coordinates project chat and artifact generation.");
    expect(query).toContain('"type":"project_fact","title":"Durable workflow orchestration"');
    expect(query.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps an independent turn free of unrelated history", () => {
    expect(buildContextualRetrievalQuery({
      currentQuestion: "Explain the database schema.",
      history: [{ id: "assistant-1", role: "assistant", content: "Unrelated prior answer.", citations: [] }],
    })).toBe("Explain the database schema.");
  });

  it("uses a bounded rolling summary only for a referential retrieval question", () => {
    const summary =
      "Earlier decision: batch imports remain the default because they simplify replay and failure recovery.";
    const referential = buildContextualRetrievalQuery({
      currentQuestion: "Compare that earlier decision with the current streaming approach.",
      rollingSummary: summary,
    });
    const independent = buildContextualRetrievalQuery({
      currentQuestion: "Explain the database schema.",
      rollingSummary: summary,
    });

    expect(referential).toContain(`Older conversation summary: ${summary}`);
    expect(referential.length).toBeLessThanOrEqual(4_000);
    expect(independent).toBe("Explain the database schema.");
  });

  it("preserves only the latest bounded real messages and their compact citation manifests", () => {
    const history = Array.from({ length: 18 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `${index % 2 === 0 ? "Question" : "Answer"} ${index + 1}: ${"x".repeat(5_200)}`,
      citations: index % 2 === 0
        ? []
        : [{ ordinal: 1, kind: "project_fact", label: `Used fact ${index + 1}` }],
    }));

    const selected = selectProjectChatHistory(history);
    const selectedCharacters = selected.reduce((total, message) =>
      total + message.content.length + message.citations.reduce(
        (citationTotal, citation) => citationTotal + citation.label.length + citation.kind.length + 12,
        0,
      ), 0);
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selectedCharacters).toBeLessThanOrEqual(60_000);
    expect(selected.at(-1)?.id).toBe("message-18");

    const bedrockHistory = buildBedrockProjectChatHistory(history);
    expect(bedrockHistory[0]?.role).toBe("user");
    expect(bedrockHistory.at(-1)?.role).toBe("assistant");
    const assistantText = bedrockHistory
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .flatMap((block) => block && "text" in block && typeof block.text === "string" ? [block.text] : [])
      .join("\n");
    expect(assistantText).toContain("<used_citations>");
    expect(assistantText).toContain('"kind":"project_fact"');
    expect(assistantText).toContain('"title":"Used fact 18"');
    expect(assistantText).not.toContain("citation excerpt");
  });

  it("recognizes retry questions only as real conversational follow-ups", () => {
    const history = [{
      id: "assistant-1",
      role: "assistant" as const,
      content: "A durable workflow coordinates the flow.",
      citations: [],
    }];
    expect(isRetryFollowUp("Which part of that flow is retried, and why?", history)).toBe(true);
    expect(isRetryFollowUp("Which part of that flow is retried, and why?", [])).toBe(false);
    expect(isRetryFollowUp("Explain the workflow.", history)).toBe(false);
  });

  it("clarifies an explicit causal retry explanation from history without inventing missing behavior", () => {
    const question = "Which part of that flow is retried, and why?";
    expect(explicitPriorRetryExplanation({
      question,
      history: [{
        id: "assistant-1",
        role: "assistant",
        content: "The readiness step retries transient failures because a temporary dependency outage should not terminate the durable run. [citation:3]",
        citations: [{ ordinal: 3, kind: "project_fact", label: "Workflow readiness retries" }],
      }],
    })).toBe(
      "In my previous answer, the part I was referring to was: The readiness step retries transient failures because a temporary dependency outage should not terminate the durable run.",
    );
    expect(explicitPriorRetryExplanation({
      question,
      history: [{
        id: "assistant-2",
        role: "assistant",
        content: "A durable workflow coordinates project chat and artifact generation.",
        citations: [],
      }],
    })).toBeNull();
  });

  it("reserves an exact retry fact ahead of higher-scored generic memory", () => {
    const generic = Array.from({ length: 12 }, (_, index) => ({
      id: `generic-${index}`,
      kind: "project_fact" as const,
      authority: "verified_project_fact" as const,
      title: `Generic architecture fact ${index}`,
      content: `The project contains supported architecture behavior ${index}.`,
      score: 1_000 - index,
      citations: [{
        kind: "project_fact" as const,
        label: `Generic architecture fact ${index}`,
        excerpt: `The project contains supported architecture behavior ${index}.`,
        projectFactId: `generic-${index}`,
      }],
    }));
    const retryFact = {
      id: "retry-fact",
      kind: "project_fact" as const,
      authority: "verified_project_fact" as const,
      title: "Durable workflow retry behavior",
      content: "The workflow retries transient readiness failures so that a temporary dependency outage does not terminate the run.",
      score: 1,
      citations: [{
        kind: "project_fact" as const,
        label: "Durable workflow retry behavior",
        excerpt: "The workflow retries transient readiness failures.",
        projectFactId: "retry-fact",
      }],
    };

    const catalog = buildMemoryCatalog({
      hits: [...generic, retryFact],
      query: "Which part of that flow is retried, and why?",
    });

    expect(catalog.entries[0]).toMatchObject({ title: "Durable workflow retry behavior" });
    expect(catalog.citations[0]).toMatchObject({ projectFactId: "retry-fact" });
  });

  it("reserves current-run Project Facts and keeps GitHub excerpts as nested provenance", () => {
    const catalog = buildMemoryCatalog({
      currentRunProjectFactIds: ["fact-current"],
      hits: [
        ...Array.from({ length: 14 }, (_, index) => ({
          id: `highlight-${index}`,
          kind: "highlight" as const,
          authority: "verified_highlight" as const,
          title: `Historical highlight ${index}`,
          content: `Historical content ${index}`,
          score: 100 - index,
          citations: [{
            kind: "highlight" as const,
            label: `Historical highlight ${index}`,
            excerpt: `Historical content ${index}`,
            highlightId: `highlight-${index}`,
          }],
        })),
        {
          id: "fact-current",
          kind: "project_fact" as const,
          authority: "verified_project_fact" as const,
          title: "Current reviewed fact",
          content: "Current reviewed fact content",
          score: 1,
          citations: [
            { kind: "project_fact" as const, label: "Current reviewed fact", excerpt: "Current reviewed fact content", projectFactId: "fact-current" },
            { kind: "github_file" as const, label: "src/current.ts", excerpt: "raw code", path: "src/current.ts", commitSha: "a".repeat(40) },
          ],
        },
      ],
    });

    expect(catalog.entries[0]).toMatchObject({
      kind: "project_fact",
      currentRun: true,
      supportingSources: [{ type: "github_file", title: "src/current.ts" }],
    });
    expect(catalog.citations).toEqual([
      expect.objectContaining({ kind: "project_fact", projectFactId: "fact-current" }),
      ...catalog.citations.slice(1),
    ]);
    expect(catalog.citations.some((citation) => citation.kind === "github_file")).toBe(false);
  });

  it("builds a subsystem-balanced catalog for a main-architecture question", () => {
    const ranking = {
      evidenceStrength: 5,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 4,
      ownershipAuthority: 0,
      distinctiveness: 4,
      freshness: 5,
      impactBonus: 0,
      uncertainty: null,
    };
    const subsystems = [
      "product_surface",
      "repository_knowledge_lifecycle",
      "project_chat_grounding",
      "artifact_generation",
      "workflow_orchestration",
    ];
    const hits = [
      ...subsystems.map((subsystemKey, index) => ({
        id: `fact-${index}`,
        kind: "project_fact" as const,
        authority: "verified_project_fact" as const,
        title: `${subsystemKey} architecture`,
        content: `${subsystemKey} is a supported system capability.`,
        score: 20 - index,
        subsystemKey,
        validatedThroughSha: "a".repeat(40),
        accomplishmentRanking: ranking,
        citations: [{
          kind: "project_fact" as const,
          label: `${subsystemKey} architecture`,
          excerpt: `${subsystemKey} is a supported system capability.`,
          projectFactId: `fact-${index}`,
        }],
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `duplicate-${index}`,
        kind: "project_fact" as const,
        authority: "verified_project_fact" as const,
        title: `High-score chat detail ${index}`,
        content: `A project chat implementation detail ${index}.`,
        score: 1_000 - index,
        subsystemKey: "project_chat_grounding",
        validatedThroughSha: "a".repeat(40),
        accomplishmentRanking: ranking,
        citations: [{
          kind: "project_fact" as const,
          label: `High-score chat detail ${index}`,
          excerpt: `A project chat implementation detail ${index}.`,
          projectFactId: `duplicate-${index}`,
        }],
      })),
    ];

    const catalog = buildMemoryCatalog({
      hits,
      query: "How does the main architecture work?",
    });

    expect(new Set(catalog.entries.slice(0, 5).map((entry) => entry.subsystemKey))).toEqual(new Set(subsystems));
  });
});
