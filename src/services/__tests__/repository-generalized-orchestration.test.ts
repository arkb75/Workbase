import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRepositoryDerivedCapabilityManifest,
  buildRepositoryDerivedSemanticPlan,
  critiqueRepositoryCoverage,
  isImplementationEvidencePath,
  isRepositoryCartographyNoisePath,
  resolveRepositorySemanticPlannerMode,
  semanticEvidenceUniverseFromFiles,
  semanticEvidenceUniverseFromManifest,
  semanticAuditTarget,
  semanticSampleTarget,
  semanticWorkPackageModelCallCount,
  type CapabilityCandidate,
  type RepositoryCartographyFile,
} from "@/src/services/repository-semantic-orchestrator-service";
import { inferProjectDomainCapability } from "@/src/services/repository-coverage-service";

function mappedFile(id: string, path: string, importance = 3): RepositoryCartographyFile {
  const domain = inferProjectDomainCapability(path);
  return {
    id,
    path,
    changeType: "unchanged",
    analysis: {
      subsystemKeys: domain ? [domain] : [],
      facts: [{
        statement: `${path} implements a repository-supported behavior.`,
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 1,
        lineEnd: 8,
        productImportance: importance,
        implementationBreadth: importance,
        technicalDifficulty: importance,
        subsystemKeys: domain ? [domain] : [],
        evidenceMode: "static",
        path,
      }],
      symbols: ["supportedBehavior"],
      dependencies: [],
      architectureSignals: [],
      userFacingCapabilities: [],
    },
  };
}

function candidate(key: string, fileSnapshotId: string): CapabilityCandidate {
  return {
    key,
    statement: "The implementation supports a complete, evidence-backed product behavior.",
    kind: "behavior",
    evidence: [{ fileSnapshotId, lineStart: 1, lineEnd: 8 }],
    confidence: "high",
    supportedQualifiers: [],
    unresolved: [],
  };
}

