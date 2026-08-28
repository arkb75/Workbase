import { describe, expect, it } from "vitest";
import {
  buildRepositoryDerivedCapabilityManifest,
  buildRepositoryDerivedSemanticPlan,
  critiqueRepositoryCoverage,
  isRepositoryCartographyNoisePath,
  repositoryIncomingReferenceCounts,
  semanticSampleTarget,
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
      "repository_area:application_core",
    ]));
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
  });

  it("uses cross-language repository references as a bounded representative signal", () => {
    const counts = repositoryIncomingReferenceCounts([
      { path: "src/orders/controller.ts", analysis: { dependencies: ["./service"] } },
      { path: "src/orders/service.ts", analysis: { dependencies: ["./repository"] } },
      { path: "src/orders/repository.ts", analysis: { dependencies: [] } },
      { path: "src/scoring/api.py", analysis: { dependencies: ["./engine"] } },
      { path: "src/scoring/engine.py", analysis: { dependencies: [] } },
      { path: "src/main/java/com/acme/billing/BillingApi.java", analysis: { dependencies: ["com/acme/billing/BillingService"] } },
      { path: "src/main/java/com/acme/billing/BillingService.java", analysis: { dependencies: [] } },
    ]);

    expect(counts.get("src/orders/service.ts")).toBe(1);
    expect(counts.get("src/orders/repository.ts")).toBe(1);
    expect(counts.get("src/scoring/engine.py")).toBe(1);
    expect(counts.get("src/main/java/com/acme/billing/BillingService.java")).toBe(1);
  });

  it("ranks a repository-local dependency hub above otherwise equal files", () => {
    const callers = ["alpha", "beta", "gamma"].map((name) => ({
      ...mappedFile(name, `src/orders/${name}.ts`),
      analysis: {
        ...mappedFile(name, `src/orders/${name}.ts`).analysis,
        dependencies: ["./z-central"],
      },
    }));
    const manifest = buildRepositoryDerivedCapabilityManifest({
      scopeKey: "example/commerce",
      files: [
        ...callers,
        mappedFile("central", "src/orders/z-central.ts"),
      ],
    });

    expect(manifest.find((area) => area.key === "project_domain:orders")?.files[0])
      .toMatchObject({ id: "central", path: "src/orders/z-central.ts" });
  });

  it("samples large domains proportionally within bounded investigator packages", () => {
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

    expect(semanticSampleTarget(area)).toBe(4);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.fileSnapshotIds).toHaveLength(4);
    expect(plan[0]?.fileSnapshotIds).toEqual(["feed-0", "feed-1", "feed-2", "feed-3"]);
    expect(plan[0]?.fileSnapshotIds.length).toBeLessThanOrEqual(8);
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

  it("caps repair to the three most important unresolved domains", () => {
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
    expect(critique.repairPackages).toHaveLength(3);
    expect(critique.repairPackages.map((entry) => entry.capabilityKeys[0])).toEqual([
      "project_domain:domain-0",
      "project_domain:domain-1",
      "project_domain:domain-2",
    ]);
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
