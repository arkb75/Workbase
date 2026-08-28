import { describe, expect, it } from "vitest";
import {
  repositoryKnowledgeFixture,
  repositoryKnowledgeFixtures,
} from "@/src/evals/repository-knowledge-fixtures";
import {
  auditRepositoryKnowledgeFixtureCatalog,
  evaluateRepositoryKnowledgeRun,
  evaluateRepositoryKnowledgeSuite,
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryExpectedCapability,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";
import { parseRepositoryKnowledgeEvaluationRuns } from "@/src/evals/repository-knowledge-observation";

function pathForCapability(
  fixture: RepositoryKnowledgeFixture,
  capability: RepositoryExpectedCapability,
) {
  const found = fixture.files.find((file) =>
    capability.evidencePathPatterns.some((pattern) =>
      new RegExp(pattern, "iu").test(file.path)
    )
  );
  if (!found) {
    throw new Error(`Fixture ${fixture.id} has no evidence path for ${capability.key}.`);
  }
  return found.path;
}

function isIgnored(fixture: RepositoryKnowledgeFixture, path: string) {
  return fixture.ignoredPathPatterns.some((pattern) =>
    new RegExp(pattern, "iu").test(path)
  );
}

function withRepresentativeContent(
  fixture: RepositoryKnowledgeFixture,
): RepositoryKnowledgeFixture {
  const evidenceByPath = new Map<string, string[]>();
  for (const capability of fixture.expectedCapabilities) {
    const path = pathForCapability(fixture, capability);
    const excerpts = evidenceByPath.get(path) ?? [];
    excerpts.push(
      capability.key,
      capability.label,
      capability.exampleClaim,
    );
    evidenceByPath.set(path, excerpts);
  }
  return {
    ...fixture,
    files: fixture.files.map((file) => ({
      ...file,
      content: [file.content, ...(evidenceByPath.get(file.path) ?? [])]
        .filter(Boolean)
        .join("\n") || undefined,
    })),
  };
}

function representativeRun(
  fixture: RepositoryKnowledgeFixture,
): RepositoryKnowledgeEvaluationRun {
  const analyzedPaths = fixture.files
    .map((file) => file.path)
    .filter((path) => !isIgnored(fixture, path));
  const semanticAnalyzedPaths = Array.from(new Set(
    fixture.expectedCapabilities.map((capability) =>
      pathForCapability(fixture, capability)
    ),
  ));
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    commitSha: fixture.snapshotCommit,
    items: fixture.expectedCapabilities.map((capability, index) => ({
      id: `${fixture.id}-item-${index + 1}`,
      kind: capability.expectedInHighlights ? "highlight" : "fact",
      text: capability.exampleClaim,
      summary: capability.label,
      claimState: capability.implementationState,
      domain: capability.domainKey,
      evidence: [{ path: pathForCapability(fixture, capability) }],
    })),
    domains: fixture.expectedDomains.map((expected) => ({
      key: expected.key,
      label: expected.label,
    })),
    discoveredCapabilities: fixture.expectedCapabilities.map((expected) => ({
      key: expected.key,
      label: expected.label,
      evidencePaths: [pathForCapability(fixture, expected)],
    })),
    inventory: {
      scannableFiles: analyzedPaths.length,
      analyzedFiles: analyzedPaths.length,
      semanticEligibleFiles: semanticAnalyzedPaths.length,
      semanticAnalyzedFiles: semanticAnalyzedPaths.length,
      analyzedPaths,
      semanticAnalyzedPaths,
    },
    coverage: { static: 1, semantic: 1, knowledge: 1 },
    performance: {
      durationMs: Math.floor(fixture.budget.maximumDurationMs * 0.5),
      modelCalls: Math.floor(fixture.budget.maximumModelCalls * 0.5),
      totalTokens: Math.floor(fixture.budget.maximumTokens * 0.5),
      estimatedCostUsd: fixture.budget.maximumEstimatedCostUsd * 0.5,
    },
  };
}

