import { describe, expect, it } from "vitest";
import {
  buildRepositoryDerivedCapabilityManifest,
  buildRepositoryDerivedSemanticPlan,
  critiqueRepositoryCoverage,
  isRepositoryCartographyNoisePath,
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
      ],
    });

    expect(manifest.map((area) => area.key)).toEqual([
      "project_domain:accounts",
      "project_domain:messaging",
      "project_domain:payments",
    ]);
    expect(manifest.flatMap((area) => area.files.map((file) => file.path))).not.toEqual(
      expect.arrayContaining([
        ".playwright-cli/session.json",
        ".workflow-data/runs/run.ts",
        "test/resources/generated/AccountModel.java",
      ]),
    );
    expect(manifest.some((area) => /ai_runtime|ingestion|project_domain:(?:api|model)/.test(area.key))).toBe(false);
    expect(isRepositoryCartographyNoisePath(".nyc_output/process.json")).toBe(true);
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

    expect(semanticSampleTarget(area)).toBe(3);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.fileSnapshotIds).toHaveLength(3);
    expect(plan[0]?.fileSnapshotIds).toEqual(["feed-0", "feed-1", "feed-2"]);
    expect(plan[0]?.fileSnapshotIds.length).toBeLessThanOrEqual(8);
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
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(["contribution"]);

    const finalCritique = critiqueRepositoryCoverage({
      manifest,
      reports: [...firstPass, {
        inspectedFileSnapshotIds: ["contribution"],
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
        inspectedFileSnapshotIds: ["payments-0-a"],
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
    expect(critique.repairPackages[0]?.fileSnapshotIds).toEqual(["payments-1-a"]);
  });
});
