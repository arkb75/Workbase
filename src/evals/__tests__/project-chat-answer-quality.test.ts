import { describe, expect, it } from "vitest";
import {
  evaluateProjectChatAnswerQuality,
  projectChatPrimaryAnswerItems,
  projectChatReaderThemes,
  splitProjectChatPrimaryAnswerItems,
} from "@/src/evals/project-chat-answer-quality";

const strongAnswer = `## Strongest accomplishments

### 1. Career-content product

Built a career-content platform that turns repository evidence into resume bullets and project summaries. It does this by routing evidence through reviewed Highlights, which keeps public artifacts grounded while still making the output useful. [citation:1]

### 2. Repository intelligence

Designed repository knowledge refresh and semantic analysis that reconcile current code into reusable Project Facts. This preserves a current, searchable view of the implementation without forcing every chat turn to scan the repository. [citation:2]

### 3. Grounded project agent

Implemented multi-turn project chat using retrieval, citations, and bounded research when memory is insufficient. The separation allows common questions to stay fast while still supporting code-level investigation. [citation:3]

### 4. Durable AI platform

Combined Bedrock structured generation with durable workflow orchestration and explicit retry boundaries. This ensures long-running AI work can recover without losing progress or silently inventing unsupported results. [citation:4]`;

describe("project-chat answer quality contracts", () => {
  it("recognizes reader-facing themes, primary items, and developed blocks", () => {
    expect(projectChatPrimaryAnswerItems(strongAnswer)).toBe(4);
    expect(projectChatReaderThemes(strongAnswer)).toEqual(expect.arrayContaining([
      "product_outcome",
      "repository_intelligence",
      "grounded_agent",
      "knowledge_governance",
      "durable_ai_platform",
    ]));
    expect(splitProjectChatPrimaryAnswerItems(strongAnswer)).toHaveLength(4);

    const checks = evaluateProjectChatAnswerQuality({
      answer: strongAnswer,
      contract: {
        minCharacters: 600,
        minReaderThemes: 4,
        minPrimaryItems: 4,
        maxPrimaryItems: 6,
        minDevelopedItems: 4,
        minMechanismValueItems: 3,
        requirePrioritizedOpening: true,
        format: "markdown",
      },
    });
    expect(checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("rejects the exact user-visible verifier failure and internal coverage bookkeeping", () => {
    const checks = evaluateProjectChatAnswerQuality({
      answer: "The answer could not be verified against its sources.\n\nCoverage note: 2 additional supported facets were omitted.",
      contract: { minCharacters: 20, forbidInternalInventory: true },
    });
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "answer does not expose an internal verification or agent failure",
      "answer does not expose internal coverage bookkeeping or schema inventory",
    ]);
  });

  it("rejects broad answers that are shallow, exhaustive, and led by low-value implementation detail", () => {
    const answer = `## Details

### RepositoryCapabilityLedger
The RepositoryCapabilityLedger stores analyzerVersion and policyVersion.

### RepositoryFileSnapshot
The RepositoryFileSnapshot stores semanticAnalysisVersion.

### Database
Prisma persists fields.

### Tests
Vitest exists.

### UI
The workspace has pages.

### Routes
Next.js contains routes.

### Types
TypeScript defines types.

### Utilities
There are utility functions.`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: {
        minCharacters: 500,
        minReaderThemes: 4,
        maxPrimaryItems: 6,
        minDevelopedItems: 3,
        minMechanismValueItems: 2,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
      },
    });
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(expect.arrayContaining([
      "answer does not expose internal coverage bookkeeping or schema inventory",
      "answer covers enough reader-facing project themes in developed claims",
      "answer avoids an exhaustive subsystem inventory",
      "answer develops its major points",
      "answer connects implementation mechanisms to their value",
      "answer opens with a developed, high-value capability and explains why it matters",
    ]));
  });

  it("rejects keyword inventories even when they contain every expected theme and citation", () => {
    const answer = `## Strongest accomplishments

### 1. Product
Career content, resume bullets, artifact pipeline, repository intelligence, project chat, retrieval, citations, Project Facts, approved Highlights, Bedrock, durable workflow, Prisma, PostgreSQL, test coverage, GitHub OAuth, semantic analysis, review lifecycle, provenance. [citation:1]

### 2. Repository
Career content, resume bullets, artifact pipeline, repository intelligence, project chat, retrieval, citations, Project Facts, approved Highlights, Bedrock, durable workflow, Prisma, PostgreSQL, test coverage, GitHub OAuth, semantic analysis, review lifecycle, provenance. [citation:2]

### 3. Agent
Career content, resume bullets, artifact pipeline, repository intelligence, project chat, retrieval, citations, Project Facts, approved Highlights, Bedrock, durable workflow, Prisma, PostgreSQL, test coverage, GitHub OAuth, semantic analysis, review lifecycle, provenance. [citation:3]

### 4. Platform
Career content, resume bullets, artifact pipeline, repository intelligence, project chat, retrieval, citations, Project Facts, approved Highlights, Bedrock, durable workflow, Prisma, PostgreSQL, test coverage, GitHub OAuth, semantic analysis, review lifecycle, provenance. [citation:4]`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: {
        minReaderThemes: 5,
        minPrimaryItems: 4,
        minDevelopedItems: 4,
        minMechanismValueItems: 3,
        minCitedItems: 4,
        requirePrioritizedOpening: true,
      },
    });
    expect(checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "answer develops its major points",
        "answer connects implementation mechanisms to their value",
        "answer presents substantively distinct major points",
        "answer opens with a developed, high-value capability and explains why it matters",
      ]),
    );
  });

  it("rejects separately formatted but substantively redundant major points", () => {
    const repeated = "Built a repository-backed career content pipeline by routing evidence through approved Highlights, which ensures generated artifacts retain source provenance and remain useful to hiring teams.";
    const answer = `## Strongest accomplishments

### 1. Product delivery
${repeated} [citation:1]

### 2. Repository intelligence
${repeated} [citation:2]

### 3. Grounded agent
${repeated} [citation:3]

### 4. Durable AI platform
${repeated} [citation:4]`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: {
        minReaderThemes: 4,
        minPrimaryItems: 4,
        minDevelopedItems: 4,
        minMechanismValueItems: 4,
        minCitedItems: 4,
      },
    });
    expect(checks.find((check) =>
      check.name === "answer presents substantively distinct major points",
    )).toMatchObject({ passed: false, actual: 1, expected: 4 });
  });

  it("recognizes a selection-and-reuse workflow followed by its explicit value", () => {
    const answer = `### Career Content Product & Trustworthy Artifact Pipeline
- The workflow reviews resume branches and selects the closest existing variant for the job description.
- It favors constrained edits; when a new variant is justified, it reuses an existing branch and edits main.tex minimally.

**Why it matters:** This keeps career output tied to reviewed project knowledge without uncontrolled rewrites. [citation:1]`;

    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: {
        minPrimaryItems: 1,
        minDevelopedItems: 1,
        minMechanismValueItems: 1,
        minCitedItems: 1,
      },
    });

    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("rejects a low-value opening even when higher-value keywords occur soon afterward", () => {
    const answer = `## Architecture assessment

### 1. Prisma field layout
The data model uses Prisma fields and schema relations to persist records, which enables normalized storage for the application and keeps database writes connected across tables. [citation:1]

### 2. Career-content product
Workbase turns repository evidence into career artifacts by routing approved Highlights into generation, which keeps resume output grounded in reviewed project work. [citation:2]

### 3. Repository intelligence
Semantic refresh reconciles current code into Project Facts, which enables future chat answers to reuse current repository knowledge without rescanning every file. [citation:3]`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: {
        minReaderThemes: 3,
        minPrimaryItems: 3,
        minDevelopedItems: 3,
        minMechanismValueItems: 3,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
      },
    });
    expect(checks.find((check) =>
      check.name === "answer opens with a developed, high-value capability and explains why it matters",
    )?.passed).toBe(false);
  });

  it("verifies that every claim-local citation resolves and aligns with supplied source metadata", () => {
    const metadata = [
      {
        ordinal: 1,
        type: "highlight",
        title: "Career-content generation from reviewed repository evidence",
        statement: "Approved Highlights support grounded resume bullets and project summaries.",
      },
      {
        ordinal: 2,
        type: "project_fact",
        title: "Repository semantic refresh and Project Fact reconciliation",
        statement: "Current code is reconciled into reusable Project Facts with provenance.",
      },
      {
        ordinal: 3,
        type: "project_fact",
        title: "Multi-turn project chat with retrieval and bounded research",
        statement: "Project chat retrieves durable memory and researches only a specific evidence gap.",
      },
      {
        ordinal: 4,
        type: "project_fact",
        title: "Bedrock structured generation and durable workflow recovery",
        statement: "Retry-safe workflow boundaries preserve progress around structured generation.",
      },
    ];
    const passing = evaluateProjectChatAnswerQuality({
      answer: strongAnswer,
      contract: {
        minReaderThemes: 4,
        minPrimaryItems: 4,
        minDevelopedItems: 4,
        minCitedItems: 4,
      },
      citationMetadata: metadata,
    });
    expect(passing.filter((check) => !check.passed)).toEqual([]);

    const unrelatedMetadata = metadata.map((source) => ({
      ...source,
      title: "Color palette and typography settings",
      statement: "The interface uses a teal accent and a sans-serif font.",
    }));
    const failing = evaluateProjectChatAnswerQuality({
      answer: strongAnswer,
      contract: {
        minReaderThemes: 4,
        minPrimaryItems: 4,
        minDevelopedItems: 4,
        minCitedItems: 4,
      },
      citationMetadata: unrelatedMetadata.slice(0, 3),
    });
    expect(failing.find((check) =>
      check.name === "all citation markers resolve to supplied source metadata",
    )).toMatchObject({ passed: false, actual: 3, expected: 4 });
    expect(failing.find((check) =>
      check.name === "claim-local citations are supported by their source metadata",
    )).toMatchObject({ passed: false, actual: 0, expected: 4 });
  });

  it("does not let a topical citation support an uncited exact metric or code identifier", () => {
    const answer = `## Durable runtime

The durable Bedrock workflow uses \`retryAgentRun\` to guarantee 99.99% production availability, which ensures every agent response survives provider failures. [citation:1]`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: { minCitedItems: 1 },
      citationMetadata: [{
        ordinal: 1,
        type: "project_fact",
        title: "Durable Bedrock workflow recovery",
        statement: "Persisted agent runs support bounded retry after provider failures.",
      }],
    });
    expect(checks.find((check) =>
      check.name === "claim-local citations are supported by their source metadata",
    )).toMatchObject({ passed: false, actual: 0, expected: 1 });
  });

  it("enforces exact item counts without mistaking a generic title for an item", () => {
    const answer = `## Workbase

1. Product outcome through reviewed artifacts.
2. Repository intelligence through semantic refresh.
3. Grounded agent through citation-backed memory.`;
    const checks = evaluateProjectChatAnswerQuality({
      answer,
      contract: { exactPrimaryItems: 3 },
    });
    expect(checks.find((check) => check.name.includes("exact requested"))?.passed).toBe(true);
    expect(evaluateProjectChatAnswerQuality({
      answer: `${answer}\n4. Data model.`,
      contract: { exactPrimaryItems: 3 },
    }).find((check) => check.name.includes("exact requested"))?.passed).toBe(false);
    expect(projectChatPrimaryAnswerItems(`## Top three accomplishments

### Product outcome
Developed point one.

### Repository intelligence
Developed point two.

### Grounded agent
Developed point three.`)).toBe(3);
  });

  it("distinguishes paragraph and table format contracts", () => {
    const paragraphs = "Workbase turns repository evidence into reviewed project memory. It uses semantic refresh so answers stay current.\n\nThe grounded chat layer retrieves that memory and uses bounded research only when needed.";
    expect(evaluateProjectChatAnswerQuality({
      answer: paragraphs,
      contract: { format: "paragraphs" },
    }).every((check) => check.passed)).toBe(true);
    expect(evaluateProjectChatAnswerQuality({
      answer: `- ${paragraphs}`,
      contract: { format: "paragraphs" },
    }).some((check) => !check.passed)).toBe(true);

    const table = "| Path | Best for |\n| --- | --- |\n| Refresh | Broad currency |\n| Research | A focused code gap |";
    expect(evaluateProjectChatAnswerQuality({
      answer: table,
      contract: { format: "table" },
    }).every((check) => check.passed)).toBe(true);
    expect(evaluateProjectChatAnswerQuality({
      answer: "| Path | Best for |\n| Refresh | Broad currency |",
      contract: { format: "table" },
    }).some((check) => !check.passed)).toBe(true);
  });
});