describe("generalized repository knowledge evaluation", () => {
  it("audits a catalog spanning real projects, archetypes, and language families", () => {
    const audit = auditRepositoryKnowledgeFixtureCatalog(repositoryKnowledgeFixtures);

    expect(audit).toMatchObject({
      passed: true,
      fixtureCount: 7,
      archetypeCount: 7,
      realRepositoryCount: 6,
    });
    expect(audit.languageFamilyCount).toBeGreaterThanOrEqual(3);
    expect(audit.repositories).toEqual(expect.arrayContaining([
      "arkb75/Workbase",
      "arkb75/SoloPilot",
      "arkb75/CircleFund",
      "arkb75/Backer",
      "arkb75/InsightUBC",
      "arkb75/Amazon-Marketplace-Analytic-Software",
    ]));
  });

  it("treats hyphenated and underscored feature directories as the same fixture family", () => {
    const fixture = repositoryKnowledgeFixture("solopilot-agent-documents")!;
    const capability = fixture.expectedCapabilities.find(({ key }) =>
      key === "email_intake"
    )!;

    expect(capability.evidencePathPatterns.some((pattern) =>
      new RegExp(pattern, "iu").test(
        "frontend/email-intake/src/components/ReplyEditor.tsx",
      )
    )).toBe(true);
    expect(capability.evidencePathPatterns.some((pattern) =>
      new RegExp(pattern, "iu").test(
        "src/agents/email_intake/conversational_responder.py",
      )
    )).toBe(true);
  });

  it("requires implementation evidence and keeps independently missable capabilities separate", () => {
    const implemented = repositoryKnowledgeFixtures
      .filter((fixture) => fixture.sourceKind === "curated_real_repository")
      .flatMap((fixture) => fixture.expectedCapabilities)
      .filter((capability) => capability.implementationState === "implemented");
    expect(implemented.every((capability) =>
      capability.evidencePathPatterns.some((pattern) => !/readme/iu.test(pattern))
    )).toBe(true);

    const amazon = repositoryKnowledgeFixture("amazon-marketplace-analytics")!;
    const amazonKeys = amazon.expectedCapabilities.map((capability) => capability.key);
    expect(amazonKeys).toEqual(expect.arrayContaining([
      "product_catalog",
      "purchase_orders",
      "unit_economics_tracking",
    ]));
    expect(amazonKeys).not.toEqual(expect.arrayContaining([
      "catalog_orders",
      "sales_analytics",
    ]));

    const soloPilotPlanned = repositoryKnowledgeFixture("solopilot-agent-documents")!
      .expectedCapabilities.find((capability) => capability.key === "prd_export")!;
    expect(soloPilotPlanned.evidencePathPatterns).toEqual(["(?:^|/)README\\.md$"]);
    expect(soloPilotPlanned.matchPatterns.join(" ")).toMatch(/in progress.*roadmap.*phase 2/iu);
  });

  it("passes broad, grounded observations without exact-prose assertions", () => {
    const fixtures = repositoryKnowledgeFixtures.map(withRepresentativeContent);
    const runs = fixtures.map(representativeRun);
    const report = evaluateRepositoryKnowledgeSuite({
      fixtures,
      runs,
    });

    expect(report.passed).toBe(true);
    expect(report.passingFixtureCount).toBe(repositoryKnowledgeFixtures.length);
    expect(report.minimumProjectScore).toBeGreaterThanOrEqual(0.9);
    expect(report.results.every((result) =>
      result.rawItems.length > 0 && result.metrics.evidencePrecision >= 0.9
    )).toBe(true);
  });

  it("requires curated observations to identify the exact pinned source", () => {
    const fixture = repositoryKnowledgeFixture("backer-marketplace")!;
    const run = representativeRun(fixture);

    expect(() => evaluateRepositoryKnowledgeRun({
      fixture,
      run: { ...run, repository: null },
    })).toThrow(/requires its repository identity/iu);
    expect(() => evaluateRepositoryKnowledgeRun({
      fixture,
      run: { ...run, repository: "arkb75/Another-Repository" },
    })).toThrow(/does not match arkb75\/Backer/iu);
    expect(() => evaluateRepositoryKnowledgeRun({
      fixture,
      run: { ...run, commitSha: null },
    })).toThrow(/commit <missing> does not match pinned commit/iu);
    expect(() => evaluateRepositoryKnowledgeRun({
      fixture,
      run: { ...run, commitSha: fixture.snapshotCommit!.slice(0, 12) },
    })).toThrow(/does not match pinned commit/iu);
    expect(() => evaluateRepositoryKnowledgeRun({
      fixture,
      run: { ...run, commitSha: fixture.snapshotCommit!.toUpperCase() },
    })).not.toThrow();

    const syntheticFixture = repositoryKnowledgeFixture("cloudsync-cli-library")!;
    const syntheticRun = representativeRun(syntheticFixture);
    expect(() => evaluateRepositoryKnowledgeRun({
      fixture: syntheticFixture,
      run: { ...syntheticRun, repository: null, commitSha: null },
    })).not.toThrow();
  });

  it("does not recover a capability from an unsupported matching claim", () => {
    const fixture = repositoryKnowledgeFixture("backer-marketplace")!;
    const run = representativeRun(fixture);
    run.items = [{
      id: "feed-with-unrelated-claim",
      kind: "highlight",
      text: "Built a trainable investor feed ranker. Trained a satellite-image weather classifier.",
      claimState: "implemented",
      domain: "discovery",
      evidence: [{ path: "lib/feed/ranking.ts" }],
    }];
    run.domains = [{ key: "discovery", label: "Marketplace discovery" }];

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.unsupportedItems).toContain("feed-with-unrelated-claim");
    expect(report.recoveredCapabilityKeys).not.toContain("ranked_feed");
    expect(report.metrics.capabilityRecall).toBe(0);
    expect(report.metrics.highlightCapabilityRecall).toBe(0);
  });

  it("does not let an unrelated expected-path citation buy capability recall", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("solopilot-agent-documents")!,
    );
    fixture.files = fixture.files.map((file) => {
      if (file.path === "src/providers/base.py") {
        return { ...file, content: "Added a human approval workflow." };
      }
      if (file.path.endsWith("ReplyEditor.tsx")) {
        return { ...file, content: "export function ReplyEditor() { return null; }" };
      }
      return file;
    });
    const run = representativeRun(fixture);
    run.items = [{
      id: "laundered-human-review",
      kind: "highlight",
      text: "Added a human approval workflow.",
      claimState: "implemented",
      domain: "quality",
      evidence: [
        { path: "src/providers/base.py", quote: "Added a human approval workflow." },
        {
          path: "frontend/email-intake/src/components/ReplyEditor.tsx",
          quote: "export function ReplyEditor() { return null; }",
        },
      ],
    }];

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.unsupportedItems).not.toContain("laundered-human-review");
    expect(report.recoveredCapabilityKeys).not.toContain("human_review");
    expect(report.metrics.capabilityRecall).toBe(0);
  });

  it("requires grounded domain evidence instead of generated labels and unrelated citations", () => {
    const fixture = repositoryKnowledgeFixture("backer-marketplace")!;
    const run = representativeRun(fixture);
    run.items = [{
      id: "unrelated-onboarding-citation",
      kind: "fact",
      text: "Trained a satellite-image weather classifier.",
      claimState: "implemented",
      domain: "vision",
      evidence: [{ path: "app/api/onboarding/founder/route.ts" }],
    }];
    run.domains = [{ key: "identity", label: "Identity and onboarding" }];

    const unrelated = evaluateRepositoryKnowledgeRun({ fixture, run });
    expect(unrelated.unsupportedItems).toContain("unrelated-onboarding-citation");
    expect(unrelated.recoveredDomainKeys).not.toContain("identity");

    run.items = [{
      id: "grounded-identity-item",
      kind: "fact",
      text: "Uses the founder route.",
      claimState: "implemented",
      domain: "identity",
      evidence: [{ path: "app/api/onboarding/founder/route.ts" }],
    }];
    const grounded = evaluateRepositoryKnowledgeRun({ fixture, run });
    expect(grounded.recoveredCapabilityKeys).toEqual([]);
    expect(grounded.unsupportedItems).not.toContain("grounded-identity-item");
    expect(grounded.recoveredDomainKeys).toContain("identity");
  });

  it("accepts legitimate extra grounded knowledge without changing curated recall", () => {
    const profiles = [
      {
        fixtureId: "solopilot-agent-documents",
        extras: [
          {
            path: "src/integrations/stripe_billing.py",
            content: "def create_stripe_checkout(customer_id): return stripe.checkout.Session.create(customer=customer_id)",
            key: "stripe_billing",
            label: "Stripe billing and checkout",
            claim: "Integrated Stripe billing with hosted checkout sessions.",
          },
          {
            path: "frontend/wireframes/revision-comparison.tsx",
            content: "export function RevisionWireframe() { return <section>Revision comparison wireframe</section>; }",
            key: "revision_wireframe",
            label: "Revision comparison wireframe",
            claim: "Built a revision-comparison wireframe for document review.",
          },
        ],
      },
      {
        fixtureId: "workbase-project-knowledge",
        extras: [
          {
            path: "src/services/github-webhook-service.ts",
            content: "export async function verifyGithubWebhookSignature() { return dispatchRepositoryRefresh(); }",
            key: "github_webhooks",
            label: "GitHub webhook refresh",
            claim: "Verified GitHub webhooks before dispatching repository refreshes.",
          },
          {
            path: "src/services/project-citation-index.ts",
            content: "export function indexProjectCitations() { return buildClaimLocalCitationIndex(); }",
            key: "citation_index",
            label: "Claim-local citation index",
            claim: "Indexed claim-local citations for grounded project answers.",
          },
        ],
      },
    ] as const;

    for (const profile of profiles) {
      const baseFixture = repositoryKnowledgeFixture(profile.fixtureId)!;
      const fixture = withRepresentativeContent({
        ...baseFixture,
        files: [
          ...baseFixture.files,
          ...profile.extras.map(({ path, content }) => ({ path, content })),
        ],
      });
      const baseline = evaluateRepositoryKnowledgeRun({
        fixture,
        run: representativeRun(fixture),
      });
      const run = representativeRun(fixture);
      run.items.push(...profile.extras.map((extra, index) => ({
        id: `${profile.fixtureId}-extra-${index}`,
        kind: "fact" as const,
        text: extra.claim,
        claimState: "implemented" as const,
        domain: extra.key,
        evidence: [{
          path: extra.path,
          lineStart: 1,
          lineEnd: 1,
          quote: extra.content,
        }],
      })));
      run.discoveredCapabilities!.push(...profile.extras.map((extra) => ({
        key: extra.key,
        label: extra.label,
        evidencePaths: [extra.path],
      })));

      const report = evaluateRepositoryKnowledgeRun({ fixture, run });

      expect(report.recoveredCapabilityKeys).toEqual(
        baseline.recoveredCapabilityKeys,
      );
      expect(report.metrics.knowledgeItemPrecision).toBe(1);
      expect(report.metrics.capabilityMapPrecision).toBe(1);
      expect(report.unsupportedItems).toEqual([]);
    }
  });

  it("rejects missing, misquoted, and claim-unrelated repository citations", () => {
    const baseFixture = repositoryKnowledgeFixture("workbase-project-knowledge")!;
    const webhookPath = "src/services/github-webhook-service.ts";
    const webhookContent = "export function verifyGithubWebhookSignature() { return dispatchRepositoryRefresh(); }";
    const fixture = withRepresentativeContent({
      ...baseFixture,
      files: [...baseFixture.files, { path: webhookPath, content: webhookContent }],
    });
    const run = representativeRun(fixture);
    run.items.push(
      {
        id: "missing-path",
        kind: "fact",
        text: "Integrated Stripe subscription billing.",
        claimState: "implemented",
        domain: "stripe_billing",
        evidence: [{ path: "src/integrations/stripe-billing.ts" }],
      },
      {
        id: "misquoted-webhook",
        kind: "fact",
        text: "Verified GitHub webhook signatures before refresh dispatch.",
        claimState: "implemented",
        domain: "github_webhooks",
        evidence: [{
          path: webhookPath,
          lineStart: 1,
          lineEnd: 1,
          quote: "export function trustEveryWebhookWithoutVerification() {}",
        }],
      },
      {
        id: "unrelated-claim",
        kind: "fact",
        text: "Verified GitHub webhook signatures and trained a satellite-image vision classifier with GPU inference.",
        claimState: "implemented",
        domain: "github_webhooks",
        evidence: [{
          path: webhookPath,
          lineStart: 1,
          lineEnd: 1,
          quote: webhookContent,
        }],
      },
    );
    run.discoveredCapabilities!.push(
      {
        key: "stripe_billing",
        label: "Stripe subscription billing",
        evidencePaths: ["src/integrations/stripe-billing.ts"],
      },
      {
        key: "github_webhooks",
        label: "GitHub webhook verification",
        evidencePaths: [webhookPath],
      },
      {
        key: "satellite_vision",
        label: "GitHub webhook satellite-image vision classifier",
        evidencePaths: [webhookPath],
      },
    );

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });
    const withoutUnrelatedCapability = evaluateRepositoryKnowledgeRun({
      fixture,
      run: {
        ...run,
        discoveredCapabilities: run.discoveredCapabilities!.filter((candidate) =>
          candidate.key !== "satellite_vision"
        ),
      },
    });

    expect(report.unsupportedItems).toEqual(expect.arrayContaining([
      "missing-path",
      "misquoted-webhook",
      "unrelated-claim",
    ]));
    expect(report.metrics.knowledgeItemPrecision).toBeLessThan(0.75);
    expect(report.metrics.citationPathPrecision).toBeLessThan(1);
    expect(report.metrics.capabilityMapPrecision).toBeLessThan(1);
    expect(report.metrics.capabilityMapPrecision).toBeLessThan(
      withoutUnrelatedCapability.metrics.capabilityMapPrecision,
    );
  });

  it("grounds each citation against the claim sentence it supports", () => {
    const baseFixture = repositoryKnowledgeFixture("workbase-project-knowledge")!;
    const files = [
      {
        path: "src/services/webhook-verification.ts",
        content: "export function verifyGithubWebhookSignatures() { return true; }",
      },
      {
        path: "src/services/refresh-dispatch.ts",
        content: "export function dispatchRepositoryRefreshJobs() { return true; }",
      },
      {
        path: "src/services/refresh-audit.ts",
        content: "export function persistRefreshAuditRecords() { return true; }",
      },
      {
        path: "src/services/weather-map.ts",
        content: "export function renderSatelliteWeatherMap() { return true; }",
      },
    ];
    const fixture = withRepresentativeContent({
      ...baseFixture,
      files: [...baseFixture.files, ...files],
    });
    const run = representativeRun(fixture);
    const item = {
      id: "multi-reference-claim",
      kind: "fact" as const,
      text: "Verified GitHub webhook signatures. Dispatched repository refresh jobs. Persisted refresh audit records.",
      claimState: "implemented" as const,
      domain: "repository_refresh",
      evidence: files.slice(0, 3).map((file) => ({
        path: file.path,
        lineStart: 1,
        lineEnd: 1,
        quote: file.content,
      })),
    };
    run.items.push(item);

    const grounded = evaluateRepositoryKnowledgeRun({ fixture, run });
    expect(grounded.metrics.evidencePrecision).toBe(1);
    expect(grounded.unsupportedItems).not.toContain(item.id);

    item.evidence.push({
      path: files[3]!.path,
      lineStart: 1,
      lineEnd: 1,
      quote: files[3]!.content,
    });
    const withUnrelatedCitation = evaluateRepositoryKnowledgeRun({ fixture, run });
    expect(withUnrelatedCitation.metrics.citationPathPrecision).toBe(1);
    expect(withUnrelatedCitation.metrics.evidencePrecision).toBeLessThan(1);
    expect(withUnrelatedCitation.unsupportedItems).not.toContain(item.id);
  });

  it("uses only the declared line range beyond a truncated audit quote", () => {
    const baseFixture = repositoryKnowledgeFixture("workbase-project-knowledge")!;
    const path = "src/services/conversation-store.ts";
    const serializedPrefix = `export const serializedRepositorySnapshot = "${"x".repeat(2_100)}";`;
    const content = [
      serializedPrefix,
      "export const unrelatedConversationState = true;",
      "export function deduplicateConversationsByParticipantIds() { return true; }",
    ].join("\n");
    const fixture = withRepresentativeContent({
      ...baseFixture,
      files: [...baseFixture.files, { path, content }],
    });
    const run = representativeRun(fixture);
    const truncatedQuote = serializedPrefix.slice(0, 2_000);
    run.items.push(
      {
        id: "support-later-in-range",
        kind: "fact",
        text: "Deduplicated conversations by participant identifiers.",
        claimState: "implemented",
        domain: "conversations",
        evidence: [{
          path,
          lineStart: 1,
          lineEnd: 3,
          quote: truncatedQuote,
        }],
      },
      {
        id: "support-outside-range",
        kind: "fact",
        text: "Deduplicated conversations by participant identifiers.",
        claimState: "implemented",
        domain: "conversations",
        evidence: [{
          path,
          lineStart: 1,
          lineEnd: 2,
          quote: truncatedQuote,
        }],
      },
    );

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.unsupportedItems).not.toContain("support-later-in-range");
    expect(report.unsupportedItems).toContain("support-outside-range");
  });

  it("scores asserted capability mappings without treating empty ledger placeholders as false claims", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("circlefund-fintech")!,
    );
    const run = representativeRun(fixture);
    run.discoveredCapabilities!.push({
      key: "module:future_extension_point",
      label: "Future extension point",
      evidencePaths: [],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.metrics.capabilityMapPrecision).toBe(1);
    expect(report.metrics.capabilityGranularity).toBeGreaterThan(0);

    run.discoveredCapabilities = [{
      key: "module:unmapped_only",
      label: "Unmapped placeholder",
      evidencePaths: [],
    }];
    const unmappedReport = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(unmappedReport.metrics.capabilityMapPrecision).toBe(0);
  });

  it("does not let an unverifiable serialized quote prove its own claim", () => {
    const fixture = repositoryKnowledgeFixture("workbase-project-knowledge")!;
    const run = representativeRun(fixture);
    run.items.push({
      id: "invented-compact-quote",
      kind: "fact",
      text: "Trained a satellite-image vision classifier with GPU inference.",
      claimState: "implemented",
      domain: "satellite_vision",
      evidence: [{
        path: "src/services/github-repo-import-service.ts",
        quote: "Trained a satellite-image vision classifier with GPU inference.",
      }],
    });
    run.discoveredCapabilities!.push({
      key: "satellite_vision",
      label: "Satellite-image vision classifier",
      evidencePaths: ["src/services/github-repo-import-service.ts"],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.unsupportedItems).toContain("invented-compact-quote");
  });

  it("validates repository excerpts with bounded explicit redaction placeholders", () => {
    const baseFixture = repositoryKnowledgeFixture("backer-marketplace")!;
    const authPath = "lib/auth.ts";
    const authContent = `CredentialsProvider({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const isPasswordValid = await compare(credentials.password, user.passwordHash);
        if (!isPasswordValid) return null;
      }
    })`;
    const fixture = withRepresentativeContent({
      ...baseFixture,
      files: [...baseFixture.files, { path: authPath, content: authContent }],
    });
    const run = representativeRun(fixture);
    run.items.push({
      id: "credential-validation",
      kind: "fact",
      text: "Credential password validation checks email and password inputs.",
      claimState: "implemented",
      domain: "security",
      evidence: [{
        path: authPath,
        quote: `CredentialsProvider({
          credentials: {
            email: { label: "Email", type: "email" },
            password: [REDACTED]
          },
          async authorize(credentials) {
            if (!credentials?.email || !credentials?.password) return null;
            const isPasswordValid = await compare(credentials.password, user.passwordHash);
            if (!isPasswordValid) return null;
          }
        })`,
      }],
    });
    run.discoveredCapabilities!.push({
      key: "credential_validation",
      label: "Credential password validation",
      evidencePaths: [authPath],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.unsupportedItems).not.toContain("credential-validation");
    expect(report.metrics.citationPathPrecision).toBe(1);
  });

  it("does not reward a Workbase-specific answer reused across unrelated repositories", () => {
    const fixtures = repositoryKnowledgeFixtures.map(withRepresentativeContent);
    const workbase = fixtures.find((fixture) =>
      fixture.id === "workbase-project-knowledge"
    )!;
    const workbaseRun = representativeRun(workbase);
    const runs = fixtures.map((fixture) => {
      if (fixture.id === workbase.id) return workbaseRun;
      const cleanPaths = fixture.files
        .map((file) => file.path)
        .filter((path) => !isIgnored(fixture, path));
      return {
        ...workbaseRun,
        fixtureId: fixture.id,
        repository: fixture.repository,
        commitSha: fixture.snapshotCommit,
        items: workbaseRun.items.map((item) => ({
          ...item,
          id: `${fixture.id}-${item.id}`,
          evidence: [{ path: cleanPaths[0]! }],
        })),
        inventory: {
          ...workbaseRun.inventory,
          scannableFiles: cleanPaths.length,
          analyzedFiles: cleanPaths.length,
          analyzedPaths: cleanPaths,
          semanticAnalyzedPaths: cleanPaths.slice(0, 2),
          semanticEligibleFiles: 2,
          semanticAnalyzedFiles: 2,
        },
      } satisfies RepositoryKnowledgeEvaluationRun;
    });
    const report = evaluateRepositoryKnowledgeSuite({
      fixtures,
      runs,
    });

    expect(report.passed).toBe(false);
    expect(report.minimumProjectScore).toBeLessThan(0.35);
    expect(report.results.find((result) =>
      result.fixtureId === "amazon-marketplace-analytics"
    )?.metrics.capabilityRecall).toBe(0);
  });

  it("penalizes presenting planned README features as implemented", () => {
    for (const fixtureId of ["circlefund-fintech", "insightubc-dataset-platform"]) {
      const fixture = withRepresentativeContent(
        repositoryKnowledgeFixture(fixtureId)!,
      );
      const run = representativeRun(fixture);
      const planned = fixture.expectedCapabilities.find((capability) =>
        capability.implementationState === "planned"
      )!;
      const plannedItem = run.items.find((item) =>
        item.text === planned.exampleClaim
      )!;
      plannedItem.claimState = "implemented";
      plannedItem.text = `Implemented ${planned.label} as a shipped product capability.`;
      const report = evaluateRepositoryKnowledgeRun({ fixture, run });

      expect(report.metrics.claimStateCorrectness).toBeLessThan(0.9);
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: "implemented-versus-planned correctness",
        passed: false,
      }));
    }
  });

  it("treats current-state repository claims as implemented without requiring achievement verbs", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("backer-marketplace")!,
    );
    const run = representativeRun(fixture);
    const rankedFeed = run.items.find((item) =>
      item.text.includes("trainable investor feed ranker")
    )!;
    delete rankedFeed.claimState;
    rankedFeed.text =
      "Investor-personalized Next.js planning workspace with feed-model scoring and deterministic weighting.";
    rankedFeed.summary = "Trainable investor feed ranking and planning workflow.";

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.metrics.claimStateCorrectness).toBe(1);
  });

  it("requires planned repository knowledge to carry explicit state", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("circlefund-fintech")!,
    );
    const run = representativeRun(fixture);
    const planned = run.items.find((item) =>
      item.text.includes("future extensions")
    )!;
    delete planned.claimState;
    planned.text = "Roadmap work covers the future loan and repayment lifecycle.";

    const unlabeled = evaluateRepositoryKnowledgeRun({ fixture, run });
    planned.claimState = "planned";
    const labeled = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(unlabeled.metrics.claimStateCorrectness).toBeLessThan(1);
    expect(labeled.metrics.claimStateCorrectness).toBe(1);
  });

  it("does not confuse implemented preparatory configuration with a planned lifecycle", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("circlefund-fintech")!,
    );
    const baselineRun = representativeRun(fixture);
    const baseline = evaluateRepositoryKnowledgeRun({ fixture, run: baselineRun });
    const run = representativeRun(fixture);
    run.items.push({
      id: "implemented-loan-storage-config",
      kind: "fact",
      text: "Configured preparatory database fields for future loan and repayment models.",
      claimState: "implemented",
      evidence: [{ path: "prisma/schema.prisma" }],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.metrics.claimStateCorrectness).toBe(
      baseline.metrics.claimStateCorrectness,
    );

    run.items.at(-1)!.evidence = [{ path: "README.md" }];
    const maturityBackedReport = evaluateRepositoryKnowledgeRun({ fixture, run });
    expect(maturityBackedReport.metrics.claimStateCorrectness).toBeLessThan(
      baseline.metrics.claimStateCorrectness,
    );
  });

  it("does not score implementation state from a text-only capability match", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("circlefund-fintech")!,
    );
    const baselineRun = representativeRun(fixture);
    const baseline = evaluateRepositoryKnowledgeRun({ fixture, run: baselineRun });
    const run = representativeRun(fixture);
    run.items.push({
      id: "unrelated-loan-copy",
      kind: "fact",
      text: "Implemented loan repayment copy in the signup screen.",
      claimState: "implemented",
      evidence: [{ path: "src/app/api/v1/auth/signup/route.ts" }],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.metrics.claimStateCorrectness).toBe(
      baseline.metrics.claimStateCorrectness,
    );
  });

  it("does not double-penalize state when no capability has an evidence-backed match", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("workbase-project-knowledge")!,
    );
    const run = representativeRun(fixture);
    run.items = [];

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.metrics.capabilityRecall).toBe(0);
    expect(report.metrics.claimStateCorrectness).toBe(1);
  });

  it("catches generated artifacts, generic-token mappings, and capability explosion", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("amazon-marketplace-analytics")!,
    );
    const run = representativeRun(fixture);
    run.inventory.analyzedPaths!.push(
      ".idea/workspace.xml",
      "AmazonAnalytics.jar",
    );
    run.inventory.semanticAnalyzedPaths!.push(
      "lib/junit-jupiter-5.4.2.jar",
      "data/tobs.jpg",
    );
    run.inventory.scannableFiles = 1_000_000;
    run.inventory.analyzedFiles = 1_000_000;
    run.discoveredCapabilities = Array.from({ length: 30 }, (_, index) => ({
      key: `ai_runtime_model_${index}`,
      label: `AI runtime model ${index}`,
      evidencePaths: ["src/main/model/ProductDetails.java"],
    }));
    run.items.push({
      id: "generic-model-item",
      kind: "fact",
      text: "Implemented an AI model-inference runtime.",
      claimState: "implemented",
      domain: "ai_runtime",
      evidence: [{ path: "src/main/model/ProductDetails.java" }],
    });

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.passed).toBe(false);
    expect(report.metrics.inventoryHygiene).toBeLessThan(0.95);
    expect(report.metrics.capabilityGranularity).toBeLessThan(0.75);
    expect(report.metrics.genericTokenFalsePositiveRate).toBe(1);
    expect(report.falsePositiveCapabilities).toHaveLength(30);
    expect(report.unsupportedItems).toContain("generic-model-item");
  });

  it("counts paths analyzed by both inventory phases once for hygiene", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("circlefund-fintech")!,
    );
    const run = representativeRun(fixture);
    const ignoredPath = ".codex/skills/database/SKILL.md";
    run.inventory.analyzedPaths!.push(ignoredPath);
    run.inventory.semanticAnalyzedPaths!.push(ignoredPath);

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });
    const uniqueSelectedPaths = new Set([
      ...run.inventory.analyzedPaths!,
      ...run.inventory.semanticAnalyzedPaths!,
    ]);

    expect(report.metrics.inventoryHygiene).toBeCloseTo(
      1 - (1 / uniqueSelectedPaths.size),
      6,
    );
  });

  it("penalizes irrelevant output volume, duplicate highlights, and inflated coverage", () => {
    const fixture = withRepresentativeContent(
      repositoryKnowledgeFixture("backer-marketplace")!,
    );
    const run = representativeRun(fixture);
    run.items = run.items.slice(0, 2);
    const copied = run.items[0]!;
    run.items.push(
      ...Array.from({ length: 8 }, (_, index) => ({
        ...copied,
        id: `duplicate-${index}`,
        text: copied.text,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `noise-${index}`,
        kind: "highlight" as const,
        text: `Refactored helper ${index} and changed formatting.`,
        claimState: "implemented" as const,
        evidence: [{ path: "README.md" }],
      })),
    );
    run.coverage.knowledge = 1;

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.passed).toBe(false);
    expect(report.metrics.knowledgeItemPrecision).toBeLessThan(0.75);
    expect(report.metrics.duplicateRate).toBeGreaterThan(0.35);
    expect(report.metrics.coverageCalibration).toBeLessThan(0.9);
    expect(report.unsupportedItems).toHaveLength(8);
  });

  it("validates serialized observations before scoring them", () => {
    const fixture = repositoryKnowledgeFixture("circlefund-fintech")!;
    const run = representativeRun(fixture);
    expect(parseRepositoryKnowledgeEvaluationRuns({ runs: [run] })).toEqual([run]);
    expect(() => parseRepositoryKnowledgeEvaluationRuns({
      runs: [{ ...run, coverage: { ...run.coverage, knowledge: 1.2 } }],
    })).toThrow();
    expect(() => parseRepositoryKnowledgeEvaluationRuns({
      runs: [{ ...run, unexpected: true }],
    })).toThrow();
  });
});
