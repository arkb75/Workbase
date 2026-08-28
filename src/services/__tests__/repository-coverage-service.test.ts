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
  inferRepositoryCapabilities,
  inferSubsystemsFromPath,
  isPlannedDocumentationRange,
  isRepositoryAnalysisNoisePath,
  isRepositoryProductPath,
  requiredSemanticRepresentativeCount,
  selectRequiredSemanticCoverageAreas,
  selectSemanticWindows,
} from "@/src/services/repository-coverage-service";

describe("adaptive repository coverage", () => {
  const coverageArea = (key: string, observationCount = 12) => ({
    key,
    label: key,
    status: "static_mapped" as const,
    paths: [`src/${key}/index.ts`],
    observationCount,
    staticPathCount: 1,
    eligibleSemanticPathCount: 1,
    semanticPathCount: 0,
    requiredSemanticPathCount: 1,
    semanticCoverageRatio: 0,
    modelSemanticPathCount: 0,
    deterministicFallbackPathCount: 0,
    unresolvedQuestions: [],
  });

  it("uses a repository-neutral architectural ontology", () => {
    expect(BASE_COVERAGE_TARGETS.map((target) => target.key)).toEqual([
      "product_surface",
      "domain_data",
      "application_logic",
      "interfaces_integrations",
      "automation_workflows",
      "intelligence_search",
      "security_reliability",
      "tests_operations",
    ]);
  });

  it("derives project domains across TypeScript and Java package layouts", () => {
    expect(inferProjectDomainCapability("src/payments/charge-service.ts")).toBe("project_domain:payments");
    expect(inferProjectDomainCapability("app/api/search/route.ts")).toBe("project_domain:search");
    expect(inferProjectDomainCapability("packages/billing/src/index.ts")).toBe("project_domain:billing");
    expect(inferProjectDomainCapability("src/main/java/com/acme/orders/OrderService.java"))
      .toBe("project_domain:orders");
  });

  it("strips structural folders and leading namespaces from project domains", () => {
    expect(inferProjectDomainCapability("src/backend/rest/orders/OrderController.java"))
      .toBe("project_domain:orders");
    expect(inferProjectDomainCapability("src/acme/orders/calculator.py"))
      .toBe("project_domain:orders");
    expect(inferProjectDomainCapability("src/frontend/components/Checkout.tsx")).toBeNull();
    expect(inferProjectDomainCapability("src/data/validations/order.ts")).toBeNull();
    expect(inferProjectDomainCapability("src/agents/planner.ts")).toBeNull();
    expect(inferProjectDomainCapability("src/providers/storage/client.ts")).toBeNull();
  });

  it("filters generated, tool, fixture, and test-resource paths from product domains and modules", () => {
    for (const path of [
      ".playwright-cli/session/report.json",
      ".workflow-data/cache/result.ts",
      ".nyc_output/processinfo/index.json",
      "src/test/resources/fixtures/loan.json",
      "target/generated-sources/client/Api.java",
    ]) {
      expect(isRepositoryAnalysisNoisePath(path)).toBe(true);
      expect(isRepositoryProductPath(path)).toBe(false);
      expect(inferSubsystemsFromPath(path)).toEqual([]);
      expect(inferRepositoryCapabilities({ path, content: "function model() { return fetch('/api'); }" }))
        .toEqual([]);
    }
  });

  it("does not treat ordinary model or API names as an AI runtime", () => {
    expect(inferSubsystemsFromPath("src/main/java/com/acme/loans/model/Loan.java"))
      .not.toContain("intelligence_search");
    expect(inferSubsystemsFromPath("src/api/payments/route.ts")).toContain("interfaces_integrations");
    expect(inferSubsystemsFromPath("src/api/payments/route.ts")).not.toContain("intelligence_search");
    expect(inferSubsystemsFromPath("src/ml/recommendations/ranker.py")).toContain("intelligence_search");
  });

  it("adds broad content-backed roles without vendor or framework contracts", () => {
    expect(inferRepositoryCapabilities({
      path: "lib/gateway.ts",
      content: "export async function send() { return fetch(remoteUrl); }",
    })).toContain("interfaces_integrations");
    expect(inferRepositoryCapabilities({
      path: "internal/guard.go",
      content: "func validatePermission(token string) bool { return authorize(token) }",
    })).toContain("security_reliability");
    expect(inferRepositoryCapabilities({
      path: "jobs/train.py",
      content: "def run(): return embedding_ranker.inference()",
    })).toEqual(expect.arrayContaining(["automation_workflows", "intelligence_search"]));
  });

  it("does not create mandatory roles from bare retry, prompt, completion, or validation vocabulary", () => {
    const inferred = inferRepositoryCapabilities({
      path: "src/common/helpers.ts",
      content: [
        "const retry = options.retry;",
        "const prompt = form.prompt;",
        "onCompletion(callback);",
        "validate(value);",
      ].join("\n"),
    });
    expect(inferred).not.toContain("automation_workflows");
    expect(inferred).not.toContain("intelligence_search");
    expect(inferred).not.toContain("security_reliability");

    expect(inferRepositoryCapabilities({
      path: "src/common/worker.ts",
      content: "const maxRetries = 3; const timeoutMs = 5000; abort();",
    })).toContain("automation_workflows");
    expect(inferRepositoryCapabilities({
      path: "src/common/generator.ts",
      content: "return generateStructured(schema);",
    })).toContain("intelligence_search");
    expect(inferRepositoryCapabilities({
      path: "src/common/guard.ts",
      content: "return validatePermission(token) && authorize(user);",
    })).toContain("security_reliability");
  });

  it("extracts Java, Python, and Go definitions and imports for representative scoring", async () => {
    const analyses = await analyzeRepositoryFiles([
      {
        repository: "example/orders",
        commitSha: "a".repeat(40),
        path: "src/main/java/com/acme/orders/OrderCalculator.java",
        content: [
          "package com.acme.orders;",
          "import com.acme.pricing.PricePolicy;",
          "public final class OrderCalculator {}",
        ].join("\n"),
      },
      {
        repository: "example/orders",
        commitSha: "a".repeat(40),
        path: "src/acme/orders/calculator.py",
        content: [
          "from pricing.policy import PricePolicy",
          "class OrderCalculator:",
          "    def calculate(self): return True",
        ].join("\n"),
      },
      {
        repository: "example/orders",
        commitSha: "a".repeat(40),
        path: "internal/orders/calculator.go",
        content: [
          "package orders",
          "import (",
          '  "example.com/project/pricing"',
          ")",
          "type OrderCalculator struct{}",
          "func (c *OrderCalculator) Calculate() bool { return true }",
        ].join("\n"),
      },
    ]);

    expect(analyses[0]).toMatchObject({
      symbols: ["OrderCalculator"],
      dependencies: ["com/acme/pricing/PricePolicy"],
    });
    expect(analyses[1]?.symbols).toEqual(expect.arrayContaining(["OrderCalculator", "calculate"]));
    expect(analyses[1]?.dependencies).toContain("pricing/policy");
    expect(analyses[2]?.symbols).toEqual(expect.arrayContaining(["OrderCalculator", "Calculate"]));
    expect(analyses[2]?.dependencies).toContain("example.com/project/pricing");
  });

  it("recognizes planned documentation ranges and not implemented sections", () => {
    const content = [
      "1: # CircleFund",
      "2: ## Implemented",
      "3: Contributions are recorded.",
      "4: ## Future roadmap",
      "5: Add loan repayment models.",
    ].join("\n");
    expect(isPlannedDocumentationRange({
      path: "README.md",
      numberedContent: content,
      lineStart: 3,
      lineEnd: 3,
    })).toBe(false);
    expect(isPlannedDocumentationRange({
      path: "README.md",
      numberedContent: content,
      lineStart: 5,
      lineEnd: 5,
    })).toBe(true);
  });

  it("keeps planned README bullets out of static implementation facts", async () => {
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "example/circle-fund",
      commitSha: "a".repeat(40),
      path: "README.md",
      content: [
        "# Circle Fund",
        "Contributions are persisted for each circle member.",
        "## Future",
        "- Loan approval and repayment models",
      ].join("\n"),
    }]);
    expect(analysis.facts.some((fact) => /Contributions are persisted/.test(fact.statement))).toBe(true);
    expect(analysis.facts.some((fact) => /Loan approval/.test(fact.statement))).toBe(false);
    expect(analysis.unresolvedQuestions).toContain("README.md:4 describes planned rather than implemented scope.");
  });

  it("does not let a large README inflate executable representative quotas", async () => {
    const [readme, screen] = await analyzeRepositoryFiles([
      {
        repository: "example/catalog",
        commitSha: "b".repeat(40),
        path: "README.md",
        content: Array.from({ length: 40 }, (_, index) => `Documented capability ${index}.`).join("\n"),
      },
      {
        repository: "example/catalog",
        commitSha: "b".repeat(40),
        path: "src/screens/checkout-screen.tsx",
        content: "export function CheckoutScreen() { return <main>Checkout</main>; }",
      },
    ]);
    const productSurface = buildCoverageMatrix([
      { path: "README.md", analysis: readme! },
      { path: "src/screens/checkout-screen.tsx", analysis: screen! },
    ]).find((area) => area.key === "product_surface");
    expect(productSurface).toMatchObject({
      staticPathCount: 2,
      eligibleSemanticPathCount: 1,
      requiredSemanticPathCount: 1,
    });
  });

  it("does not promote documentation-only semantic claims", async () => {
    const analysis = await analyzeRepositoryFile({
      repository: "example/catalog",
      commitSha: "b".repeat(40),
      path: "README.md",
      content: "# Catalog\nThe API supports checkout and refunds.",
      task: {
        objective: "Determine the shipped product surface.",
        capabilityKeys: ["product_surface"],
        questions: [],
        expectedOutputs: ["Executable implementation evidence"],
      },
    });
    expect(analysis.semanticStatus).toBe("degraded");
    expect(analysis.facts).toEqual([]);
    expect(analysis.unresolvedQuestions.join(" ")).toMatch(/planning context|implementation evidence/i);
  });

  it("calibrates semantic verification to repository area size", () => {
    expect([0, 1, 3, 4, 12, 13, 100].map(requiredSemanticRepresentativeCount))
      .toEqual([0, 1, 1, 2, 2, 3, 3]);
    const makeAnalysis = (path: string, semantic: boolean) => ({
      path,
      summary: path,
      subsystemKeys: ["application_logic"],
      responsibilities: ["Implements a service."],
      symbols: ["Service"],
      dependencies: [],
      architectureSignals: [],
      userFacingCapabilities: [],
      facts: [{
        statement: `${path} implements a service boundary.`,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        lineStart: 1,
        lineEnd: 2,
        productImportance: 3,
        implementationBreadth: 3,
        technicalDifficulty: 2,
        subsystemKeys: ["application_logic"],
        evidenceMode: semantic ? "semantic" as const : "static" as const,
        path,
      }],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
      analysisMode: semantic ? "semantic" as const : "static" as const,
      semanticStatus: semantic ? "succeeded" as const : "not_selected" as const,
      semanticSource: semantic ? "model" as const : undefined,
    });
    const oneOfFive = buildCoverageMatrix(Array.from({ length: 5 }, (_, index) => ({
      path: `src/services/service-${index}.ts`,
      analysis: makeAnalysis(`src/services/service-${index}.ts`, index === 0),
    })));
    expect(oneOfFive.find((area) => area.key === "application_logic")).toMatchObject({
      status: "static_mapped",
      semanticPathCount: 1,
      requiredSemanticPathCount: 2,
      semanticCoverageRatio: 0.5,
    });
    const twoOfFive = buildCoverageMatrix(Array.from({ length: 5 }, (_, index) => ({
      path: `src/services/service-${index}.ts`,
      analysis: makeAnalysis(`src/services/service-${index}.ts`, index < 2),
    })));
    expect(twoOfFive.find((area) => area.key === "application_logic")).toMatchObject({
      status: "semantic_verified",
      semanticCoverageRatio: 1,
    });
  });

  it("fills sparse generic roles with high-signal repository domains", () => {
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

  it("retains late task-specific implementation anchors in bounded windows", () => {
    const lines = Array.from({ length: 1_200 }, (_, index) =>
      index < 240 && index % 8 === 0
        ? `export function unrelatedHandler${index}() { return ${index}; }`
        : `const value${index} = ${index};`,
    );
    lines[1_099] = "export function persistContributionLedger() { return transaction.commit(); }";
    const [window] = selectSemanticWindows(lines.join("\n"), 1_200, {
      task: {
        objective: "Find contribution ledger persistence.",
        capabilityKeys: ["project_domain:contributions"],
        questions: [],
        expectedOutputs: ["persistContributionLedger"],
      },
    });
    expect(window?.content).toContain("1100: export function persistContributionLedger");
  });
});