describe("repository-derived cartographer and coverage critic", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed on an invalid semantic planner mode", () => {
    vi.stubEnv("WORKBASE_SEMANTIC_PLANNER_MODE", "modle");

    expect(() => resolveRepositorySemanticPlannerMode()).toThrow(
      'WORKBASE_SEMANTIC_PLANNER_MODE must be "model" or "deterministic"',
    );
  });

  it("discovers product domains without admitting generated/tooling corpus noise", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/diverse-project",
      files: [
        mappedFile("pay-1", "src/features/payments/checkout.ts"),
        mappedFile("pay-2", "src/features/payments/ledger.ts"),
        mappedFile("msg-1", "src/features/messaging/inbox.tsx"),
        mappedFile("msg-2", "src/features/messaging/thread.ts"),
        mappedFile("acct-1", "src/main/java/com/example/accounts/AccountModel.java"),
        mappedFile("acct-2", "src/main/java/com/example/accounts/AccountApi.java"),
        mappedFile("noise-1", ".playwright-cli/session.json", 5),
        mappedFile("noise-2", ".workflow-data/runs/run.ts", 5),
        mappedFile("noise-3", "test/resources/generated/AccountModel.java", 5),
        mappedFile("instructions-1", "AGENTS.md", 5),
        mappedFile("instructions-2", ".agents/skills/database/SKILL.md", 5),
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual(expect.arrayContaining([
      "project_domain:accounts",
      "project_domain:messaging",
      "project_domain:payments",
    ]));
    expect(manifest.map((area) => area.key)).not.toContain(
      "repository_area:application_core",
    );
    expect(manifest.flatMap((area) => area.files.map((file) => file.path))).not.toEqual(
      expect.arrayContaining([
        ".playwright-cli/session.json",
        ".workflow-data/runs/run.ts",
        "test/resources/generated/AccountModel.java",
        "AGENTS.md",
        ".agents/skills/database/SKILL.md",
      ]),
    );
    expect(manifest.some((area) => /ai_runtime|ingestion|project_domain:(?:api|model)/.test(area.key))).toBe(false);
    expect(isRepositoryCartographyNoisePath(".nyc_output/process.json")).toBe(true);
    expect(isRepositoryCartographyNoisePath(".gradle/8.9/fileHashes.bin")).toBe(true);
    expect(isRepositoryCartographyNoisePath(".venv/lib/python/site-packages/client.py")).toBe(true);
    expect(isRepositoryCartographyNoisePath("frontend/main.min.js")).toBe(true);
    expect(isRepositoryCartographyNoisePath("fixture/search/demo.py")).toBe(true);
    expect(isRepositoryCartographyNoisePath("__fixture__/search/demo.py")).toBe(true);
    expect(inferProjectDomainCapability("fixture/search/demo.py")).toBeNull();
  });

  it("uses application core only for files outside selected product domains", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/payment-service",
      files: [
        mappedFile("payment-checkout", "src/features/payments/checkout-service.ts"),
        mappedFile("payment-ledger", "src/features/payments/ledger-service.ts"),
        mappedFile("reconciliation", "src/reconciliation-service.ts"),
      ],
    });
    const payments = manifest.find((area) =>
      area.key === "project_domain:payments"
    );
    const applicationCore = manifest.find((area) =>
      area.key === "repository_area:application_core"
    );

    expect(payments?.files.map((file) => file.id)).toEqual([
      "payment-checkout",
      "payment-ledger",
    ]);
    expect(applicationCore?.files.map((file) => file.id)).toEqual([
      "reconciliation",
    ]);
  });

  it("reuses an empty application-core slot for another evidenced product domain", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/two-domains",
      maxDomains: 2,
      files: [
        mappedFile("payment-checkout", "src/features/payments/checkout-service.ts"),
        mappedFile("payment-ledger", "src/features/payments/ledger-service.ts"),
        mappedFile("message-inbox", "src/features/messaging/inbox-service.ts"),
        mappedFile("message-thread", "src/features/messaging/thread-service.ts"),
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual([
      "project_domain:messaging",
      "project_domain:payments",
    ]);
  });

  it("uses file-local agent and model signals without classifying a generic agents ancestor as intelligence", () => {
    const deployScript = mappedFile(
      "deploy-script",
      "src/agents/email_intake/scripts/deploy_api_lambda.sh",
    );
    const reviewerAgent = mappedFile(
      "reviewer-agent",
      "src/agents/review/reviewer_agent.py",
    );
    const planner = mappedFile("planner", "src/runtime/planner.py");
    planner.analysis.symbols = ["RepositoryPlanner", "LLMPlanningStep"];
    planner.analysis.dependencies = ["langchain"];

    const intelligence = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/agent-runtime",
      files: [deployScript, reviewerAgent, planner],
    }).find((area) => area.key === "repository_area:intelligence");

    expect(intelligence?.files.map((file) => file.id)).toEqual(["planner"]);
  });

  it("normalizes model and retrieval identifiers before matching intelligence signals", () => {
    const llmPlanner = mappedFile("llm-planner", "src/runtime/planner.ts");
    llmPlanner.analysis.symbols = ["LLMPlanningStep"];
    const ragRetriever = mappedFile("rag-retriever", "src/runtime/reader.ts");
    ragRetriever.analysis.symbols = ["RagRetriever"];
    const gptClient = mappedFile("gpt-client", "src/runtime/client.ts");
    gptClient.analysis.symbols = ["GPTClient"];
    const dependencyOnly = mappedFile("dependency", "src/runtime/adapter.ts");
    dependencyOnly.analysis.dependencies = ["@langchain/core"];
    const chatGptClient = mappedFile(
      "chatgpt-client",
      "src/runtime/chatgpt_client.py",
    );

    const intelligence = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/model-runtime",
      files: [llmPlanner, ragRetriever, gptClient, dependencyOnly, chatGptClient],
    }).find((area) => area.key === "repository_area:intelligence");

    expect(intelligence?.files.map((file) => file.id)).toEqual(expect.arrayContaining([
      "llm-planner",
      "rag-retriever",
      "gpt-client",
      "dependency",
      "chatgpt-client",
    ]));
  });

  it("recognizes common non-OpenAI model runtimes without treating generic training code as AI", () => {
    const ollama = mappedFile("ollama", "src/runtime/client.py");
    ollama.analysis.symbols = ["OllamaClient"];
    ollama.analysis.dependencies = ["ollama"];
    const gemini = mappedFile("gemini", "src/runtime/gemini_adapter.ts");
    gemini.analysis.symbols = ["GoogleGenerativeAI"];
    gemini.analysis.dependencies = ["@google/generative-ai"];
    const mistral = mappedFile("mistral", "src/runtime/provider.py");
    mistral.analysis.dependencies = ["mistralai"];
    const llamaIndex = mappedFile("llama-index", "src/runtime/indexer.py");
    llamaIndex.analysis.dependencies = ["llama_index"];
    const transformers = mappedFile("transformers", "src/runtime/model.py");
    transformers.analysis.dependencies = ["torch", "transformers"];
    const employeeTraining = mappedFile(
      "employee-training",
      "src/training/course_service.ts",
    );
    employeeTraining.analysis.symbols = ["TrainingCourseService"];

    const intelligence = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/provider-neutral-runtime",
      files: [
        ollama,
        gemini,
        mistral,
        llamaIndex,
        transformers,
        employeeTraining,
      ],
    }).find((area) => area.key === "repository_area:intelligence");

    expect(intelligence?.files.map((file) => file.id)).toEqual(expect.arrayContaining([
      "ollama",
      "gemini",
      "mistral",
      "llama-index",
      "transformers",
    ]));
    expect(intelligence?.files.map((file) => file.id)).not.toContain(
      "employee-training",
    );
  });

  it("does not confuse lexical collisions or HTTP user agents with model intelligence", () => {
    const research = mappedFile("research", "src/runtime/ResearchRepository.ts");
    research.analysis.symbols = ["ResearchRepository"];
    const clock = mappedFile("clock", "src/runtime/PredictableClock.ts");
    clock.analysis.symbols = ["PredictableClock"];
    const userAgent = mappedFile("user-agent", "src/http/user_agent_parser.ts");
    userAgent.analysis.symbols = ["UserAgentParser"];
    userAgent.analysis.architectureSignals = ["Parses the HTTP User-Agent header"];
    const poetry = mappedFile("poetry", "src/writing/SonnetGenerator.ts");
    poetry.analysis.symbols = ["HaikuFormatter"];
    const graphics = mappedFile("graphics", "src/graphics/vector_canvas.ts");
    graphics.analysis.dependencies = ["chroma-color"];
    const domainAgent = mappedFile("domain-agent", "src/support/customer_agent.ts");
    const domainModel = mappedFile("domain-model", "src/domain/customer.ts");
    domainModel.analysis.symbols = ["CustomerModel"];
    domainModel.analysis.dependencies = ["provider"];
    const training = mappedFile("training", "src/training/course_service.ts");
    training.analysis.symbols = ["EmployeeTrainingCourse"];

    const intelligence = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/application-runtime",
      files: [
        research,
        clock,
        userAgent,
        poetry,
        graphics,
        domainAgent,
        domainModel,
        training,
      ],
    }).find((area) => area.key === "repository_area:intelligence");

    expect(intelligence).toBeUndefined();
  });

  it("keeps conventional test bootstraps out of semantic cartography without relaxing implementation failures", () => {
    const files = [
      mappedFile("app", "frontend/example/src/App.js", 5),
      mappedFile("insights", "frontend/example/src/components/Insights.js", 5),
      mappedFile("datasets", "frontend/example/src/components/ListDataset.js", 5),
      mappedFile("runtime-setup", "frontend/example/src/setup.js", 5),
      mappedFile("cra-test-setup", "frontend/example/src/setupTests.js", 8),
      mappedFile("vitest-setup", "vitest.setup.ts", 8),
      mappedFile("tree-test-bootstrap", "tests/bootstrap.ts", 8),
    ];
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/example",
      files,
    });
    const mappedPaths = manifest.flatMap((area) =>
      area.files.map((file) => file.path)
    );

    expect(mappedPaths).toContain("frontend/example/src/setup.js");
    expect(mappedPaths).not.toEqual(expect.arrayContaining([
      "frontend/example/src/setupTests.js",
      "vitest.setup.ts",
      "tests/bootstrap.ts",
    ]));
    expect(semanticEvidenceUniverseFromFiles(files).fileSnapshotIds).toEqual(
      expect.arrayContaining(["app", "insights", "datasets", "runtime-setup"]),
    );
    expect(semanticEvidenceUniverseFromFiles(files).fileSnapshotIds).not.toEqual(
      expect.arrayContaining(["cra-test-setup", "vitest-setup", "tree-test-bootstrap"]),
    );
    expect(isRepositoryCartographyNoisePath("frontend/example/src/setupTests.js")).toBe(true);
    expect(isRepositoryCartographyNoisePath("frontend/example/src/setup-tests.ts")).toBe(true);
    expect(isRepositoryCartographyNoisePath("test/setup.ts")).toBe(true);
    expect(isRepositoryCartographyNoisePath("src/setup.ts")).toBe(false);
    expect(isRepositoryCartographyNoisePath("src/setup.test.ts")).toBe(false);
    expect(isRepositoryCartographyNoisePath("src/setup.spec.ts")).toBe(false);
    expect(isRepositoryCartographyNoisePath("scripts/bootstrap.ts")).toBe(false);

    const plan = buildRepositoryDerivedSemanticPlan({ manifest });
    const selected = plan.flatMap((entry) => entry.fileSnapshotIds);
    expect(selected).not.toEqual(expect.arrayContaining([
      "cra-test-setup",
      "vitest-setup",
      "tree-test-bootstrap",
    ]));

    const failedImplementationId = selected[0]!;
    const supportedImplementationId = selected[1]!;
    const critique = critiqueRepositoryCoverage({
      manifest,
      reports: [{
        inspectedFileSnapshotIds: selected,
        retryFileSnapshotIds: [failedImplementationId],
        candidates: [candidate("repository_area:product_surface", supportedImplementationId)],
      }],
      allowRepair: true,
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .toContain(failedImplementationId);
  });

  it("starts large domains with two diverse samples and leaves depth to bounded repair", () => {
    const area = {
      key: "project_domain:feed",
      label: "Feed",
      scopeKey: "example/social",
      salience: 200,
      files: Array.from({ length: 20 }, (_, index) => ({
        id: `feed-${index}`,
        path: `src/features/feed/file-${index}.ts`,
        score: 20 - index,
      })),
    };
    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });

    expect(semanticSampleTarget(area)).toBe(2);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.fileSnapshotIds).toHaveLength(2);
    expect(plan[0]?.fileSnapshotIds).toEqual(["feed-0", "feed-1"]);
    expect(plan[0]?.fileSnapshotIds.length).toBeLessThanOrEqual(8);

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: plan[0]!.fileSnapshotIds,
        candidates: [candidate(area.key, plan[0]!.fileSnapshotIds[0]!)],
      }],
      allowRepair: true,
    });
    expect(semanticAuditTarget(area)).toBe(4);
    expect(critique.domains[0]).toEqual(expect.objectContaining({
      targetSamples: 4,
      inspectedSamples: 2,
      status: "thin",
    }));
    expect(critique.repairPackages[0]?.fileSnapshotIds).toHaveLength(2);
  });

  it("persists a deduplicated pre-selection semantic evidence universe", () => {
    const sharedClient = { id: "client", path: "src/service/ForecastClient.java", score: 20 };
    const universe = semanticEvidenceUniverseFromManifest([
      {
        key: "repository_area:intelligence",
        label: "Intelligence",
        files: [
          sharedClient,
          { id: "python-model", path: "ml_service/forecast_service.py", score: 18 },
          { id: "readme", path: "README.md", score: 16 },
        ],
      },
      {
        key: "repository_area:integrations",
        label: "Integrations",
        files: [sharedClient],
      },
      {
        key: "repository_area:quality",
        label: "Quality",
        files: [{ id: "test", path: "src/test/ForecastClientTest.java", score: 14 }],
      },
    ]);

    expect(universe).toEqual({
      fileSnapshotIds: ["client", "python-model", "test"],
      fileCount: 3,
    });
  });

  it("keeps eligible but unmapped files in the independent semantic denominator", () => {
    expect(semanticEvidenceUniverseFromFiles([
      { id: "service", path: "src/circles/contribution-service.ts" },
      { id: "types", path: "src/lib/api-types.ts" },
      { id: "docs", path: "README.md" },
    ])).toEqual({
      fileSnapshotIds: ["service", "types"],
      fileCount: 2,
    });
  });

  it("keeps every supported executable language in the semantic universe", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/polyglot-core",
      files: [
        mappedFile("swift", "main.swift"),
        mappedFile("scala", "service.scala"),
        mappedFile("proto", "events.proto"),
        mappedFile("graphql", "schema.graphql"),
        mappedFile("shell", "scripts/bootstrap.sh"),
        mappedFile("eval", "src/evals/quality-harness.ts"),
      ],
    });

    expect(manifest.find((area) =>
      area.key === "repository_area:application_core"
    )?.files.map((file) => file.id)).toEqual(expect.arrayContaining([
      "swift",
      "scala",
      "proto",
    ]));
    expect(semanticEvidenceUniverseFromManifest(manifest).fileSnapshotIds)
      .toEqual(expect.arrayContaining(["swift", "scala", "proto", "graphql", "shell"]));
    expect(semanticEvidenceUniverseFromManifest(manifest).fileSnapshotIds).not.toContain("eval");
  });

  it("credits an inspected file to every legitimate overlapping area", () => {
    const shared = { id: "shared", path: "app/payments/checkout.ts", score: 20 };
    const manifest = [
      {
        key: "project_domain:payments",
        label: "Payments",
        scopeKey: "example/payments",
        salience: 200,
        files: [shared],
      },
      {
        key: "repository_area:product_surface",
        label: "Product surface",
        scopeKey: "example/payments",
        salience: 100,
        files: [
          { id: "surface-a", path: "app/dashboard/page.tsx", score: 100 },
          { id: "surface-b", path: "app/settings/page.tsx", score: 90 },
          shared,
        ],
      },
    ];
    const plan = buildRepositoryDerivedSemanticPlan({ manifest, maxWorkers: 2 });
    const sharedPackage = plan.find((workPackage) =>
      workPackage.fileSnapshotIds.includes("shared")
    );

    expect(sharedPackage?.capabilityKeys).toEqual(expect.arrayContaining([
      "project_domain:payments",
      "repository_area:product_surface",
    ]));
    const critique = critiqueRepositoryCoverage({
      manifest,
      reports: [{
        inspectedFileSnapshotIds: plan.flatMap((workPackage) => workPackage.fileSnapshotIds),
        candidates: [
          candidate("project_domain:payments", "shared"),
          candidate("repository_area:product_surface", "shared"),
        ],
      }],
      allowRepair: false,
    });
    expect(critique.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "repository_area:product_surface", status: "covered" }),
    ]));
  });

  it("spends repair capacity on uninspected product boundaries before near-neighbor files", () => {
    const area = {
      key: "repository_area:application_core",
      label: "Application core",
      scopeKey: "example/community-product",
      salience: 300,
      files: [
        { id: "contribution", path: "src/server/services/contribution-service.ts", score: 50 },
        { id: "internal-api", path: "src/lib/internal-api.ts", score: 49 },
        { id: "onboarding", path: "src/server/services/onboarding-service.ts", score: 48 },
        { id: "prisma", path: "src/lib/prisma.ts", score: 47 },
        { id: "session", path: "src/lib/session.ts", score: 46 },
        { id: "analytics", path: "src/server/services/contribution-analytics.ts", score: 45 },
        { id: "repository", path: "src/server/data/community-repository.ts", score: 44 },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `helper-${index}`,
          path: `src/lib/helper-${index}.ts`,
          score: 30 - index,
        })),
      ],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: ["contribution", "internal-api"],
        candidates: [
          candidate(area.key, "contribution"),
          candidate(area.key, "internal-api"),
        ],
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 4,
      inspectedSamples: 2,
      status: "thin",
    });
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual([
      "onboarding",
      "session",
      "analytics",
    ]);
  });

  it("keeps the established audit-depth curve while the first pass stays bounded", () => {
    const cases = [
      [0, 0], [1, 1], [2, 2], [3, 2], [6, 2],
      [7, 3], [15, 3], [16, 4], [30, 4], [31, 17],
    ] as const;

    for (const [fileCount, auditTarget] of cases) {
      const area = {
        key: "project_domain:catalog",
        files: Array.from({ length: fileCount }, (_, index) => ({
          id: `file-${index}`,
          path: `src/catalog/file-${index}.ts`,
          score: fileCount - index,
        })),
      };
      expect(semanticSampleTarget(area)).toBe(Math.min(fileCount, 2));
      expect(semanticAuditTarget(area)).toBe(auditTarget);
    }

    expect(semanticAuditTarget({
      key: "repository_area:application_core",
      files: Array.from({ length: 31 }, (_, index) => ({
        id: `structural-${index}`,
        path: `src/core/file-${index}.ts`,
        score: 31 - index,
      })),
    })).toBe(4);
  });

  it("audits broad product domains deeply without requiring one fact per sampled file", () => {
    const area = {
      key: "project_domain:email-intake",
      label: "Email intake",
      scopeKey: "example/proposal-system",
      files: Array.from({ length: 31 }, (_, index) => ({
        id: `email-${index}`,
        path: `src/email-intake/operation-${index}.ts`,
        score: 31 - index,
      })),
    };
    const inspectedFileSnapshotIds = area.files.slice(0, 17).map((file) => file.id);
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.slice(0, 8).map((fileId, index) => ({
          ...candidate(area.key, fileId),
          statement: `Email intake operation ${index} is implemented.`,
        })),
      }],
      allowRepair: false,
    });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 17,
      requiredSupportedCandidates: 8,
      requiredSupportedFiles: 8,
      status: "covered",
    });
  });

  it("separates clean bounded coverage from execution failure or weak evidence", () => {
    const area = {
      key: "project_domain:email-intake",
      label: "Email intake",
      scopeKey: "example/proposal-system",
      files: Array.from({ length: 31 }, (_, index) => ({
        id: `email-${index}`,
        path: `src/email-intake/operation-${index}.ts`,
        score: 31 - index,
      })),
    };
    const inspectedFileSnapshotIds = area.files.slice(0, 11).map((file) => file.id);
    const supportedCandidates = inspectedFileSnapshotIds.slice(0, 8).map((fileId, index) => ({
      ...candidate(area.key, fileId),
      statement: `Email intake operation ${index} is implemented.`,
    }));
    const limited = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{ inspectedFileSnapshotIds, candidates: supportedCandidates }],
      allowRepair: false,
      capacityLimited: true,
    });

    expect(limited.domains[0]).toMatchObject({
      targetSamples: 17,
      inspectedSamples: 11,
      supportedCandidates: 8,
      requiredSupportedFiles: 8,
      status: "coverage_limited",
    });
    expect(limited.gaps).toEqual([]);
    expect(limited.capacityLimitations).toEqual([
      expect.stringContaining("11 of 17 desired samples"),
    ]);

    const fullyInspectedFileSnapshotIds = area.files.slice(0, 17).map((file) => file.id);
    const capacityRetry = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: fullyInspectedFileSnapshotIds,
        retryFileSnapshotIds: [fullyInspectedFileSnapshotIds.at(-1)!],
        capacityLimitedFileSnapshotIds: [fullyInspectedFileSnapshotIds.at(-1)!],
        candidates: supportedCandidates,
      }],
      allowRepair: false,
      capacityLimited: true,
    });
    expect(capacityRetry.domains[0]?.status).toBe("coverage_limited");
    expect(capacityRetry.gaps).toEqual([]);
    expect(capacityRetry.capacityLimitations).toEqual([
      expect.stringContaining("evidence and diversity floors were met"),
    ]);

    const fullyInspectedOrdinaryRetry = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: fullyInspectedFileSnapshotIds,
        retryFileSnapshotIds: [fullyInspectedFileSnapshotIds.at(-1)!],
        candidates: supportedCandidates,
      }],
      allowRepair: false,
      capacityLimited: true,
    });
    // Domain evidence remains covered, but the ordinary retry is not relabeled
    // as capacity-limited; the separate execution-gap barrier stays blocking.
    expect(fullyInspectedOrdinaryRetry.domains[0]?.status).toBe("covered");
    expect(fullyInspectedOrdinaryRetry.capacityLimitations).toEqual([]);

    const evidenceSaturatedRetry = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        retryFileSnapshotIds: [inspectedFileSnapshotIds[0]!],
        candidates: supportedCandidates,
      }],
      allowRepair: false,
      capacityLimited: true,
    });
    // Once the evidence and diversity floors are met, the larger sample target
    // remains an exploration ceiling. The exact failed file is still handled
    // separately by the execution-gap barrier.
    expect(evidenceSaturatedRetry.domains[0]?.status).toBe("coverage_limited");
    expect(evidenceSaturatedRetry.gaps).toEqual([]);
    expect(evidenceSaturatedRetry.capacityLimitations).toEqual([
      expect.stringContaining("evidence and diversity floors were met"),
    ]);

    const weakEvidence = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: supportedCandidates.slice(0, 7),
      }],
      allowRepair: false,
      capacityLimited: true,
    });
    expect(weakEvidence.domains[0]?.status).toBe("thin");
    expect(weakEvidence.capacityLimitations).toEqual([]);
  });

  it("uses broad-domain top-up slots for runtime operations before maintenance artifacts", () => {
    const inspectedFiles = Array.from({ length: 8 }, (_, index) => ({
      id: `inspected-${index}`,
      path: `src/email-intake/current-operation-${index}.py`,
      score: 120 - index,
    }));
    const runtimeFiles = [
      ["email-sender", "email_sender.py"],
      ["requirement-extractor", "requirement_extractor.py"],
      ["pdf-generator", "pdf_generator.py"],
      ["wireframe-patcher", "wireframe_patcher.py"],
      ["response-reviser", "response_reviser.py"],
      ["vision-analyzer", "vision_analyzer.py"],
    ].map(([id, basename], index) => ({
      id,
      path: `src/email-intake/${basename}`,
      score: 100 - index,
    }));
    const maintenanceFiles = [
      { id: "migration", path: "src/email-intake/migrate_dynamodb.py", score: 300 },
      { id: "deployment", path: "src/email-intake/deployment_tracker.py", score: 290 },
      { id: "gateway-config", path: "src/email-intake/api_gateway_config.yaml", score: 280 },
    ];
    const fillerFiles = Array.from({ length: 17 }, (_, index) => ({
      id: `filler-${index}`,
      path: `src/email-intake/helpers/filler-${index}.py`,
      score: 10 - index / 10,
    }));
    const area = {
      key: "project_domain:email-intake",
      label: "Email intake",
      scopeKey: "example/proposal-system",
      salience: 100,
      files: [
        ...inspectedFiles,
        ...maintenanceFiles,
        ...runtimeFiles,
        ...fillerFiles,
      ],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: inspectedFiles.map((file) => file.id),
        candidates: inspectedFiles.map((file, index) => ({
          ...candidate(area.key, file.id),
          statement: `Existing operation ${index} is implemented.`,
        })),
      }],
      allowRepair: true,
    });
    const selected = critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    );

    expect(selected).toHaveLength(8);
    expect(selected.filter((fileId) =>
      runtimeFiles.some((file) => file.id === fileId)
    )).toHaveLength(6);
    expect(selected).toEqual(expect.arrayContaining([
      "requirement-extractor",
      "response-reviser",
    ]));
    expect(selected).not.toEqual(expect.arrayContaining(
      maintenanceFiles.map((file) => file.id),
    ));
  });

  it("builds a bounded follow-up plan when a first repair leaves true audit-depth gaps", () => {
    const area = (key: string, label: string, salience: number) => ({
      key,
      label,
      scopeKey: "example/marketplace",
      salience,
      files: Array.from({ length: 16 }, (_, index) => ({
        id: `${label.toLowerCase()}-${index}`,
        path: `src/${label.toLowerCase()}/workflow-${index}.ts`,
        score: 16 - index,
      })),
    });
    const product = area("project_domain:product", "Product", 100);
    const founder = area("project_domain:founder", "Founder", 90);
    const supported = (key: string, fileSnapshotId: string) => ({
      ...candidate(key, fileSnapshotId),
      statement: `${key} is supported by ${fileSnapshotId}.`,
    });
    const firstWaveReports = [{
      inspectedFileSnapshotIds: [
        "product-0", "product-1", "product-2",
        "founder-0", "founder-1", "founder-2",
      ],
      candidates: [
        supported(product.key, "product-0"),
        supported(product.key, "product-1"),
        supported(founder.key, "founder-0"),
        supported(founder.key, "founder-1"),
      ],
    }];

    const followUp = critiqueRepositoryCoverage({
      manifest: [product, founder],
      reports: firstWaveReports,
      allowRepair: true,
    });

    expect(followUp.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: product.key, targetSamples: 4, inspectedSamples: 3, status: "thin" }),
      expect.objectContaining({ key: founder.key, targetSamples: 4, inspectedSamples: 3, status: "thin" }),
    ]));
    const selected = followUp.repairPackages.flatMap((entry) => entry.fileSnapshotIds);
    expect(selected).toHaveLength(2);
    expect(selected.some((id) => id.startsWith("product-"))).toBe(true);
    expect(selected.some((id) => id.startsWith("founder-"))).toBe(true);
    expect(selected.some((id) => firstWaveReports[0]!.inspectedFileSnapshotIds.includes(id))).toBe(false);

    const completed = critiqueRepositoryCoverage({
      manifest: [product, founder],
      reports: [
        ...firstWaveReports,
        {
          inspectedFileSnapshotIds: selected,
          candidates: selected.map((id) => supported(
            id.startsWith("product-") ? product.key : founder.key,
            id,
          )),
        },
      ],
      allowRepair: false,
    });
    expect(completed.domains.every((domain) => domain.status === "covered")).toBe(true);
    expect(completed.repairPackages).toEqual([]);
  });

  it("bounds a failed broad-area repair to two funded micro-batches and leaves depth auditable", () => {
    const area = {
      key: "project_domain:catalog",
      label: "Catalog",
      scopeKey: "example/product",
      salience: 100,
      files: Array.from({ length: 31 }, (_, index) => ({
        id: `catalog-${index}`,
        path: `src/catalog/file-${index}.ts`,
        score: 31 - index,
      })),
    };
    const critique = critiqueRepositoryCoverage({ manifest: [area], reports: [], allowRepair: true });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 17,
      requiredSupportedCandidates: 8,
      requiredSupportedFiles: 8,
      status: "missing",
    });
    expect(critique.repairPackages).toHaveLength(2);
    expect(critique.repairPackages.map((entry) => entry.fileSnapshotIds)).toEqual([
      expect.arrayContaining([
        "catalog-0",
        "catalog-1",
        "catalog-2",
        "catalog-3",
      ]),
      expect.arrayContaining([
        "catalog-4",
        "catalog-5",
        "catalog-6",
        "catalog-7",
      ]),
    ]);
    expect(critique.gaps).toEqual([expect.stringContaining("no supported semantic finding")]);
  });

  it("fits non-overlapping four-file and three-file coverage debts into two repair calls", () => {
    const broadArea = (key: string, label: string, salience: number) => ({
      key,
      label,
      scopeKey: "example/broad-application",
      salience,
      files: Array.from({ length: 31 }, (_, index) => ({
        id: `${key}-${index}`,
        path: `src/${key}/workflow-${index}.ts`,
        score: 31 - index,
      })),
    });
    const intelligence = broadArea("intelligence", "Intelligence", 100);
    const applicationCore = broadArea("application-core", "Application core", 90);
    const supported = (key: string, fileSnapshotId: string) => ({
      ...candidate(key, fileSnapshotId),
      statement: `${key} is supported by ${fileSnapshotId}.`,
    });
    const initiallySupported = [
      ...intelligence.files.slice(0, 4).map((file) => supported(intelligence.key, file.id)),
      ...applicationCore.files.slice(0, 5).map((file) => supported(applicationCore.key, file.id)),
    ];
    const initialReport = {
      inspectedFileSnapshotIds: initiallySupported.flatMap((entry) =>
        entry.evidence.map((evidence) => evidence.fileSnapshotId)
      ),
      candidates: initiallySupported,
    };

    const critique = critiqueRepositoryCoverage({
      manifest: [intelligence, applicationCore],
      reports: [initialReport],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(critique.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: intelligence.key,
        supportedFileCount: 4,
        requiredSupportedFiles: 6,
        status: "thin",
      }),
      expect.objectContaining({
        key: applicationCore.key,
        supportedFileCount: 5,
        requiredSupportedFiles: 6,
        status: "thin",
      }),
    ]));
    expect(critique.repairPackages.map((entry) => entry.fileSnapshotIds.length)).toEqual([4, 3]);
    expect(repairedIds.filter((id) => id.startsWith("intelligence-"))).toHaveLength(4);
    expect(repairedIds.filter((id) => id.startsWith("application-core-"))).toHaveLength(3);

    const completed = critiqueRepositoryCoverage({
      manifest: [intelligence, applicationCore],
      reports: [
        initialReport,
        {
          inspectedFileSnapshotIds: repairedIds,
          candidates: repairedIds.map((id) => supported(
            id.startsWith("intelligence-") ? intelligence.key : applicationCore.key,
            id,
          )),
        },
      ],
      allowRepair: false,
    });
    expect(completed.gaps).toEqual([]);
    expect(completed.domains.every((domain) => domain.status === "covered")).toBe(true);
  });

  it("does not admit documentation source merely because it contains a Java production-shaped suffix", () => {
    expect(isImplementationEvidencePath("docs/src/main/java/com/acme/orders/Demo.java")).toBe(false);
    expect(isImplementationEvidencePath("src/main/java/com/example/orders/Order.java")).toBe(true);
  });

  it("does not let language-specific declaration volume dominate cartography", () => {
    const twoSymbols = mappedFile("two-symbols", "src/features/catalog/a-entry.py");
    const manySymbols = mappedFile("many-symbols", "src/features/catalog/z-helper.py");
    twoSymbols.analysis.symbols = ["Search", "query"];
    manySymbols.analysis.symbols = Array.from({ length: 12 }, (_, index) => `helper_${index}`);

    const catalog = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/project",
      files: [manySymbols, twoSymbols],
    }).find((area) => area.key === "project_domain:catalog");

    expect(catalog?.files.map((file) => file.id)).toEqual(["two-symbols", "many-symbols"]);
  });

  it("fits ten independent areas into five single-call worker packages", () => {
    const manifest = Array.from({ length: 10 }, (_, areaIndex) => ({
      key: `project_domain:area-${areaIndex}`,
      label: `Area ${areaIndex}`,
      scopeKey: "example/broad-project",
      salience: 100 - areaIndex,
      files: Array.from({ length: 12 }, (_, fileIndex) => ({
        id: `area-${areaIndex}-file-${fileIndex}`,
        path: `src/features/area-${areaIndex}/file-${fileIndex}.ts`,
        score: 20 - fileIndex,
      })),
    }));

    const plan = buildRepositoryDerivedSemanticPlan({ manifest });
    expect(plan).toHaveLength(5);
    expect(plan.every((workPackage) => workPackage.fileSnapshotIds.length <= 4)).toBe(true);
    expect(new Set(plan.flatMap((workPackage) => workPackage.capabilityKeys)).size).toBe(10);
  });

  it("samples distinct path families before near-duplicate files", () => {
    const area = {
      key: "repository_area:data_model",
      label: "Data model and persistence",
      scopeKey: "example/desktop",
      salience: 120,
      files: [
        { id: "model-a", path: "src/main/model/Product.java", score: 100 },
        { id: "model-b", path: "src/main/model/Order.java", score: 90 },
        { id: "model-c", path: "src/main/model/Customer.java", score: 80 },
        { id: "loader", path: "src/main/persistence/DataLoader.java", score: 40 },
        { id: "writer", path: "src/main/persistence/DataWriter.java", score: 30 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toContain("model-a");
    expect(plan[0]?.fileSnapshotIds).toContain("loader");
  });

  it("samples distinct initialism-based workflows from a flat presentation directory before operation siblings", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/desktop-operations",
      salience: 120,
      files: [
        { id: "receivable-create", path: "src/ui/ARCreate.tsx", score: 100 },
        { id: "receivable-edit", path: "src/ui/AREdit.tsx", score: 99 },
        { id: "receivable-view", path: "src/ui/ARView.tsx", score: 98 },
        { id: "payable-create", path: "src/ui/APCreate.tsx", score: 80 },
        { id: "ledger-list", path: "src/ui/LedgerList.tsx", score: 70 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });

    expect(plan[0]?.fileSnapshotIds).toEqual(["payable-create", "receivable-create"]);
    expect(plan[0]?.fileSnapshotIds).not.toEqual(expect.arrayContaining([
      "receivable-edit",
      "receivable-view",
    ]));
  });

  it("uses bounded repair to represent broad flat presentation workflow families", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/desktop-operations",
      salience: 120,
      files: [
        { id: "shell", path: "src/ui/MainMenu.tsx", score: 110 },
        { id: "invoice-create", path: "src/ui/InvoiceCreate.tsx", score: 100 },
        { id: "invoice-edit", path: "src/ui/InvoiceEdit.tsx", score: 99 },
        { id: "invoice-view", path: "src/ui/InvoiceView.tsx", score: 98 },
        { id: "shipment-create", path: "src/ui/ShipmentCreate.tsx", score: 80 },
        { id: "customer-list", path: "src/ui/CustomerList.tsx", score: 70 },
        { id: "payment-dialog", path: "src/ui/PaymentDialog.tsx", score: 60 },
      ],
    };
    const reports = [{
      inspectedFileSnapshotIds: ["shell", "invoice-create", "invoice-edit"],
      candidates: ["shell", "invoice-create", "invoice-edit"].map((id) => ({
        ...candidate(area.key, id),
        statement: `${id} supports a distinct implemented behavior.`,
      })),
    }];

    expect(semanticAuditTarget(area)).toBe(4);
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports,
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      inspectedSamples: 3,
      diversityGaps: 1,
      status: "thin",
    }));
    expect(repairedIds).toEqual(["shipment-create", "customer-list"]);
    expect(repairedIds).not.toEqual(expect.arrayContaining(["invoice-view"]));
    expect(repairedIds.length).toBeLessThanOrEqual(8);
  });

  it("keeps account entrypoints distinct from neighboring authentication handlers", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/account-product",
      salience: 120,
      files: [
        { id: "session", path: "app/api/auth/session/route.ts", score: 100 },
        { id: "login", path: "app/api/login/route.ts", score: 99 },
        { id: "register", path: "app/api/register/route.ts", score: 60 },
        { id: "onboarding", path: "app/api/onboarding/profile/route.ts", score: 50 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["register", "session"]);
    expect(plan[0]?.fileSnapshotIds).not.toContain("login");
  });

  it("repairs an unrepresented named boundary in broad application core", () => {
    const area = {
      key: "repository_area:application_core",
      label: "Application core",
      scopeKey: "example/general-service",
      salience: 240,
      files: [
        { id: "identity", path: "src/auth/session-handler.ts", score: 100 },
        { id: "account-entry", path: "src/account-registration-service.ts", score: 95 },
        { id: "membership", path: "src/team-membership-service.ts", score: 90 },
        { id: "analytics", path: "src/services/usage-analytics.ts", score: 85 },
        { id: "orders", path: "src/api/orders/route.ts", score: 80 },
        ...Array.from({ length: 11 }, (_, index) => ({
          id: `generic-${index}`,
          path: `src/services/module-${index}-service.ts`,
          score: 70 - index,
        })),
      ],
    };
    const inspectedFileSnapshotIds = [
      "identity",
      "account-entry",
      "membership",
      "orders",
    ];
    const firstPass = [{
      inspectedFileSnapshotIds,
      candidates: inspectedFileSnapshotIds.map((id) => ({
        ...candidate(area.key, id),
        statement: `${id} supports a distinct implemented behavior.`,
      })),
    }];

    expect(semanticAuditTarget(area)).toBe(4);
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: firstPass,
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    );

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      targetSamples: 4,
      inspectedSamples: 4,
      diversityGaps: 1,
      diversityGapDescriptions: [
        "missing analytics reporting behavior family",
      ],
      status: "thin",
    }));
    expect(repairedIds).toEqual(["analytics"]);
    expect(repairedIds).not.toEqual(expect.arrayContaining([
      "generic-0",
      "generic-1",
    ]));

    const finalCritique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [
        ...firstPass,
        {
          inspectedFileSnapshotIds: ["analytics"],
          candidates: [candidate(area.key, "analytics")],
        },
      ],
      allowRepair: false,
    });
    expect(finalCritique.domains[0]).toEqual(expect.objectContaining({
      diversityGaps: 0,
      status: "covered",
    }));

    const unsupportedBoundaryCritique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [
        ...firstPass,
        {
          inspectedFileSnapshotIds: ["analytics"],
          candidates: [],
        },
      ],
      allowRepair: false,
    });
    expect(unsupportedBoundaryCritique.domains[0]).toEqual(expect.objectContaining({
      diversityGaps: 1,
      diversityGapDescriptions: [
        "missing analytics reporting behavior family",
      ],
      status: "thin",
    }));
  });

  it("requires a low-scoring named boundary outside the bounded ideal sample", () => {
    const area = {
      key: "repository_area:application_core",
      label: "Application core",
      scopeKey: "example/broad-runtime",
      salience: 240,
      files: [
        { id: "service", path: "src/services/order-service.ts", score: 1_000 },
        { id: "interface", path: "src/api/orders/route.ts", score: 900 },
        { id: "persistence", path: "src/data/order-repository.ts", score: 800 },
        { id: "integration", path: "src/integrations/payment-provider.ts", score: 700 },
        { id: "analytics-current", path: "src/analytics/current-report.ts", score: 2 },
        { id: "analytics-legacy", path: "src/analytics/legacy-report.ts", score: 1 },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `helper-${index}`,
          path: `src/modules/module-${index}.ts`,
          score: 100 - index,
        })),
      ],
    };
    const inspectedFileSnapshotIds = [
      "service",
      "interface",
      "persistence",
      "integration",
    ];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} supports a distinct implemented behavior.`,
        })),
      }],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    );

    expect(semanticAuditTarget(area)).toBe(4);
    expect(critique.domains[0]).toEqual(expect.objectContaining({
      diversityGapDescriptions: [
        "missing analytics reporting behavior family",
      ],
      status: "thin",
    }));
    expect(repairedIds).toContain("analytics-current");
    expect(repairedIds).not.toContain("analytics-legacy");
  });

  it("repairs a new product workflow before a second onboarding variant", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/role-marketplace",
      salience: 120,
      files: [
        { id: "session", path: "app/api/auth/session/route.ts", score: 100 },
        { id: "founder", path: "app/api/onboarding/founder/route.ts", score: 99 },
        { id: "investor", path: "app/api/onboarding/investor/route.ts", score: 98 },
        { id: "messages", path: "app/api/messages/send/route.ts", score: 80 },
        { id: "products", path: "app/api/products/route.ts", score: 70 },
        { id: "feed", path: "app/api/feed/events/route.ts", score: 60 },
        { id: "profile", path: "app/profile/page.tsx", score: 50 },
      ],
    };
    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["founder", "session"]);

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: plan[0]!.fileSnapshotIds,
        candidates: plan[0]!.fileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });
    expect(critique.repairPackages[0]?.fileSnapshotIds).toContain("messages");
    expect(critique.repairPackages[0]?.fileSnapshotIds).not.toContain("investor");
  });

  it("retains role-specific onboarding variants after broader boundaries are covered", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/role-marketplace",
      salience: 120,
      files: [
        { id: "session", path: "app/api/auth/session/route.ts", score: 100 },
        { id: "founder", path: "app/api/onboarding/founder/route.ts", score: 99 },
        { id: "investor", path: "app/api/onboarding/investor/route.ts", score: 98 },
        { id: "profile", path: "app/api/onboarding/profile/route.ts", score: 80 },
        { id: "login", path: "app/api/login/route.ts", score: 70 },
        { id: "signin", path: "app/api/signin/route.ts", score: 60 },
        { id: "auth", path: "app/api/auth/callback/route.ts", score: 50 },
      ],
    };
    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: plan[0]!.fileSnapshotIds,
        candidates: plan[0]!.fileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });

    expect(plan[0]?.fileSnapshotIds).toEqual(["founder", "session"]);
    expect(critique.repairPackages[0]?.fileSnapshotIds).toContain("investor");
  });

  it("samples a concrete branch when overlap covered only a generic entry path", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/overlapping-product",
      salience: 120,
      files: [
        { id: "generic", path: "app/onboarding/page.tsx", score: 101 },
        { id: "session", path: "app/api/auth/session/route.ts", score: 100 },
        { id: "founder", path: "app/api/onboarding/founder/route.ts", score: 99 },
        { id: "investor", path: "app/api/onboarding/investor/route.ts", score: 98 },
        { id: "messages", path: "app/api/messages/send/route.ts", score: 80 },
        { id: "products", path: "app/api/products/route.ts", score: 70 },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `page-${index}`,
          path: `app/dashboard/section-${index}/page.tsx`,
          score: 60 - index,
        })),
      ],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        // These may arrive through packages owned by neighboring manifest
        // areas. Counts are sufficient, but onboarding is represented only by
        // the generic page while two concrete sibling routes remain unseen.
        inspectedFileSnapshotIds: ["generic", "session", "messages", "products"],
        candidates: ["generic", "session", "messages", "products"].map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} implements a distinct supported behavior.`,
        })),
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      inspectedSamples: 4,
      status: "thin",
      missingBranchVariants: 1,
    }));
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(["founder"]);
  });

  it("does not let onboarding wizard steps consume a broad repair wave", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/onboarding-product",
      salience: 200,
      files: [
        { id: "session", path: "app/api/auth/session/route.ts", score: 120 },
        { id: "founder", path: "app/api/onboarding/founder/route.ts", score: 119 },
        ...["profile", "preferences", "verify", "complete", "team", "billing"].map((step, index) => ({
          id: `step-${step}`,
          path: `app/api/onboarding/${step}/route.ts`,
          score: 118 - index,
        })),
        { id: "messages", path: "app/api/messages/send/route.ts", score: 100 },
        { id: "catalog", path: "app/api/catalog/items/route.ts", score: 90 },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `page-${index}`,
          path: `app/dashboard/section-${index}/page.tsx`,
          score: 60 - index,
        })),
      ],
    };
    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: plan[0]!.fileSnapshotIds,
        candidates: plan[0]!.fileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(repairedIds).toEqual(expect.arrayContaining(["messages", "catalog"]));
    expect(repairedIds.some((id) => id.startsWith("step-"))).toBe(false);
  });

  it("classifies and selects a repository implementation ahead of database wiring", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/persisted-service",
      files: [
        mappedFile("db-client", "lib/db/client.ts"),
        mappedFile("db-config", "lib/db/config.ts"),
        mappedFile("repository", "lib/db/repository.ts"),
        mappedFile("schema", "prisma/schema.prisma"),
      ],
    });
    const dataModel = manifest.find((area) => area.key === "repository_area:data_model");
    expect(dataModel?.files.map((file) => file.id)).toEqual(expect.arrayContaining([
      "db-client",
      "db-config",
      "repository",
      "schema",
    ]));

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [dataModel!] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["repository", "schema"]);
  });

  it("prefers a cross-language implementation service over a second client or UI neighbor", () => {
    const area = {
      key: "repository_area:intelligence",
      label: "Search, retrieval, and model intelligence",
      scopeKey: "example/mixed-runtime",
      salience: 120,
      files: [
        { id: "panel", path: "src/main/ui/ForecastPanel.java", score: 110 },
        { id: "client", path: "src/main/service/ForecastClient.java", score: 100 },
        { id: "adapter", path: "src/main/service/ForecastAdapter.java", score: 90 },
        { id: "implementation", path: "ml_service/forecast_service.py", score: 50 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["client", "implementation"]);
    expect(plan[0]?.fileSnapshotIds).not.toEqual(expect.arrayContaining(["panel", "adapter"]));
  });

  it("keeps runtime services ahead of schema history in non-data structural areas", () => {
    const area = {
      key: "repository_area:intelligence",
      label: "Search, retrieval, and model intelligence",
      scopeKey: "example/knowledge-runtime",
      salience: 120,
      files: [
        { id: "migration", path: "prisma/migrations/20260101_chat/migration.sql", score: 200 },
        { id: "schema", path: "prisma/schema.prisma", score: 190 },
        { id: "synthesis", path: "src/services/knowledge-synthesis-service.ts", score: 80 },
        { id: "review", path: "src/services/knowledge-review-service.ts", score: 70 },
        { id: "chat", path: "src/services/project-chat-agent-service.ts", score: 60 },
      ],
    };

    const selected = buildRepositoryDerivedSemanticPlan({ manifest: [area] })
      .flatMap((workPackage) => workPackage.fileSnapshotIds);
    expect(selected).toHaveLength(2);
    expect(selected.every((id) => ["synthesis", "review", "chat"].includes(id)))
      .toBe(true);
  });

  it("does not let overlapping UI or schema findings satisfy a broad runtime audit", () => {
    const runtimeFiles = Array.from({ length: 8 }, (_, index) => ({
      id: `runtime-${index}`,
      path: `src/services/operation-${index}-service.ts`,
      score: 80 - index,
    }));
    const overlappingFiles = [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `screen-${index}`,
        path: `components/Screen${index}.tsx`,
        score: 200 - index,
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `migration-${index}`,
        path: `db/migrations/${index}-change.sql`,
        score: 180 - index,
      })),
    ];
    const area = {
      key: "repository_area:intelligence",
      label: "Search, retrieval, and model intelligence",
      scopeKey: "example/runtime-audit",
      salience: 500,
      files: [...runtimeFiles, ...overlappingFiles],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: overlappingFiles.slice(0, 8).map((file) => ({
        inspectedFileSnapshotIds: [file.id],
        candidates: [candidate(area.key, file.id)],
      })),
      allowRepair: true,
    });

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      totalFiles: 8,
      targetSamples: 8,
      inspectedSamples: 0,
      supportedCandidates: 0,
      status: "missing",
    }));
    expect(new Set(critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    ))).toEqual(new Set(runtimeFiles.map((file) => file.id)));
  });

  it("samples distinct workflow roles from a flat agent module", () => {
    const area = {
      key: "project_domain:document-intake",
      label: "Document intake",
      scopeKey: "example/automation-suite",
      salience: 120,
      files: [
        { id: "metadata-extractor", path: "src/agents/intake/metadata_extractor.py", score: 100 },
        { id: "requirement-extractor", path: "src/agents/intake/requirement_extractor.py", score: 99 },
        { id: "document-generator", path: "src/agents/intake/document_generator.py", score: 70 },
        { id: "vision-analyzer", path: "src/agents/intake/vision_analyzer.py", score: 60 },
        { id: "response-reviewer", path: "src/agents/intake/response_reviewer.py", score: 50 },
        { id: "response-reviser", path: "src/agents/intake/response_reviser.py", score: 40 },
        { id: "conversation-state", path: "src/agents/intake/conversation_state.py", score: 30 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["document-generator", "metadata-extractor"]);
    expect(plan[0]?.fileSnapshotIds).not.toContain("requirement-extractor");

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: plan[0]!.fileSnapshotIds,
        candidates: plan[0]!.fileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "vision-analyzer",
    ]);
  });

  it("uses bounded repair to inspect a third controller operation role", () => {
    const area = {
      key: "project_domain:record-processing",
      label: "Record processing",
      scopeKey: "example/processing-service",
      salience: 120,
      files: [
        { id: "request-parser", path: "src/controllers/processing/RequestParser.ts", score: 300 },
        { id: "operation-contract", path: "src/controllers/processing/IProcessing.ts", score: 250 },
        { id: "io-executor", path: "src/controllers/processing/IOExecutor.ts", score: 200 },
        { id: "metric-calculator", path: "src/controllers/processing/MetricCalculator.ts", score: 10 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    const initiallySelected = plan[0]!.fileSnapshotIds;
    expect(semanticSampleTarget(area)).toBe(2);
    expect(semanticAuditTarget(area)).toBe(2);
    expect(initiallySelected).toEqual(["io-executor", "request-parser"]);

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: initiallySelected,
        candidates: initiallySelected.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 2,
      inspectedSamples: 2,
      diversityGaps: 1,
      status: "thin",
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "metric-calculator",
    ]);
  });

  it.each([
    {
      language: "TypeScript",
      paths: {
        parser: "src/query/parser.ts",
        contract: "src/query/IQuery.ts",
        executor: "src/query/executor.ts",
        calculations: "src/query/calculations.ts",
      },
    },
    {
      language: "Python",
      paths: {
        parser: "src/query/parser.py",
        contract: "src/query/IQuery.py",
        executor: "src/query/executor.py",
        calculations: "src/query/calculations.py",
      },
    },
    {
      language: "Java",
      paths: {
        parser: "src/main/java/com/example/query/Parser.java",
        contract: "src/main/java/com/example/query/IQuery.java",
        executor: "src/main/java/com/example/query/Executor.java",
        calculations: "src/main/java/com/example/query/Calculations.java",
      },
    },
  ])("repairs a third sibling operation in a framework-neutral $language layout", ({ paths }) => {
    const area = {
      key: "project_domain:query",
      label: "Query",
      scopeKey: "example/query-engine",
      salience: 120,
      files: [
        { id: "parser", path: paths.parser, score: 300 },
        { id: "contract", path: paths.contract, score: 250 },
        { id: "executor", path: paths.executor, score: 200 },
        { id: "calculations", path: paths.calculations, score: 10 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    const initiallySelected = plan[0]!.fileSnapshotIds;
    expect(initiallySelected).toEqual(["executor", "parser"]);

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: initiallySelected,
        candidates: initiallySelected.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 2,
      inspectedSamples: 2,
      diversityGaps: 1,
      status: "thin",
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "calculations",
    ]);
    expect([
      ...initiallySelected,
      ...critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds),
    ]).not.toContain("contract");
  });

  it("preserves role-only basenames when no subject module is present", () => {
    const area = {
      key: "project_domain:job-control",
      label: "Job control",
      scopeKey: "example/worker-suite",
      salience: 100,
      files: [
        { id: "executor", path: "src/agents/executor.py", score: 100 },
        { id: "executor-helper", path: "src/agents/executor_helper.py", score: 99 },
        { id: "dispatcher", path: "src/agents/dispatcher.py", score: 70 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["dispatcher", "executor"]);
  });

  it("derives modules from directories for generic role basenames", () => {
    const area = {
      key: "project_domain:operations",
      label: "Operations",
      scopeKey: "example/service-suite",
      salience: 100,
      files: [
        { id: "billing", path: "src/billing/service.go", score: 100 },
        { id: "billing-helper", path: "src/billing/service_helper.go", score: 99 },
        { id: "notifications", path: "src/notifications/service.go", score: 70 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["billing", "notifications"]);
  });

  it("keeps backend operational modules visible in a UI-heavy project domain", () => {
    const area = {
      key: "project_domain:workspace",
      label: "Workspace",
      scopeKey: "example/ui-heavy-workspace",
      salience: 180,
      files: [
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `panel-${index}`,
          path: `src/ui/workspace/Panel${index}.tsx`,
          score: 140 - index,
        })),
        {
          id: "document-ingestion",
          path: "src/services/document-ingestion-service.ts",
          score: 70,
        },
        {
          id: "retrieval-index",
          path: "src/services/retrieval-index-service.ts",
          score: 60,
        },
        {
          id: "export-renderer",
          path: "src/services/export-renderer-service.ts",
          score: 50,
        },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    const initiallySelected = plan.flatMap((entry) => entry.fileSnapshotIds);
    expect(initiallySelected.some((id) => [
      "document-ingestion",
      "retrieval-index",
      "export-renderer",
    ].includes(id))).toBe(true);

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: initiallySelected,
        candidates: initiallySelected.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });
    const selectedAcrossWaves = new Set([
      ...initiallySelected,
      ...critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds),
    ]);
    expect([
      "document-ingestion",
      "retrieval-index",
      "export-renderer",
    ].filter((id) => selectedAcrossWaves.has(id)).length).toBeGreaterThanOrEqual(2);
  });

  it("filters generic scaffolding before selecting provider implementations", () => {
    const area = {
      key: "repository_area:integrations",
      label: "Integrations",
      scopeKey: "example/runtime-gateway",
      salience: 100,
      files: [
        { id: "base", path: "src/providers/base.py", score: 120 },
        { id: "factory", path: "src/providers/factory.py", score: 110 },
        { id: "index", path: "src/providers/index.ts", score: 100 },
        { id: "abstract", path: "src/providers/abstract.py", score: 90 },
        { id: "cloud-runtime", path: "src/providers/cloud_runtime.py", score: 60 },
        { id: "local-runtime", path: "src/providers/local_runtime.py", score: 50 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["cloud-runtime", "local-runtime"]);
  });

  it("does not discard operational files whose names begin with scaffolding words", () => {
    const area = {
      key: "project_domain:operations",
      label: "Operations",
      scopeKey: "example/operational-prefixes",
      salience: 100,
      files: [
        { id: "base", path: "src/base.ts", score: 120 },
        { id: "factory", path: "src/factory.ts", score: 110 },
        { id: "index", path: "src/index.ts", score: 105 },
        { id: "index-documents", path: "src/index_documents.py", score: 100 },
        { id: "factory-reset", path: "src/factory_reset_service.py", score: 99 },
        { id: "base-pricing", path: "src/base_pricing_calculator.ts", score: 98 },
      ],
    };

    const selected = buildRepositoryDerivedSemanticPlan({ manifest: [area] })
      .flatMap((workPackage) => workPackage.fileSnapshotIds);
    expect(selected).toHaveLength(2);
    expect(selected.every((id) => ["index-documents", "factory-reset", "base-pricing"].includes(id)))
      .toBe(true);
  });

  it("retains compound entrypoints made only from generic infrastructure words", () => {
    const area = {
      key: "project_domain:operations",
      label: "Operations",
      scopeKey: "example/generic-entrypoints",
      salience: 100,
      files: [
        { id: "main-worker", path: "src/main_worker.py", score: 100 },
        { id: "default-handler", path: "src/default_handler.ts", score: 99 },
        { id: "registry-service", path: "src/registry_service.ts", score: 98 },
      ],
    };

    const selected = buildRepositoryDerivedSemanticPlan({ manifest: [area] })
      .flatMap((workPackage) => workPackage.fileSnapshotIds);
    expect(selected).toHaveLength(2);
    expect(selected.every((id) => area.files.some((file) => file.id === id))).toBe(true);
  });

  it("does not let low-salience novelty displace a strong implementation", () => {
    const area = {
      key: "project_domain:processing",
      label: "Processing",
      scopeKey: "example/processing-suite",
      salience: 100,
      files: [
        { id: "primary-executor", path: "src/core/primary_executor.ts", score: 100 },
        { id: "secondary-executor", path: "src/core/secondary_executor.ts", score: 99 },
        { id: "minor-generator", path: "src/core/minor_generator.ts", score: 3 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["primary-executor", "secondary-executor"]);
    expect(plan[0]?.fileSnapshotIds).not.toContain("minor-generator");
  });

  it("does not hide a distinct workflow behind a fixed score threshold", () => {
    const area = {
      key: "project_domain:processing",
      label: "Processing",
      scopeKey: "example/processing-threshold",
      salience: 100,
      files: [
        { id: "primary-executor", path: "src/core/primary_executor.ts", score: 100 },
        { id: "secondary-executor", path: "src/core/secondary_executor.ts", score: 99 },
        { id: "document-generator", path: "src/core/document_generator.ts", score: 39 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["document-generator", "primary-executor"]);
  });

  it("uses arbitrary flat workflow stems without a role vocabulary", () => {
    const area = {
      key: "project_domain:processing",
      label: "Processing",
      scopeKey: "example/flat-workflows",
      salience: 100,
      files: [
        { id: "ingest", path: "src/ingest.py", score: 100 },
        { id: "ingest-helper", path: "src/ingest_helper.py", score: 99 },
        { id: "reconcile", path: "src/reconcile.py", score: 40 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(["ingest", "reconcile"]);
  });

  it("repairs a broad area that was inspected through only one runtime and layer", () => {
    const area = {
      key: "repository_area:intelligence",
      label: "Search, retrieval, and model intelligence",
      scopeKey: "example/mixed-runtime",
      salience: 120,
      files: [
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `panel-${index}`,
          path: `src/main/ui/ForecastPanel${index}.java`,
          score: 100 - index,
        })),
        { id: "python-service", path: "ml_service/forecast_service.py", score: 50 },
      ],
    };
    const javaReports = area.files.slice(0, 4).map((file) => ({
      inspectedFileSnapshotIds: [file.id],
      candidates: [{
        ...candidate(area.key, file.id),
        statement: `${file.id} supports a distinct forecast presentation behavior.`,
      }],
    }));
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: javaReports,
      allowRepair: true,
    });

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      inspectedSamples: 4,
      diversityGaps: 2,
      status: "thin",
    }));
    expect(critique.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining("implementation layers"),
      expect.stringContaining("language families"),
    ]));
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "python-service",
    ]);

    const finalCritique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [...javaReports, {
        inspectedFileSnapshotIds: ["python-service"],
        candidates: [{
          ...candidate(area.key, "python-service"),
          statement: "The Python service implements the forecast runtime.",
        }],
      }],
      allowRepair: false,
    });
    expect(finalCritique.domains[0]?.status).toBe("covered");
  });

  it("recognizes filename-based sibling onboarding branches", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/flat-onboarding",
      salience: 120,
      files: [
        { id: "generic", path: "src/onboarding/index.ts", score: 100 },
        { id: "founder", path: "src/onboarding/founder.ts", score: 99 },
        { id: "investor", path: "src/onboarding/investor.ts", score: 98 },
        { id: "messages", path: "src/services/messages/service.ts", score: 80 },
        { id: "feed", path: "src/services/feed/service.ts", score: 70 },
        ...Array.from({ length: 11 }, (_, index) => ({
          id: `dashboard-${index}`,
          path: `src/dashboard/view-${index}.tsx`,
          score: 60 - index,
        })),
      ],
    };
    const inspectedFileSnapshotIds = ["generic", "messages", "feed", "founder"];
    const alreadyCovered = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} supports a distinct product behavior.`,
        })),
      }],
      allowRepair: true,
    });
    expect(alreadyCovered.domains[0]?.missingBranchVariants).toBe(0);

    const genericOnlyIds = ["generic", "messages", "feed"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: genericOnlyIds,
        candidates: genericOnlyIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} supports a distinct product behavior.`,
        })),
      }],
      allowRepair: true,
    });
    expect(critique.domains[0]?.missingBranchVariants).toBe(1);
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .toEqual(expect.arrayContaining(["founder"]));
  });

  it("does not infer onboarding branches across unrelated monorepo apps", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/monorepo",
      salience: 120,
      files: [
        { id: "admin-generic", path: "apps/admin/onboarding/index.ts", score: 100 },
        { id: "user-founder", path: "apps/user/onboarding/founder.ts", score: 99 },
        { id: "user-investor", path: "apps/user/onboarding/investor.ts", score: 98 },
        { id: "messages", path: "apps/admin/services/messages/service.ts", score: 80 },
        { id: "feed", path: "apps/admin/services/feed/service.ts", score: 70 },
        ...Array.from({ length: 11 }, (_, index) => ({
          id: `admin-view-${index}`,
          path: `apps/admin/dashboard/view-${index}.tsx`,
          score: 60 - index,
        })),
      ],
    };
    const inspectedFileSnapshotIds = ["admin-generic", "messages", "feed", "admin-view-0"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} supports a distinct product behavior.`,
        })),
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]?.missingBranchVariants).toBe(0);
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .not.toEqual(expect.arrayContaining(["user-founder", "user-investor"]));
  });

  it("uses model entity stems to spend repair depth on distinct persisted concepts", () => {
    const area = {
      key: "repository_area:data_model",
      label: "Data model and persistence",
      scopeKey: "example/catalog",
      salience: 120,
      files: [
        { id: "loader", path: "src/main/persistence/DataLoader.java", score: 100 },
        { id: "details-list", path: "src/main/model/ProductDetailsList.java", score: 99 },
        { id: "details", path: "src/main/model/ProductDetails.java", score: 98 },
        { id: "performance", path: "src/main/model/ProductPerformanceList.java", score: 70 },
        { id: "orders", path: "src/main/model/PurchaseOrdersList.java", score: 60 },
        { id: "performance-entity", path: "src/main/model/ProductPerformance.java", score: 65 },
        { id: "orders-entity", path: "src/main/model/PurchaseOrders.java", score: 55 },
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `details-helper-${index}`,
          path: `src/main/model/ProductDetailsModel${index}.java`,
          score: 50 - index,
        })),
      ],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: ["loader", "details-list"],
        candidates: [
          candidate(area.key, "loader"),
          candidate(area.key, "details-list"),
        ],
      }],
      allowRepair: true,
    });

    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "performance-entity",
      "orders-entity",
    ]);
  });

  it("scales distinct data-entity audit depth to a bounded six", () => {
    const entityNames = [
      "Account",
      "Invoice",
      "Payment",
      "Shipment",
      "Product",
      "Supplier",
      "Warehouse",
      "Return",
    ];
    const area = {
      key: "repository_area:data_model",
      label: "Data model and persistence",
      scopeKey: "example/commerce",
      salience: 140,
      files: entityNames.map((name, index) => ({
        id: name.toLowerCase(),
        path: `src/model/${name}.java`,
        score: 100 - index,
      })),
    };
    const inspectedFileSnapshotIds = ["account", "invoice"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} defines a distinct persisted concept.`,
        })),
      }],
      allowRepair: true,
    });

    expect(semanticAuditTarget(area)).toBe(6);
    expect(critique.domains[0]).toMatchObject({
      targetSamples: 6,
      diversityGapDescriptions: ["2/6 data entities"],
      status: "thin",
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .toHaveLength(4);
  });

  it("scales distinct product workflow audit depth to a bounded six", () => {
    const surfaceNames = [
      "Account",
      "Catalog",
      "Checkout",
      "Messages",
      "Orders",
      "Reports",
      "Search",
      "Settings",
    ];
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/commerce-ui",
      salience: 140,
      files: surfaceNames.map((name, index) => ({
        id: name.toLowerCase(),
        path: `src/ui/${name}View.tsx`,
        score: 100 - index,
      })),
    };
    const inspectedFileSnapshotIds = ["account", "catalog"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(area.key, id),
          statement: `${id} implements a distinct product workflow.`,
        })),
      }],
      allowRepair: true,
    });

    expect(semanticAuditTarget(area)).toBe(6);
    expect(critique.domains[0]).toMatchObject({
      targetSamples: 6,
      diversityGapDescriptions: ["2/6 product workflow families"],
      status: "thin",
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .toHaveLength(4);
  });

  it("requires up to eight distinct operation roles in a broad project domain", () => {
    const roles = [
      "Parser",
      "Executor",
      "Calculator",
      "Evaluator",
      "Reviewer",
      "Reviser",
      "Renderer",
      "Exporter",
    ];
    const area = {
      key: "project_domain:document-processing",
      label: "Document processing",
      scopeKey: "example/document-system",
      salience: 180,
      files: [
        ...roles.map((role, index) => ({
          id: role.toLowerCase(),
          path: `src/document/${role}.ts`,
          score: 200 - index,
        })),
        ...Array.from({ length: 23 }, (_, index) => ({
          id: `module-${index}`,
          path: `src/document/module-${index}-service.ts`,
          score: 100 - index,
        })),
      ],
    };
    const inspectedFileSnapshotIds = ["parser", "executor"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: true,
    });

    expect(semanticAuditTarget(area)).toBe(17);
    expect(critique.domains[0]?.diversityGapDescriptions)
      .toContain("2/8 operational roles");
    const repairIds = critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    );
    expect(repairIds).toEqual(expect.arrayContaining([
      "calculator",
      "evaluator",
      "reviewer",
    ]));
    expect(repairIds.filter((id) => roles.map((role) => role.toLowerCase()).includes(id)))
      .toHaveLength(6);
  });

  it("does not mistake generic architectural containers for business operations", () => {
    const area = {
      key: "project_domain:chat",
      label: "Chat",
      scopeKey: "example/chat-system",
      salience: 80,
      files: [
        { id: "service", path: "src/chat/chat-service.ts", score: 80 },
        { id: "client", path: "src/chat/chat-client.ts", score: 70 },
        { id: "handler", path: "src/chat/chat-handler.ts", score: 60 },
        { id: "worker", path: "src/chat/chat-worker.ts", score: 50 },
      ],
    };
    const inspectedFileSnapshotIds = ["service", "client"];
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => candidate(area.key, id)),
      }],
      allowRepair: false,
    });

    expect(critique.domains[0]).toMatchObject({
      status: "covered",
      diversityGapDescriptions: [],
    });
  });

  it("keeps product tests in the quality area and does not spend a repair slot on a third test", () => {
    const dataModel = {
      key: "repository_area:data_model",
      label: "Data model and persistence",
      scopeKey: "example/catalog",
      salience: 100,
      files: [
        { id: "test-loader", path: "src/test/persistence/DataLoaderTest.java", score: 120 },
        { id: "test-model", path: "src/test/model/ProductDetailsTest.java", score: 110 },
        { id: "loader", path: "src/main/persistence/DataLoader.java", score: 90 },
        { id: "model", path: "src/main/model/ProductDetails.java", score: 80 },
      ],
    };
    const quality = {
      key: "repository_area:quality",
      label: "Quality and operations",
      scopeKey: "example/catalog",
      salience: 50,
      files: [
        ...dataModel.files.slice(0, 2),
        { id: "test-orders", path: "src/test/model/PurchaseOrdersTest.java", score: 100 },
      ],
    };
    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [dataModel, quality] });
    const dataPackage = plan.find((entry) => entry.capabilityKeys.includes(dataModel.key));
    const qualityPackage = plan.find((entry) => entry.capabilityKeys.includes(quality.key));

    expect(dataPackage?.fileSnapshotIds).toEqual(["loader", "model"]);
    expect(qualityPackage?.fileSnapshotIds).toHaveLength(2);
    expect(qualityPackage?.fileSnapshotIds.every((id) => id.startsWith("test-"))).toBe(true);
    expect(qualityPackage?.capabilityKeys).toEqual(["repository_area:quality"]);
    expect(semanticAuditTarget(quality)).toBe(2);
    expect(critiqueRepositoryCoverage({
      manifest: [quality],
      reports: [{
        inspectedFileSnapshotIds: qualityPackage!.fileSnapshotIds,
        candidates: [candidate(quality.key, qualityPackage!.fileSnapshotIds[0]!)],
      }],
      allowRepair: true,
    }).repairPackages).toEqual([]);
  });

  it("samples an interface and presentation instead of two parallel page wrappers", () => {
    const area = {
      key: "project_domain:messages",
      label: "Messages",
      scopeKey: "example/marketplace",
      salience: 120,
      files: [
        { id: "founder-page", path: "app/founder/messages/[id]/page.tsx", score: 100 },
        { id: "investor-page", path: "app/investor/messages/[id]/page.tsx", score: 90 },
        { id: "messages-api", path: "app/api/messages/[id]/route.ts", score: 80 },
        { id: "chat-view", path: "components/messages/ChatView.tsx", score: 70 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toContain("founder-page");
    expect(plan[0]?.fileSnapshotIds).toContain("messages-api");
    expect(plan[0]?.fileSnapshotIds).not.toContain("investor-page");
  });

  it("keeps collaboration membership distinct from generic request handlers", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/team-product",
      salience: 120,
      files: [
        { id: "upload", path: "app/api/upload/route.ts", score: 100 },
        { id: "invite", path: "app/api/teams/invitations/route.ts", score: 90 },
        { id: "account", path: "app/api/accounts/route.ts", score: 80 },
        { id: "dashboard", path: "app/dashboard/page.tsx", score: 70 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });
    expect(plan[0]?.fileSnapshotIds).toEqual(expect.arrayContaining(["upload", "invite"]));
    expect(plan[0]?.fileSnapshotIds).not.toContain("account");
  });

  it("normalizes API versions and dynamic parameters before sampling route families", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/http-service",
      salience: 120,
      files: [
        { id: "order-bracket", path: "app/api/v2/orders/[orderId]/route.ts", score: 100 },
        { id: "order-colon", path: "server/routes/v2/orders/:id/handler.ts", score: 99 },
        { id: "catalog", path: "app/api/v2/catalog/items/route.ts", score: 98 },
      ],
    };

    const plan = buildRepositoryDerivedSemanticPlan({ manifest: [area] });

    expect(plan[0]?.fileSnapshotIds).toEqual(expect.arrayContaining(["order-bracket", "catalog"]));
    expect(plan[0]?.fileSnapshotIds).not.toContain("order-colon");
  });

  it("uses a broad-area repair wave across versioned and nested API subdomains", () => {
    const area = {
      key: "repository_area:product_surface",
      label: "Product surface",
      scopeKey: "example/commerce-service",
      salience: 1_000,
      files: [
        { id: "catalog", path: "app/api/v2/catalog/items/route.ts", score: 100 },
        { id: "orders", path: "app/api/v2/orders/[orderId]/route.ts", score: 99 },
        { id: "billing", path: "app/api/v2/organizations/[id]/billing/invoices/route.ts", score: 98 },
        { id: "exports", path: "app/api/v2/exports/route.ts", score: 97 },
        { id: "subscriptions", path: "app/api/v2/subscriptions/route.ts", score: 96 },
        { id: "notifications", path: "app/api/v2/notifications/route.ts", score: 95 },
        { id: "payments", path: "app/api/v2/payments/route.ts", score: 94 },
        { id: "webhooks", path: "app/api/v2/webhooks/route.ts", score: 93 },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `catalog-helper-${index}`,
          path: `app/api/v2/catalog/helpers/${index}.ts`,
          score: 70 - index,
        })),
      ],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: ["catalog", "orders"],
        candidates: [
          {
            ...candidate(area.key, "catalog"),
            statement: "The catalog endpoint returns a versioned item collection.",
          },
          {
            ...candidate(area.key, "orders"),
            statement: "The order endpoint retrieves one order by its stable identifier.",
          },
        ],
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toMatchObject({
      targetSamples: 8,
      requiredSupportedCandidates: 8,
      supportedFileCount: 2,
      requiredSupportedFiles: 6,
      status: "thin",
    });
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "billing",
      "exports",
      "subscriptions",
      "notifications",
      "payments",
      "webhooks",
    ]);
  });

  it("reserves structural coverage and rejects IDE, raw-data, and repository-wrapper domains", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/InsightUBC",
      files: [
        mappedFile("idea-1", ".idea/codeStyles/Project.xml", 8),
        mappedFile("idea-2", ".idea/codeStyles/codeStyleConfig.xml", 8),
        mappedFile("query-1", "src/controller/QueryParser.ts", 5),
        mappedFile("query-2", "src/controller/QueryExecutor.ts", 5),
        mappedFile("front-1", "frontend/insightubc/src/App.js", 5),
        mappedFile("front-2", "frontend/insightubc/src/components/Insights.js", 5),
        mappedFile("service-1", "src/services/dataset-service.ts", 5),
        mappedFile("service-2", "src/services/query-service.ts", 5),
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual(expect.arrayContaining([
      "repository_area:product_surface",
      "repository_area:application_core",
    ]));
    expect(manifest.map((area) => area.key)).not.toEqual(expect.arrayContaining([
      "project_domain:insightubc",
      "project_domain:codestyles",
    ]));
    expect(manifest.flatMap((area) => area.files.map((file) => file.path)))
      .not.toEqual(expect.arrayContaining([
        ".idea/codeStyles/Project.xml",
        ".idea/codeStyles/codeStyleConfig.xml",
      ]));
  });

  it("maps presentation routes, not server endpoints, to the product surface", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/messaging-app",
      files: [
        mappedFile("api", "app/api/messages/send/route.ts"),
        mappedFile("page", "app/messages/page.tsx"),
        mappedFile("ui-route", "src/routes/Conversation.tsx"),
        mappedFile("server-route", "src/routes/messages.ts"),
      ],
    });

    const productSurface = manifest.find((area) =>
      area.key === "repository_area:product_surface"
    );
    expect(productSurface?.files.map((file) => file.path)).toEqual([
      "app/messages/page.tsx",
      "src/routes/Conversation.tsx",
    ]);
  });

  it("canonicalizes duplicate domain spellings and demotes structural folders", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/general-app",
      files: [
        mappedFile("circle-1", "src/components/circle/dashboard.tsx"),
        mappedFile("circle-2", "src/components/circle/contributions.tsx"),
        mappedFile("circles-1", "src/app/circles/list.tsx"),
        mappedFile("circles-2", "src/app/circles/detail.tsx"),
        mappedFile("email-a", "frontend/email_intake/src/conversation.ts"),
        mappedFile("email-b", "frontend/email_intake/src/revision.ts"),
        mappedFile("email-c", "src/email-intake/parse.ts"),
        mappedFile("email-d", "src/email-intake/respond.ts"),
        mappedFile("validation-1", "src/validations/auth.ts"),
        mappedFile("validation-2", "src/validations/circles.ts"),
      ],
    });

    expect(manifest.map((area) => area.key).filter((key) => key.startsWith("project_domain:")))
      .toEqual(expect.arrayContaining([
        "project_domain:circle",
        "project_domain:email-intake",
      ]));
    expect(manifest.map((area) => area.key)).not.toEqual(expect.arrayContaining([
      "project_domain:circles",
      "project_domain:email_intake",
      "project_domain:validations",
    ]));
  });

  it("maps a mixed Java/Python desktop repository without promoting raw data", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/Amazon-Marketplace-Analytic-Software",
      files: [
        mappedFile("raw-1", "data/productdetails.json", 8),
        mappedFile("raw-2", "data/purchaseorders.json", 8),
        mappedFile("model-1", "src/main/model/ProductDetails.java", 5),
        mappedFile("model-2", "src/main/model/PurchaseOrders.java", 5),
        mappedFile("ui-1", "src/main/ui/Main.java", 5),
        mappedFile("ui-2", "src/main/ui/ForecastPanel.java", 5),
        mappedFile("client", "src/main/service/ForecastClient.java", 5),
        mappedFile("ml-1", "ml_service/forecast_service.py", 5),
        mappedFile("ml-2", "ml_service/requirements.txt", 5),
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual(expect.arrayContaining([
      "repository_area:intelligence",
      "repository_area:data_model",
      "repository_area:product_surface",
      "repository_area:integrations",
    ]));
    expect(manifest.map((area) => area.key)).not.toContain("project_domain:data");
  });

  it("maps singular repository filenames into data-model coverage", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "owner/circle",
      files: [mappedFile("repository", "src/server/data/circle-repository.ts")],
    });

    expect(manifest.find((area) => area.key === "repository_area:data_model")
      ?.files.map((file) => file.id)).toContain("repository");
  });

  it("does not confuse repository product features with persistence repositories", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/repository-product",
      files: [
        mappedFile(
          "orchestrator",
          "src/services/repository-semantic-orchestrator-service.ts",
        ),
        mappedFile(
          "research-worker",
          "src/services/project-chat-repository-research-worker-service.ts",
        ),
        mappedFile(
          "lifecycle-ui",
          "components/work-items/repository-refresh-lifecycle-status.tsx",
        ),
        mappedFile("directory", "src/repositories/account-store.ts"),
        mappedFile("singular-directory", "src/repository/invoice-store.ts"),
        mappedFile("class-name", "src/runtime/ResearchRepository.ts"),
        mappedFile("kebab-name", "src/server/circle-repository.ts"),
      ],
    });
    const dataModelIds = manifest.find((area) =>
      area.key === "repository_area:data_model"
    )?.files.map((file) => file.id) ?? [];

    expect(dataModelIds).toEqual(expect.arrayContaining([
      "directory",
      "singular-directory",
      "class-name",
      "kebab-name",
    ]));
    expect(dataModelIds).not.toEqual(expect.arrayContaining([
      "orchestrator",
      "research-worker",
      "lifecycle-ui",
    ]));
  });

  it("retains generalized schema, migration, model, entity, db, dao, storage, and persistence paths", () => {
    const expectedIds = [
      "schema",
      "migration",
      "model",
      "entity",
      "db",
      "dao",
      "storage",
      "persistence",
    ];
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/persistence-layouts",
      files: [
        mappedFile("schema", "prisma/schema.prisma"),
        mappedFile("migration", "db/migrations/001-create-orders.sql"),
        mappedFile("model", "src/models/Order.ts"),
        mappedFile("entity", "src/entities/Account.java"),
        mappedFile("db", "lib/db/client.ts"),
        mappedFile("dao", "src/dao/InvoiceDao.kt"),
        mappedFile("storage", "src/storage/blob-store.go"),
        mappedFile("persistence", "src/persistence/payment-writer.py"),
      ],
    });

    expect(manifest.find((area) => area.key === "repository_area:data_model")
      ?.files.map((file) => file.id)).toEqual(expect.arrayContaining(expectedIds));
  });

  it("does not let broad repository-feature vocabulary inflate the data-model audit target", () => {
    const featureFiles = Array.from({ length: 36 }, (_, index) => mappedFile(
      `feature-${index}`,
      `src/services/repository-feature-${index}-service.ts`,
    ));
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/broad-repository-product",
      files: [
        ...featureFiles,
        mappedFile("schema", "prisma/schema.prisma"),
        mappedFile("product", "src/models/Product.java"),
        mappedFile("orders", "src/models/PurchaseOrders.java"),
        mappedFile("order-repository", "src/repositories/OrderRepository.java"),
      ],
    });
    const dataModel = manifest.find((area) =>
      area.key === "repository_area:data_model"
    );

    expect(dataModel?.files.map((file) => file.id).sort()).toEqual([
      "order-repository",
      "orders",
      "product",
      "schema",
    ]);
    expect(semanticAuditTarget(dataModel!)).toBeLessThanOrEqual(6);
  });

  it("bounds migration-heavy data-model depth by current entity diversity", () => {
    const currentEntities = [
      "Account",
      "Invoice",
      "Payment",
      "Product",
      "PurchaseOrder",
      "Shipment",
    ];
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/mature-persistence",
      files: [
        ...Array.from({ length: 36 }, (_, index) => mappedFile(
          `migration-${index}`,
          `db/migrations/${String(index + 1).padStart(3, "0")}-change.sql`,
        )),
        ...currentEntities.map((entity) => mappedFile(
          entity.toLowerCase(),
          `src/models/${entity}.java`,
        )),
      ],
    });
    const dataModel = manifest.find((area) =>
      area.key === "repository_area:data_model"
    );

    expect(dataModel?.files).toHaveLength(42);
    expect(semanticAuditTarget(dataModel!)).toBe(6);
  });

  it("keeps a flat source tree researchable without inventing filename domains", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/flat-service",
      files: [
        mappedFile("server", "src/server.ts"),
        mappedFile("users", "src/users.ts"),
      ],
    });

    expect(manifest).toEqual([
      expect.objectContaining({
        key: "repository_area:application_core",
        files: [
          expect.objectContaining({ id: "server" }),
          expect.objectContaining({ id: "users" }),
        ],
      }),
    ]);
  });

  it("discovers a flat product domain only when executable filenames corroborate its subject", () => {
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/flat-runtime",
      files: [
        mappedFile("knowledge-refresh", "src/services/knowledge-refresh-service.ts"),
        mappedFile("knowledge-review", "src/services/knowledge-review-service.ts"),
        mappedFile("knowledge-reconcile", "src/services/knowledge-reconciliation-service.ts"),
        mappedFile("chat-agent", "src/services/project-chat-agent-service.ts"),
        mappedFile("chat-store", "src/services/project-chat-store.ts"),
        mappedFile("artifact-generation", "src/services/artifact-generation-service.ts"),
        mappedFile("artifact-workflow", "src/services/artifact-workflow-service.ts"),
        mappedFile("migration-a", "db/migrations/001/migration.sql"),
        mappedFile("migration-b", "db/migrations/002/migration.sql"),
        mappedFile("singleton", "src/services/billing-service.ts"),
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual(expect.arrayContaining([
      "project_domain:knowledge",
      "project_domain:chat",
      "project_domain:artifact",
    ]));
    expect(manifest.find((area) => area.key === "project_domain:knowledge")
      ?.files.map((file) => file.id)).toEqual([
      "knowledge-reconcile",
      "knowledge-refresh",
      "knowledge-review",
    ]);
    expect(manifest.some((area) => area.key === "project_domain:billing"))
      .toBe(false);
    expect(manifest.some((area) => area.key === "project_domain:migration"))
      .toBe(false);
  });

  it("does not treat roadmap documentation as implementation evidence and requests one repair wave", () => {
    const manifest = [{
      key: "project_domain:funding",
      label: "Funding",
      scopeKey: "example/fund",
      salience: 80,
      files: [
        { id: "readme", path: "README.md", score: 50 },
        { id: "contribution", path: "src/features/funding/contribution-service.ts", score: 40 },
        { id: "repayment", path: "src/features/funding/repayment-service.ts", score: 30 },
        { id: "review", path: "src/features/funding/review-service.ts", score: 20 },
      ],
    }];
    const firstPass = [{
      inspectedFileSnapshotIds: ["readme"],
      candidates: [candidate("project_domain:funding", "readme")],
    }];
    const critique = critiqueRepositoryCoverage({ manifest, reports: firstPass, allowRepair: true });

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      status: "missing",
      supportedCandidates: 0,
    }));
    expect(critique.repairPackages).toHaveLength(1);
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(["contribution", "repayment"]);

    const finalCritique = critiqueRepositoryCoverage({
      manifest,
      reports: [...firstPass, {
        inspectedFileSnapshotIds: ["contribution", "repayment"],
        candidates: [candidate("project_domain:funding", "contribution")],
      }],
      allowRepair: false,
    });
    expect(finalCritique.domains[0]?.status).toBe("covered");
    expect(finalCritique.repairPackages).toEqual([]);
  });

  it("does not spend repair capacity on context-only files", () => {
    const critique = critiqueRepositoryCoverage({
      manifest: [{
        key: "project_domain:funding",
        label: "Funding",
        scopeKey: "example/docs-only",
        files: [{ id: "roadmap", path: "README.md", score: 50 }],
      }],
      reports: [],
      allowRepair: true,
    });

    expect(critique.domains[0]?.status).toBe("missing");
    expect(critique.repairPackages).toEqual([]);
  });

  it("retries the strongest inspected implementation once when mapped evidence produced no finding", () => {
    const area = {
      key: "project_domain:documents",
      label: "Documents",
      scopeKey: "example/document-system",
      files: [
        { id: "lower", path: "src/documents/reader.ts", score: 40 },
        { id: "highest", path: "src/documents/processor.ts", score: 90 },
      ],
    };
    const firstPass = [{
      inspectedFileSnapshotIds: ["lower", "highest"],
      candidates: [],
    }];

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: firstPass,
      allowRepair: true,
      allowEvidenceEmptyRetry: true,
    });

    expect(critique.repairPackages).toHaveLength(1);
    expect(critique.repairPackages[0]).toEqual(expect.objectContaining({
      capabilityKeys: [area.key],
      fileSnapshotIds: ["highest"],
      singletonFileSnapshotIds: ["highest"],
      retryFileSnapshotIds: ["highest"],
    }));

    const afterFocusedRetry = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [...firstPass, {
        inspectedFileSnapshotIds: ["highest"],
        candidates: [],
      }],
      allowRepair: true,
    });
    expect(afterFocusedRetry.repairPackages).toEqual([]);
  });

  it("broadens to uninspected evidence before retrying an evidence-empty capability", () => {
    const area = {
      key: "project_domain:documents",
      label: "Documents",
      scopeKey: "example/document-system",
      files: [
        { id: "inspected", path: "src/documents/reader.ts", score: 90 },
        { id: "uninspected", path: "src/documents/processor.ts", score: 80 },
      ],
    };

    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: ["inspected"],
        candidates: [],
      }],
      allowRepair: true,
      allowEvidenceEmptyRetry: true,
    });

    expect(critique.repairPackages).toHaveLength(1);
    expect(critique.repairPackages[0]).toEqual(expect.objectContaining({
      capabilityKeys: [area.key],
      fileSnapshotIds: ["uninspected"],
    }));
    expect(critique.repairPackages[0]?.retryFileSnapshotIds).toBeUndefined();
  });

  it("retries an exact degraded model-selected file even after its domain is covered", () => {
    const area = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/commerce",
      salience: 80,
      files: [
        { id: "orders-menu", path: "src/orders/menu.ts", score: 30 },
        { id: "orders-service", path: "src/orders/service.ts", score: 20 },
        { id: "orders-alternative", path: "src/orders/alternative.ts", score: 10 },
      ],
    };
    const reports = [{
      inspectedFileSnapshotIds: ["orders-menu", "orders-service"],
      retryFileSnapshotIds: ["orders-menu"],
      singletonRetryFileSnapshotIds: ["orders-menu"],
      candidates: [
        candidate(area.key, "orders-service"),
      ],
    }];

    const critique = critiqueRepositoryCoverage({ manifest: [area], reports, allowRepair: true });

    expect(critique.domains[0]?.status).toBe("covered");
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual([
      "orders-menu",
    ]);
    expect(critique.repairPackages[0]?.singletonFileSnapshotIds).toEqual([
      "orders-menu",
    ]);
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds))
      .not.toContain("orders-alternative");

    const sealed = critiqueRepositoryCoverage({
      manifest: [area],
      reports,
      allowRepair: false,
    });
    expect(sealed.domains[0]?.status).toBe("covered");
    expect(sealed.repairPackages).toEqual([]);

    const successful = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{ ...reports[0], retryFileSnapshotIds: [] }],
      allowRepair: true,
    });
    expect(successful.repairPackages).toEqual([]);
  });

  it("repairs an evidence-floor deficit before higher-salience sample-only debt", () => {
    const knowledge = {
      key: "project_domain:knowledge",
      label: "Knowledge",
      scopeKey: "example/general-project",
      salience: 10,
      files: Array.from({ length: 17 }, (_, index) => ({
        id: `knowledge-${index}`,
        path: `src/knowledge/operation-${index}.ts`,
        score: 30 - index,
        operationSignalKeys: [`static-operation:topic:knowledge-${index}`],
      })),
    };
    const chat = {
      key: "project_domain:chat",
      label: "Chat",
      scopeKey: "example/general-project",
      salience: 100,
      files: Array.from({ length: 7 }, (_, index) => ({
        id: `chat-${index}`,
        path: `src/chat/operation-${index}.ts`,
        score: 20 - index,
      })),
    };
    const uniqueCandidate = (key: string, fileSnapshotId: string) => ({
      ...candidate(key, fileSnapshotId),
      statement: `${fileSnapshotId} implements a distinct supported operation.`,
    });
    const reports = [{
      inspectedFileSnapshotIds: [
        ...knowledge.files.slice(0, 8).map((file) => file.id),
        ...chat.files.slice(0, 2).map((file) => file.id),
      ],
      candidates: [
        ...knowledge.files.slice(0, 5).map((file) =>
          uniqueCandidate(knowledge.key, file.id)
        ),
        ...chat.files.slice(0, 2).map((file) =>
          uniqueCandidate(chat.key, file.id)
        ),
      ],
    }];

    const critique = critiqueRepositoryCoverage({
      manifest: [chat, knowledge],
      reports,
      allowRepair: true,
    });

    expect(critique.domains.find((domain) => domain.key === knowledge.key))
      .toMatchObject({ supportedFileCount: 5, requiredSupportedFiles: 6 });
    expect(critique.domains.find((domain) => domain.key === chat.key))
      .toMatchObject({ supportedFileCount: 2, requiredSupportedFiles: 1 });
    expect(critique.repairPackages[0]?.fileSnapshotIds[0])
      .toMatch(/^knowledge-/);
  });

  it("retries a request-wide four-file failure as one bounded micro-batch", () => {
    const area = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/batch-retry",
      salience: 80,
      files: Array.from({ length: 4 }, (_, index) => ({
        id: `orders-${index}`,
        path: `src/orders/workflow-${index}.ts`,
        score: 20 - index,
      })),
    };
    const retryFileSnapshotIds = area.files.map((file) => file.id);
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: retryFileSnapshotIds,
        retryFileSnapshotIds,
        candidates: area.files.map((file, index) => ({
          ...candidate(area.key, file.id),
          statement: `The implementation supports order workflow ${index + 1}.`,
        })),
      }],
      allowRepair: true,
    });

    expect(critique.repairPackages).toHaveLength(1);
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(
      retryFileSnapshotIds,
    );
    expect(critique.repairPackages[0]?.retryFileSnapshotIds).toEqual(
      retryFileSnapshotIds,
    );
    expect(critique.repairPackages[0]?.singletonFileSnapshotIds ?? []).toEqual([]);
    expect(semanticWorkPackageModelCallCount(critique.repairPackages[0]!))
      .toBe(1);
  });

  it("caps new repair breadth against every assigned semantic file", () => {
    const retryArea = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/assigned-cap",
      salience: 100,
      files: [
        { id: "retry-a", path: "src/orders/create.ts", score: 20 },
        { id: "retry-b", path: "src/orders/update.ts", score: 19 },
      ],
    };
    const missingAreas = Array.from({ length: 4 }, (_, index) => ({
      key: `project_domain:missing-${index}`,
      label: `Missing ${index}`,
      scopeKey: "example/assigned-cap",
      salience: 90 - index,
      files: [{
        id: `new-${index}`,
        path: `src/missing-${index}/service.ts`,
        score: 10,
      }],
    }));
    const selectedFileSnapshotIds = [
      "retry-a",
      "retry-b",
      ...Array.from({ length: 26 }, (_, index) => `assigned-${index}`),
    ];
    const critique = critiqueRepositoryCoverage({
      manifest: [retryArea, ...missingAreas],
      reports: [{
        inspectedFileSnapshotIds: ["retry-a", "retry-b"],
        retryFileSnapshotIds: ["retry-a", "retry-b"],
        candidates: [candidate(retryArea.key, "retry-a")],
      }],
      allowRepair: true,
      selectedFileSnapshotIds,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    );

    expect(repairedIds).toHaveLength(6);
    expect(repairedIds).toEqual(expect.arrayContaining([
      "retry-a",
      "retry-b",
      "new-0",
      "new-1",
      "new-2",
      "new-3",
    ]));
    expect(new Set([...selectedFileSnapshotIds, ...repairedIds]).size).toBe(32);
  });

  it("allows an exact retry at the semantic-file ceiling without adding breadth", () => {
    const retryArea = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/full-cap",
      salience: 100,
      files: [{
        id: "retry-selected",
        path: "src/orders/service.ts",
        score: 20,
      }],
    };
    const missingArea = {
      key: "project_domain:payments",
      label: "Payments",
      scopeKey: "example/full-cap",
      salience: 90,
      files: [{
        id: "new-payment",
        path: "src/payments/service.ts",
        score: 20,
      }],
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [retryArea, missingArea],
      reports: [{
        inspectedFileSnapshotIds: [],
        retryFileSnapshotIds: ["retry-selected"],
        candidates: [],
      }],
      allowRepair: true,
      selectedFileSnapshotIds: [
        "retry-selected",
        ...Array.from({ length: 39 }, (_, index) => `assigned-${index}`),
      ],
    });

    expect(critique.repairPackages.flatMap((entry) =>
      entry.fileSnapshotIds
    )).toEqual(["retry-selected"]);
  });

  it("prioritizes exact model retries before generic breadth under the repair ceiling", () => {
    const retryArea = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/large",
      salience: 1,
      files: [
        { id: "degraded-orders", path: "src/orders/menu.ts", score: 1 },
        { id: "covered-orders", path: "src/orders/service.ts", score: 2 },
      ],
    };
    const uncoveredAreas = Array.from({ length: 6 }, (_, index) => ({
      key: `project_domain:uncovered-${index}`,
      label: `Uncovered ${index}`,
      scopeKey: "example/large",
      salience: 100 - index,
      files: [{
        id: `uncovered-${index}`,
        path: `src/uncovered-${index}/service.ts`,
        score: 20 - index,
      }],
    }));
    const critique = critiqueRepositoryCoverage({
      manifest: [retryArea, ...uncoveredAreas],
      reports: [{
        inspectedFileSnapshotIds: ["degraded-orders", "covered-orders"],
        retryFileSnapshotIds: ["degraded-orders"],
        candidates: [candidate(retryArea.key, "covered-orders")],
      }],
      allowRepair: true,
    });
    const selected = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(selected).toHaveLength(7);
    expect(selected[0]).toBe("degraded-orders");
    expect(new Set(selected.filter((id) => id.startsWith("uncovered-"))).size).toBe(6);
  });

  it("does not count an exact retry as a new semantic breadth sample", () => {
    const area = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/broad-orders",
      salience: 80,
      files: Array.from({ length: 8 }, (_, index) => ({
        id: `orders-${index}`,
        path: `src/orders/workflow-${index}.ts`,
        score: 20 - index,
      })),
    };
    const critique = critiqueRepositoryCoverage({
      manifest: [area],
      reports: [{
        inspectedFileSnapshotIds: ["orders-0", "orders-1"],
        retryFileSnapshotIds: ["orders-0"],
        singletonRetryFileSnapshotIds: ["orders-0"],
        candidates: [{
          ...candidate(area.key, "orders-1"),
          statement: "The service implements the currently supported order workflow.",
        }],
      }],
      allowRepair: true,
    });
    const selected = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(critique.domains[0]).toEqual(expect.objectContaining({
      status: "thin",
      inspectedSamples: 2,
      targetSamples: 3,
    }));
    expect(selected).toContain("orders-0");
    expect(selected.some((id) => id !== "orders-0" && id !== "orders-1")).toBe(true);
    expect(critique.repairPackages.flatMap((entry) => entry.singletonFileSnapshotIds ?? []))
      .toEqual(["orders-0"]);
  });

  it("does count an exact pre-inspection failure as the new sample it becomes", () => {
    const retryArea = {
      key: "project_domain:orders",
      label: "Orders",
      scopeKey: "example/pre-inspection-failure",
      salience: 1,
      files: [
        { id: "orders-seen", path: "src/orders/seen.ts", score: 30 },
        { id: "orders-retry", path: "src/orders/retry.ts", score: 20 },
        { id: "orders-alternative", path: "src/orders/alternative.ts", score: 10 },
      ],
    };
    const missingAreas = Array.from({ length: 5 }, (_, index) => ({
      key: `project_domain:missing-${index}`,
      label: `Missing ${index}`,
      scopeKey: "example/pre-inspection-failure",
      salience: 100 - index,
      files: [{
        id: `missing-${index}`,
        path: `src/missing-${index}/service.ts`,
        score: 10,
      }],
    }));
    const critique = critiqueRepositoryCoverage({
      manifest: [retryArea, ...missingAreas],
      reports: [{
        inspectedFileSnapshotIds: ["orders-seen"],
        retryFileSnapshotIds: ["orders-retry"],
        candidates: [candidate(retryArea.key, "orders-seen")],
      }],
      allowRepair: true,
    });
    const selected = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(selected).toHaveLength(6);
    expect(selected).toContain("orders-retry");
    expect(selected).not.toContain("orders-alternative");
    expect(missingAreas.every((area) => selected.includes(area.files[0]!.id))).toBe(true);
  });

  it("shares two bounded repair batches across unresolved domains", () => {
    const manifest = Array.from({ length: 6 }, (_, index) => ({
      key: `project_domain:domain-${index}`,
      label: `Domain ${index}`,
      scopeKey: "example/large",
      salience: 100 - index,
      files: [
        { id: `domain-${index}-a`, path: `src/domain-${index}/a.ts`, score: 10 },
        { id: `domain-${index}-b`, path: `src/domain-${index}/b.ts`, score: 9 },
      ],
    }));

    const critique = critiqueRepositoryCoverage({ manifest, reports: [], allowRepair: true });
    expect(critique.repairPackages).toHaveLength(2);
    expect(new Set(critique.repairPackages.flatMap((entry) => entry.capabilityKeys))).toEqual(
      new Set(Array.from({ length: 6 }, (_, index) => `project_domain:domain-${index}`)),
    );
    expect(critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds)).toEqual(
      expect.arrayContaining(Array.from({ length: 6 }, (_, index) => `domain-${index}-a`)),
    );
  });

  it("reuses an overlapping repair file before spending a second global slot", () => {
    const shared = { id: "shared", path: "src/shared/workflow.ts", score: 10 };
    const overlapArea = {
      key: "project_domain:overlap",
      label: "Overlap",
      scopeKey: "example/repair-overlap",
      salience: 90,
      files: [
        { id: "overlap-inspected", path: "src/overlap/current.ts", score: 12 },
        { id: "overlap-alternative", path: "src/overlap/alternative.ts", score: 11 },
        shared,
      ],
    };
    const manifest = [
      {
        key: "project_domain:primary",
        label: "Primary",
        scopeKey: "example/repair-overlap",
        salience: 100,
        files: [shared],
      },
      overlapArea,
      ...Array.from({ length: 5 }, (_, index) => ({
        key: `project_domain:tail-${index}`,
        label: `Tail ${index}`,
        scopeKey: "example/repair-overlap",
        salience: 80 - index,
        files: [{ id: `tail-${index}`, path: `src/tail-${index}/workflow.ts`, score: 10 }],
      })),
    ];
    const critique = critiqueRepositoryCoverage({
      manifest,
      reports: [{
        inspectedFileSnapshotIds: ["overlap-inspected"],
        candidates: [candidate(overlapArea.key, "overlap-inspected")],
      }],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);
    const repairedKeys = new Set(critique.repairPackages.flatMap((entry) => entry.capabilityKeys));

    expect(repairedIds).toHaveLength(6);
    expect(repairedIds).toContain("shared");
    expect(repairedIds).not.toContain("overlap-alternative");
    expect(repairedKeys).toEqual(new Set(manifest.map((area) => area.key)));
  });

  it("credits an overlapping repair file only once per area", () => {
    const shared = { id: "shared", path: "src/shared/workflow.ts", score: 100 };
    const area = (key: string, prefix: string) => ({
      key: `project_domain:${key}`,
      label: key,
      scopeKey: "example/shared-depth",
      salience: 100,
      files: [
        shared,
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `${prefix}-${index}`,
          path: `src/${prefix}/workflow-${index}.ts`,
          score: 90 - index,
        })),
      ],
    });
    const critique = critiqueRepositoryCoverage({
      manifest: [area("alpha", "a"), area("beta", "b")],
      reports: [],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(repairedIds).toHaveLength(5);
    expect(repairedIds).toEqual(expect.arrayContaining([
      "shared",
      "a-0",
      "a-1",
      "b-0",
      "b-1",
    ]));
  });

  it("does not let generic overlap consume an exact diversity repair", () => {
    const shared = { id: "shared-java-ui", path: "src/main/ui/SharedForecast.java", score: 120 };
    const intelligence = {
      key: "repository_area:intelligence",
      label: "Search, retrieval, and model intelligence",
      scopeKey: "example/overlap-runtime",
      salience: 90,
      files: [
        shared,
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `inspected-java-${index}`,
          path: `src/main/ui/ForecastPanel${index}.java`,
          score: 110 - index,
        })),
        { id: "python-runtime", path: "ml_service/forecast_service.py", score: 50 },
      ],
    };
    const inspectedFileSnapshotIds = intelligence.files.slice(1, 5).map((file) => file.id);
    const critique = critiqueRepositoryCoverage({
      manifest: [{
        key: "project_domain:shared",
        label: "Shared",
        scopeKey: "example/overlap-runtime",
        salience: 100,
        files: [shared],
      }, intelligence],
      reports: [{
        inspectedFileSnapshotIds,
        candidates: inspectedFileSnapshotIds.map((id) => ({
          ...candidate(intelligence.key, id),
          statement: `${id} supports a distinct forecast presentation behavior.`,
        })),
      }],
      allowRepair: true,
    });
    const repairedIds = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(repairedIds).toContain("python-runtime");
    expect(repairedIds).toContain("shared-java-ui");
  });

  it("does not starve later broad areas when repair depth exceeds the global cap", () => {
    const manifest = Array.from({ length: 3 }, (_, areaIndex) => ({
      key: `project_domain:area-${areaIndex}`,
      label: `Area ${areaIndex}`,
      scopeKey: "example/multi-surface",
      salience: 100 - areaIndex,
      files: Array.from({ length: 31 }, (_unused, fileIndex) => ({
        id: `area-${areaIndex}-${fileIndex}`,
        path: `src/area-${areaIndex}/file-${fileIndex}.ts`,
        score: 31 - fileIndex,
      })),
    }));

    const critique = critiqueRepositoryCoverage({ manifest, reports: [], allowRepair: true });
    const selected = critique.repairPackages.flatMap((entry) => entry.fileSnapshotIds);

    expect(selected).toHaveLength(8);
    for (let areaIndex = 0; areaIndex < 3; areaIndex += 1) {
      expect(selected.some((fileId) => fileId.startsWith(`area-${areaIndex}-`))).toBe(true);
    }
  });

  it("accepts test evidence for quality coverage without treating tests as product implementation", () => {
    const manifest = [{
      key: "repository_area:quality",
      label: "Quality and operations",
      scopeKey: "example/service",
      salience: 30,
      files: [
        { id: "test-a", path: "tests/auth.test.ts", score: 10 },
        { id: "test-b", path: "tests/orders.test.ts", score: 9 },
        { id: "test-c", path: "tests/payments.test.ts", score: 8 },
      ],
    }];
    const critique = critiqueRepositoryCoverage({
      manifest,
      reports: [{
        inspectedFileSnapshotIds: ["test-a", "test-b"],
        candidates: [candidate("repository_area:quality", "test-a")],
      }],
      allowRepair: true,
    });

    expect(critique.domains[0]).toEqual(expect.objectContaining({ status: "covered" }));
    expect(critique.repairPackages).toEqual([]);
  });

  it("keeps identical domain keys isolated across attached repositories", () => {
    const manifest = ["owner/repo-a", "owner/repo-b"].map((scopeKey, index) => ({
      key: "project_domain:payments",
      label: "Payments",
      scopeKey,
      salience: 50,
      files: [
        { id: `payments-${index}-a`, path: "src/payments/charge.ts", score: 20 },
        { id: `payments-${index}-b`, path: "src/payments/ledger.ts", score: 10 },
      ],
    }));
    const critique = critiqueRepositoryCoverage({
      manifest,
      reports: [{
        inspectedFileSnapshotIds: ["payments-0-a", "payments-0-b"],
        candidates: [candidate("project_domain:payments", "payments-0-a")],
      }],
      allowRepair: true,
    });

    expect(critique.domains).toEqual([
      expect.objectContaining({ scopeKey: "owner/repo-a", status: "covered" }),
      expect.objectContaining({ scopeKey: "owner/repo-b", status: "missing" }),
    ]);
    expect(critique.gaps).toEqual([
      expect.stringContaining("owner/repo-b"),
    ]);
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(["payments-1-a", "payments-1-b"]);
  });
});
