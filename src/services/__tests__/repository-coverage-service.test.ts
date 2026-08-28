import { describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "mock",
}));

import {
  analyzeRepositoryFile,
  analyzeRepositoryFiles,
  BASE_COVERAGE_TARGETS,
  buildCoverageMatrix,
  inferProjectDomainCapability,
  inferSubsystemsFromPath,
  isPlannedDocumentationRange,
  isRepositoryAnalysisNoisePath,
  isRepositoryContextOnlyPath,
  recoverRepositorySemanticAnalysisFromStatic,
  repositorySemanticFindingGuidance,
  REPOSITORY_FILE_CHUNK_BYTES,
  selectRequiredSemanticCoverageAreas,
  selectSemanticWindows,
  type RepositoryFileAnalysis,
} from "@/src/services/repository-coverage-service";

describe("complete repository coverage", () => {
  const coverageArea = (key: string, observationCount = 12) => ({
    key,
    label: key,
    status: "static_mapped" as const,
    paths: [`src/${key}/index.ts`],
    observationCount,
    staticPathCount: 1,
    semanticPathCount: 0,
    modelSemanticPathCount: 0,
    deterministicFallbackPathCount: 0,
    unresolvedQuestions: [],
  });

  it("derives product domains from source structure without treating tests or flat helpers as domains", () => {
    expect(inferProjectDomainCapability("src/payments/charge-service.ts")).toBe("project_domain:payments");
    expect(inferProjectDomainCapability("app/api/search/route.ts")).toBe("project_domain:search");
    expect(inferProjectDomainCapability("app/api/investments/commit/route.ts")).toBe("project_domain:investments");
    expect(inferProjectDomainCapability("app/api/v2/orders/[orderId]/refunds/route.ts")).toBe("project_domain:orders");
    expect(inferProjectDomainCapability("server/routes/internal/organizations/[id]/billing/invoices.ts")).toBe("project_domain:organizations");
    expect(inferProjectDomainCapability("packages/billing/src/index.ts")).toBe("project_domain:billing");
    expect(inferProjectDomainCapability("src/services/miscellaneous-service.ts")).toBeNull();
    expect(inferProjectDomainCapability("src/payments/__tests__/charge.test.ts")).toBeNull();
    expect(inferProjectDomainCapability("src/email_intake/parse.py")).toBe("project_domain:email-intake");
    expect(inferProjectDomainCapability("src/main/java/com/acme/orders/OrderService.java")).toBe("project_domain:orders");
    expect(inferProjectDomainCapability("docs/payments/roadmap.md")).toBeNull();
    expect(inferProjectDomainCapability("samples/payments/demo.py")).toBeNull();
    expect(inferProjectDomainCapability("example/payments/demo.py")).toBeNull();
    expect(inferProjectDomainCapability("packages/sdk/examples/payments/demo.ts")).toBeNull();
    expect(inferProjectDomainCapability("uploads/payments/handler.ts")).toBe("project_domain:payments");
  });

  it("keeps low-level UI and helper wiring out of user-capability ranking", () => {
    expect(repositorySemanticFindingGuidance).toContain("end-user goal");
    expect(repositorySemanticFindingGuidance).toContain("query-parameter plumbing");
    expect(repositorySemanticFindingGuidance).toContain("helper behavior");
  });

  it("quarantines generated, cached, minified, and documentation-only paths", () => {
    expect(isRepositoryAnalysisNoisePath(".gradle/8.9/fileHashes.bin")).toBe(true);
    expect(isRepositoryAnalysisNoisePath(".venv/lib/python/site-packages/client.py")).toBe(true);
    expect(isRepositoryAnalysisNoisePath("frontend/app.bundle.js")).toBe(true);
    expect(isRepositoryAnalysisNoisePath("fixture/search/demo.py")).toBe(true);
    expect(isRepositoryAnalysisNoisePath("__fixture__/search/demo.py")).toBe(true);
    expect(isRepositoryAnalysisNoisePath("src/orders/service.py")).toBe(false);
    expect(isRepositoryContextOnlyPath("ROADMAP.md")).toBe(true);
    expect(isRepositoryContextOnlyPath("poc/search/demo.go")).toBe(false);
    expect(isRepositoryContextOnlyPath("examples/search/demo.ts")).toBe(false);
    expect(isRepositoryContextOnlyPath("examples/search/README.md")).toBe(true);
    expect(isRepositoryContextOnlyPath("sample-inputs/search/request.json")).toBe(true);
    expect(isRepositoryContextOnlyPath("src/search/index.go")).toBe(false);
  });

  it("keeps runnable proof-of-concept behavior without inventing a product domain", async () => {
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "example/exploratory-service",
      commitSha: "c".repeat(40),
      path: "poc/export/index.js",
      content: "export async function createDocument() { return fetch('/render'); }",
    }]);

    expect(inferProjectDomainCapability("poc/export/index.js")).toBeNull();
    expect(analysis?.facts).toContainEqual(expect.objectContaining({
      statement: expect.stringContaining("external service through a network client"),
    }));
  });

  it("classifies persisted chat-run coordination as workflow orchestration", () => {
    expect(inferSubsystemsFromPath("src/services/project-chat-store.ts")).toContain("workflow_orchestration");
    expect(inferSubsystemsFromPath("src/services/unrelated-store.ts")).not.toContain("workflow_orchestration");
  });

  it("distinguishes App Router API handlers from user-facing UI modules", () => {
    expect(inferSubsystemsFromPath("src/app/api/v1/circles/[circleId]/route.ts"))
      .not.toContain("review_ui");
    expect(inferSubsystemsFromPath("src/app/api/v1/circles/[circleId]/route.test.ts"))
      .not.toContain("review_ui");
    expect(inferSubsystemsFromPath("src/app/circles/[circleId]/page.tsx"))
      .toContain("review_ui");
    expect(inferSubsystemsFromPath("src/components/circle/circle-dashboard.tsx"))
      .toContain("review_ui");
    expect(inferSubsystemsFromPath("app/work-items/[id]/layout.tsx"))
      .toContain("review_ui");
  });

  it("does not grant UI location an importance bonus over implementation roles", async () => {
    const analyses = await analyzeRepositoryFiles([
      {
        repository: "example/product",
        commitSha: "b".repeat(40),
        path: "src/components/messages/ChatView.tsx",
        content: "export function ChatView() { return null; }",
      },
      {
        repository: "example/product",
        commitSha: "b".repeat(40),
        path: "src/retrieval/search-engine.ts",
        content: "export function searchEngine() { return []; }",
      },
      {
        repository: "example/product",
        commitSha: "b".repeat(40),
        path: "src/integrations/retrieval/search-client.ts",
        content: "export function searchClient() { return []; }",
      },
    ]);
    const symbolFact = (index: number) => analyses[index]?.facts.find((fact) =>
      fact.statement.includes("defines the symbol")
    );

    expect(symbolFact(0)).toMatchObject({ productImportance: 2, implementationBreadth: 2 });
    expect(symbolFact(1)).toMatchObject({ productImportance: 3, implementationBreadth: 3 });
    expect(symbolFact(2)).toMatchObject({ productImportance: 4, implementationBreadth: 4 });
  });

  it("does not mistake repository agent instructions for an AI model runtime", () => {
    expect(inferSubsystemsFromPath("AGENTS.md")).not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("docs/agent-workflow.md")).not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/agent.ts")).toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/runtime/agent-runtime.py"))
      .toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/agents/career-coach.ts"))
      .toContain("ai_runtime");
    expect(inferSubsystemsFromPath("packages/runtime/src/agents/planner.go"))
      .toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/lib/bedrock-converse-agent.ts"))
      .toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/agents/__tests__/planner.test.ts"))
      .not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/agents/fixtures/planner.ts"))
      .not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("tests/agents/planner.ts"))
      .not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("docs/agents/planner.ts"))
      .not.toContain("ai_runtime");
  });

  it("uses boundary-aware path roles instead of generic-token substrings", () => {
    const javaModel = inferSubsystemsFromPath("src/main/java/com/acme/loans/model/Loan.java");
    expect(javaModel).toContain("domain_data");
    expect(javaModel).not.toContain("ai_runtime");
    expect(inferSubsystemsFromPath("src/resources/ResourceLoader.java")).not.toContain("ingestion_integrations");
    expect(inferSubsystemsFromPath("src/services/knowledge-review-service.ts")).not.toContain("review_ui");
    expect(inferSubsystemsFromPath("src/lib/contest.ts")).not.toContain("tests_operations");
    expect(inferSubsystemsFromPath("src/lib/configuration.ts")).not.toContain("tests_operations");
    expect(inferProjectDomainCapability("lambda/payments/handler.ts")).toBe("project_domain:payments");
    expect(inferProjectDomainCapability("templates/email/welcome.ts")).toBe("project_domain:email");
    expect(inferProjectDomainCapability("src/uploads/payments/handler.ts")).toBe("project_domain:payments");
  });

  it("rejects semantic claims cited from roadmap ranges", () => {
    const numberedContent = [
      "1: # Product",
      "2: Current ingestion is available.",
      "3: ## Roadmap",
      "4: Semantic recommendations will add personalized discovery.",
    ].join("\n");

    expect(isPlannedDocumentationRange({
      path: "README.md",
      numberedContent,
      lineStart: 2,
      lineEnd: 2,
    })).toBe(false);
    expect(isPlannedDocumentationRange({
      path: "README.md",
      numberedContent,
      lineStart: 4,
      lineEnd: 4,
    })).toBe(true);
    expect(isPlannedDocumentationRange({
      path: "src/recommendations/service.ts",
      numberedContent,
      lineStart: 4,
      lineEnd: 4,
    })).toBe(false);
  });

  it("extracts imports and symbols across TypeScript, Python, Java, and Go", async () => {
    const [typescript, python, java, go] = await analyzeRepositoryFiles([
      {
        repository: "example/polyglot",
        commitSha: "f".repeat(40),
        path: "src/web/controller.ts",
        content: "import { run } from '../core/service';\nfunction localHelper() {}\nexport class ApiController {}",
      },
      {
        repository: "example/polyglot",
        commitSha: "f".repeat(40),
        path: "src/scoring/engine.py",
        content: "from ..core import ranking\nimport requests\nclass ScoringEngine:\n    def predict(self):\n        return requests.get('/rank')",
      },
      {
        repository: "example/polyglot",
        commitSha: "f".repeat(40),
        path: "src/main/java/com/acme/orders/OrderController.java",
        content: "import com.acme.orders.OrderService;\npublic class OrderController {\n  @GetMapping(\"/orders\")\n  public void list() {}\n}",
      },
      {
        repository: "example/polyglot",
        commitSha: "f".repeat(40),
        path: "internal/queue/worker.go",
        content: "import (\n  \"example.com/project/core\"\n  \"net/http\"\n)\ntype Worker struct {}\nfunc (w *Worker) Run() { http.Get(endpoint) }",
      },
    ]);

    expect(typescript).toMatchObject({
      dependencies: expect.arrayContaining(["../core/service"]),
      symbols: expect.arrayContaining(["ApiController"]),
    });
    expect(typescript?.symbols).not.toContain("localHelper");
    expect(python).toMatchObject({
      dependencies: expect.arrayContaining(["../core", "requests"]),
      symbols: expect.arrayContaining(["ScoringEngine", "predict"]),
      architectureSignals: expect.arrayContaining(["external integration"]),
    });
    expect(java).toMatchObject({
      dependencies: expect.arrayContaining(["com/acme/orders/OrderService"]),
      symbols: expect.arrayContaining(["OrderController"]),
      architectureSignals: expect.arrayContaining(["request endpoint"]),
    });
    expect(go).toMatchObject({
      dependencies: expect.arrayContaining(["example.com/project/core", "net/http"]),
      symbols: expect.arrayContaining(["Worker", "Run"]),
      architectureSignals: expect.arrayContaining(["external integration"]),
    });
  });

  it("keeps planned README scope as an unresolved question instead of an implementation fact", async () => {
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "example/roadmap",
      commitSha: "e".repeat(40),
      path: "README.md",
      content: [
        "# Product",
        "The current release imports signed records.",
        "## Roadmap",
        "Vector recommendations will add semantic discovery.",
      ].join("\n"),
    }]);

    expect(analysis?.facts.some((fact) => fact.statement.includes("current release imports"))).toBe(true);
    expect(analysis?.facts.some((fact) => fact.statement.includes("Vector recommendations"))).toBe(false);
    expect(analysis?.unresolvedQuestions).toContain("README.md:4 describes planned rather than implemented scope.");
  });

  it("recovers generic executable evidence when semantic extraction degrades", async () => {
    const [staticAnalysis] = await analyzeRepositoryFiles([{
      repository: "example/orders",
      commitSha: "d".repeat(40),
      path: "src/orders/sync.py",
      content: "import requests\ndef sync_orders():\n    return requests.get('/orders')",
    }]);
    const failedAnalysis: RepositoryFileAnalysis = {
      ...staticAnalysis!,
      facts: [],
      analysisMode: "semantic",
      semanticStatus: "failed",
      semanticDiagnostics: [{ status: "provider_error" }],
    };
    const recovered = recoverRepositorySemanticAnalysisFromStatic({
      staticAnalysis: staticAnalysis!,
      failedAnalysis,
      task: {
        objective: "Establish supported order synchronization behavior.",
        capabilityKeys: ["project_domain:orders"],
        questions: ["How are orders synchronized?"],
        expectedOutputs: ["Exact implementation evidence"],
      },
    });

    expect(recovered.semanticSource).toBe("deterministic_fallback");
    expect(recovered.facts).toContainEqual(expect.objectContaining({
      statement: expect.stringContaining("external service through a network client"),
      evidenceMode: "deterministic_fallback",
      subsystemKeys: ["project_domain:orders"],
    }));
  });

  it("extracts exact workflow retry, startup, and persisted-run guards without path-only inference", async () => {
    const [workflow, startup, store] = await analyzeRepositoryFiles([
      {
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "workflows/project-chat.ts",
        content: [
          "const claimed = await claimRequiredKnowledgeRefresh(runId, refreshRunId);",
          'const message = "resuming its checkpointed repository work";',
          "if (checkpoint.status === 'completed') return checkpoint;",
          "reconcileRequiredKnowledge.maxRetries = 2;",
        ].join("\n"),
      },
      {
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/services/agent-run-workflow-start-service.ts",
        content: [
          'if (current.workflowId && !current.workflowId.startsWith("starting:")) return current.workflowId;',
          "const reservation = `starting:${randomUUID()}`;",
          "const where = { workflowId: null, status: 'queued' };",
          "const reserve = { data: { workflowId: reservation } };",
          "await getRun(workflow.runId).cancel();",
          "const cleanup = { data: { workflowId: null } };",
        ].join("\n"),
      },
      {
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/services/project-chat-store.ts",
        content: [
          "export async function createProjectChatRun() {",
          '  const lock = `FROM "ChatThread" FOR UPDATE`;',
          "  const existing = { userId_idempotencyKey: {} };",
          "  if (existingRun) return existingRun;",
          '  throw new Error("Finish or cancel the active thread run");',
          "}",
          "export async function appendAgentRunEvent() {",
          '  const lock = `FROM "AgentRun" WHERE "id" = runId FOR UPDATE`;',
          '  if ([\"completed\", \"insufficient_context\", \"failed\", \"cancelled\"].includes(runs[0].status)) return;',
          "  const next = { sequence: (max._max.sequence ?? 0) + 1 };",
          "}",
          "export async function completeAgentRun() {",
          '  const row = `FROM "AgentRun"`;',
          '  const lock = `FOR UPDATE`;',
          '  if ([\"completed\", \"insufficient_context\", \"failed\", \"cancelled\"].includes(runs[0].status)) return;',
          "}",
        ].join("\n"),
      },
    ]);

    expect(workflow?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        statement: expect.stringContaining("replays completed repository reconciliation"),
        lineStart: 3,
        lineEnd: 4,
      }),
      expect.objectContaining({
        statement: expect.stringContaining("claim a released shared refresh"),
        lineStart: 1,
        lineEnd: 2,
      }),
    ]));
    expect(startup?.facts).toContainEqual(expect.objectContaining({
      statement: expect.stringContaining("conditionally reserves an unstarted queued run"),
      lineStart: 1,
      lineEnd: 6,
    }));
    expect(store?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        statement: expect.stringContaining("serializes chat-run creation"),
        lineStart: 1,
        lineEnd: 5,
      }),
      expect.objectContaining({
        statement: expect.stringContaining("serializes agent-run event appends"),
        lineStart: 7,
        lineEnd: 10,
      }),
      expect.objectContaining({
        statement: expect.stringContaining("locks persisted run state during completion"),
        lineStart: 12,
        lineEnd: 15,
      }),
    ]));

    const [incompleteStartup] = await analyzeRepositoryFiles([{
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "src/services/agent-run-workflow-start-service.ts",
      content: [
        'if (current.workflowId && !current.workflowId.startsWith("starting:")) return current.workflowId;',
        "const reservation = `starting:${randomUUID()}`;",
        "const where = { workflowId: null, status: 'queued' };",
        "const reserve = { data: { workflowId: reservation } };",
        "const cleanup = { data: { workflowId: null } };",
      ].join("\n"),
    }]);
    expect(incompleteStartup?.facts.some((fact) =>
      fact.statement.includes("conditionally reserves an unstarted queued run")
    )).toBe(false);
  });

  it("adds zero project-domain targets when every Workbase base capability already applies", () => {
    const baseAreas = BASE_COVERAGE_TARGETS.map((target) => coverageArea(target.key));
    const selected = selectRequiredSemanticCoverageAreas([
      ...baseAreas,
      coverageArea("project_domain:payments", 100),
      coverageArea("project_domain:search", 90),
    ]);

    expect(selected.map((area) => area.key)).toEqual(BASE_COVERAGE_TARGETS.map((target) => target.key));
  });

  it("fills a sparse non-Workbase ontology with high-signal payments and search domains", () => {
    const selected = selectRequiredSemanticCoverageAreas([
      coverageArea("product_surface", 4),
      coverageArea("tests_operations", 3),
      coverageArea("project_domain:search", 35),
      coverageArea("project_domain:payments", 42),
      coverageArea("module:src/helpers", 200),
    ]);

    expect(selected.map((area) => area.key)).toEqual([
      "product_surface",
      "tests_operations",
      "project_domain:payments",
      "project_domain:search",
    ]);
  });

  it("analyzes every chunk of a long file and preserves exact late-file line ranges", async () => {
    const line = "export const implementationSignal = true; // repository behavior\n";
    const content = line.repeat(Math.ceil((REPOSITORY_FILE_CHUNK_BYTES * 3.2) / Buffer.byteLength(line)));

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "src/services/large-architecture-service.ts",
      content,
    });

    expect(analysis.chunksAnalyzed).toBeGreaterThanOrEqual(4);
    expect(analysis.facts).toHaveLength(analysis.chunksAnalyzed);
    expect(Math.max(...analysis.facts.map((fact) => fact.lineEnd))).toBe(content.split("\n").length);
    expect(analysis.facts.some((fact) => fact.lineStart > 160)).toBe(true);
  });

  it("marks coverage verified only from analyzed content observations", async () => {
    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "b".repeat(40),
      path: "src/services/project-knowledge-retrieval-service.ts",
      content: "export const retrieve = () => 'grounded';",
    });
    const matrix = buildCoverageMatrix([{ path: analysis.path, analysis }]);

    expect(matrix.find((target) => target.key === "retrieval_provenance")).toMatchObject({
      status: "semantic_verified",
      paths: ["src/services/project-knowledge-retrieval-service.ts"],
      modelSemanticPathCount: 1,
      deterministicFallbackPathCount: 0,
    });
    expect(matrix.find((target) => target.key === "review_ui")?.status).toBe("not_applicable");
  });

  it("does not misclassify ordinary RegExp.test calls as automated tests", async () => {
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/services/intent-router.ts",
      content: "export function route(question: string) { return freshnessPattern.test(question); }",
    }]);

    expect(analysis.architectureSignals).not.toContain("automated test coverage");
    expect(analysis.facts.some((fact) => fact.statement.includes("automated tests"))).toBe(false);
  });

  it("preserves project-specific architecture areas instead of collapsing every service into one module", async () => {
    const analyses = await analyzeRepositoryFiles([
      {
        repository: "workbase/demo",
        commitSha: "d".repeat(40),
        path: "src/services/knowledge-refresh-service.ts",
        content: "export async function startKnowledgeRefresh() { return true; }",
      },
      {
        repository: "workbase/demo",
        commitSha: "d".repeat(40),
        path: "src/services/project-chat-agent-service.ts",
        content: "export async function runProjectChatAgent() { return true; }",
      },
    ]);

    expect(analyses[0]?.subsystemKeys).toContain("repository_knowledge_lifecycle");
    expect(analyses[1]?.subsystemKeys).toContain("project_chat_grounding");
  });

  it("selects one bounded semantic notebook per large file", () => {
    const content = Array.from({ length: 2_000 }, (_, index) =>
      index % 75 === 0 ? `export async function capability${index}() { return ${index}; }` : `const local${index} = ${index};`,
    ).join("\n");
    const windows = selectSemanticWindows(content);

    expect(windows).toHaveLength(1);
    expect(Buffer.byteLength(windows[0]!.content, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(windows[0]!.content).toMatch(/^\d+:/m);

    const batchedWindow = selectSemanticWindows(content, 5 * 1024);
    expect(Buffer.byteLength(batchedWindow[0]!.content, "utf8")).toBeLessThanOrEqual(5 * 1024);
    expect(batchedWindow[0]!.content).toMatch(/^\d+:/m);
  });

  it("routes a bounded semantic notebook to late static anchors and task-specific entrypoints", () => {
    const lines = Array.from({ length: 1_600 }, (_, index) =>
      index < 300 && index % 10 === 0
        ? `export const unrelatedEntrypoint${index} = () => ${index};`
        : `const local${index} = ${index};`,
    );
    lines[1_419] = "export async function reconcileSupersededKnowledge() { return restoreValidationHeads(); }";
    const content = lines.join("\n");
    const windows = selectSemanticWindows(content, 1_500, {
      task: {
        objective: "Determine how superseded knowledge is reconciled and restored.",
        capabilityKeys: ["knowledge_review_lifecycle"],
        questions: ["Where is superseded knowledge restored?"],
        expectedOutputs: ["The reconcileSupersededKnowledge entrypoint"],
      },
      staticAnalysis: {
        subsystemKeys: ["knowledge_review_lifecycle"],
        facts: [{
          statement: "The exported reconciliation entrypoint restores validation heads.",
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 1_420,
          lineEnd: 1_420,
          productImportance: 5,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          subsystemKeys: ["knowledge_review_lifecycle"],
          evidenceMode: "static",
          path: "src/services/knowledge-review-service.ts",
        }],
      },
    });

    expect(windows).toHaveLength(1);
    expect(Buffer.byteLength(windows[0]!.content, "utf8")).toBeLessThanOrEqual(1_500);
    expect(windows[0]!.content).toContain("1420: export async function reconcileSupersededKnowledge");
  });

  it("uses capability hints to retain a late decisive export without static anchors", () => {
    const lines = Array.from({ length: 1_200 }, (_, index) =>
      index < 240 && index % 8 === 0
        ? `export function unrelatedHandler${index}() { return ${index}; }`
        : `const value${index} = ${index};`,
    );
    lines[1_099] = "export function persistCitationProvenance() { return immutableCitation; }";
    const [window] = selectSemanticWindows(lines.join("\n"), 1_200, {
      task: {
        objective: "Find citation provenance persistence.",
        capabilityKeys: ["retrieval_provenance"],
        questions: [],
        expectedOutputs: ["persistCitationProvenance"],
      },
    });

    expect(window?.content).toContain("1100: export function persistCitationProvenance");
  });

  it("gives semantic credit only to capability keys supported by semantic findings", () => {
    const matrix = buildCoverageMatrix([{
      path: "src/services/multi-purpose.ts",
      analysis: {
        path: "src/services/multi-purpose.ts",
        summary: "A multipurpose service.",
        subsystemKeys: ["ai_runtime", "domain_data"],
        responsibilities: [],
        symbols: [],
        dependencies: [],
        architectureSignals: [],
        userFacingCapabilities: [],
        facts: [
          {
            statement: "Invokes a schema-constrained model.",
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 10,
            lineEnd: 12,
            productImportance: 4,
            implementationBreadth: 3,
            technicalDifficulty: 4,
            subsystemKeys: ["ai_runtime"],
            evidenceMode: "semantic",
            path: "src/services/multi-purpose.ts",
          },
          {
            statement: "Imports a persisted record type.",
            category: "data_flow",
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 1,
            lineEnd: 1,
            productImportance: 2,
            implementationBreadth: 1,
            technicalDifficulty: 1,
            subsystemKeys: ["domain_data"],
            evidenceMode: "static",
            path: "src/services/multi-purpose.ts",
          },
        ],
        unresolvedQuestions: [],
        chunksAnalyzed: 1,
        tokenUsage: [],
        analysisMode: "semantic",
        semanticStatus: "succeeded",
        semanticDiagnostics: [],
      },
    }]);

    expect(matrix.find((target) => target.key === "ai_runtime")).toMatchObject({
      status: "semantic_verified",
      semanticPathCount: 1,
    });
    expect(matrix.find((target) => target.key === "domain_data")).toMatchObject({
      status: "static_mapped",
      semanticPathCount: 0,
    });
  });

  it("reports deterministic fallback coverage separately from model semantic coverage", () => {
    const matrix = buildCoverageMatrix([{
      path: "workflows/project-chat.ts",
      analysis: {
        path: "workflows/project-chat.ts",
        summary: "Deterministic exact-line workflow observations.",
        subsystemKeys: ["workflow_orchestration"],
        responsibilities: ["Defines retry-safe workflow steps."],
        symbols: [],
        dependencies: [],
        architectureSignals: ["deterministic exact-line semantic fallback"],
        userFacingCapabilities: [],
        facts: [{
          statement: "workflows/project-chat.ts defines retry-safe workflow steps.",
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 1,
          lineEnd: 1,
          productImportance: 4,
          implementationBreadth: 5,
          technicalDifficulty: 4,
          subsystemKeys: ["workflow_orchestration"],
          evidenceMode: "deterministic_fallback",
          path: "workflows/project-chat.ts",
        }],
        unresolvedQuestions: [],
        chunksAnalyzed: 1,
        tokenUsage: [],
        analysisMode: "semantic",
        semanticStatus: "degraded",
        semanticSource: "deterministic_fallback",
        semanticDiagnostics: [{ status: "deterministic_exact_line_fallback" }],
      },
    }]);

    expect(matrix.find((target) => target.key === "workflow_orchestration")).toMatchObject({
      status: "static_mapped",
      semanticPathCount: 0,
      modelSemanticPathCount: 0,
      deterministicFallbackPathCount: 1,
    });
  });
});
