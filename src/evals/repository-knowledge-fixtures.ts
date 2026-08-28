import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryEvaluationFile,
  type RepositoryExpectedCapability,
  type RepositoryExpectedDomain,
  type RepositoryKnowledgeBudget,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";

function files(paths: string[]): RepositoryEvaluationFile[] {
  return paths.map((path) => ({ path }));
}

function capability(
  input: Omit<RepositoryExpectedCapability, "importance" | "implementationState" | "expectedInHighlights"> &
    Partial<Pick<RepositoryExpectedCapability, "importance" | "implementationState" | "expectedInHighlights">>,
): RepositoryExpectedCapability {
  return {
    importance: "major",
    implementationState: "implemented",
    expectedInHighlights: true,
    ...input,
  };
}

function domain(input: RepositoryExpectedDomain): RepositoryExpectedDomain {
  return input;
}

function budget(size: "small" | "medium" | "large"): RepositoryKnowledgeBudget {
  if (size === "small") {
    return {
      maximumDurationMs: 180_000,
      maximumModelCalls: 20,
      maximumTokens: 80_000,
      maximumEstimatedCostUsd: 0.75,
    };
  }
  if (size === "medium") {
    return {
      maximumDurationMs: 300_000,
      maximumModelCalls: 36,
      maximumTokens: 160_000,
      maximumEstimatedCostUsd: 1.5,
    };
  }
  return {
    maximumDurationMs: 480_000,
    maximumModelCalls: 56,
    maximumTokens: 280_000,
    maximumEstimatedCostUsd: 2.5,
  };
}

const commonIgnoredPathPatterns = [
  "(?:^|/)(?:node_modules|dist|build|coverage|target|vendor|__pycache__)(?:/|$)",
  "(?:^|/)(?:\\.next|\\.workflow-data|\\.playwright-cli|\\.nyc_output|\\.idea)(?:/|$)",
  "(?:^|/)test/resources/(?:archives|fixtures?)(?:/|$)",
  "\\.(?:jar|zip|png|jpe?g|gif|ico|pdf|lock|map)$",
] as const;

function ignoredPaths(...extra: string[]) {
  return [...commonIgnoredPathPatterns, ...extra];
}

/**
 * These are compact, deterministic snapshots of repository shapes, not golden
 * prose. Match expressions deliberately allow different taxonomies and wording.
 * The first six profiles are based on public repository trees at the recorded
 * commit; the CLI can check those paths for drift before a live comparison.
 */
export const repositoryKnowledgeFixtures = [
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "backer-marketplace",
    title: "Backer founder and investor marketplace",
    repository: "arkb75/Backer",
    sourceKind: "curated_real_repository",
    snapshotCommit: "b5e8e6574545475420b7d51f3b7c50e2a3602e5c",
    archetype: "saas-marketplace",
    languages: ["TypeScript"],
    description: "A role-aware marketplace with onboarding, discovery, engagement, messaging, and AWS-backed persistence.",
    files: files([
      "README.md",
      "app/api/onboarding/founder/route.ts",
      "app/api/onboarding/investor/route.ts",
      "app/api/investments/commit/route.ts",
      "app/api/messages/send/route.ts",
      "app/api/company/invite/route.ts",
      "app/api/feed/events/route.ts",
      "lib/feed/ranking.ts",
      "lib/feed/model.ts",
      "lib/db/repository.ts",
      "scripts/train-feed-model.ts",
      ".playwright-cli/session.json",
      ".next/cache/webpack/client.pack",
    ]),
    ignoredPathPatterns: ignoredPaths("lib/feed/model/feed-model\\.json$"),
    expectedDomains: [
      domain({ key: "identity", label: "Identity and onboarding", matchPatterns: ["auth|identity|onboard|profile"], evidencePathPatterns: ["onboarding|auth|profile"] }),
      domain({ key: "discovery", label: "Marketplace discovery", matchPatterns: ["marketplace|feed|discover|rank|match"], evidencePathPatterns: ["feed|ranking|product"] }),
      domain({ key: "engagement", label: "Founder and investor engagement", matchPatterns: ["invest|commit|message|invite|engagement"], evidencePathPatterns: ["investment|message|invite|interest"] }),
    ],
    expectedCapabilities: [
      capability({ key: "role_onboarding", label: "Founder and investor onboarding", domainKey: "identity", matchPatterns: ["founder.{0,40}investor.{0,40}onboard|role.{0,20}onboard|founder onboarding|investor onboarding"], evidencePathPatterns: ["app/api/onboarding/(?:founder|investor)/route\\.ts"], exampleClaim: "Implemented separate founder and investor onboarding flows with role-specific profiles." }),
      capability({ key: "ranked_feed", label: "Trainable investor feed ranking", domainKey: "discovery", matchPatterns: ["(?:train|model|logistic|heuristic).{0,50}(?:feed|rank)|(?:feed|startup).{0,40}(?:rank|relevance)"], evidencePathPatterns: ["lib/feed/(?:ranking|model)\\.ts|scripts/train-feed-model\\.ts"], exampleClaim: "Built a trainable investor feed ranker with a deterministic fallback." }),
      capability({ key: "investment_commitment", label: "Investment interest and commitment workflow", domainKey: "engagement", matchPatterns: ["invest(?:ment|or).{0,40}(?:commit|interest)|commitment workflow"], evidencePathPatterns: ["app/api/investments/commit/route\\.ts|app/api/interest"] , exampleClaim: "Implemented investor interest and investment commitment workflows." }),
      capability({ key: "messaging", label: "Founder-investor messaging", domainKey: "engagement", matchPatterns: ["founder.{0,30}investor.{0,30}messag|conversation|messaging"], evidencePathPatterns: ["app/api/messages/"], exampleClaim: "Delivered founder-investor conversations and message sending." }),
      capability({ key: "cofounder_invites", label: "Co-founder invitation flow", domainKey: "engagement", importance: "supporting", matchPatterns: ["co.?founder.{0,30}invit|company invitation"], evidencePathPatterns: ["app/api/company/invite/route\\.ts|app/api/invitations/"], exampleClaim: "Added co-founder invitations with an invitation response flow." }),
      capability({ key: "dynamodb_repository", label: "DynamoDB repository layer", domainKey: "identity", importance: "supporting", expectedInHighlights: false, matchPatterns: ["dynamodb.{0,40}(?:repository|persistence|data)|repository layer.{0,30}dynamodb"], evidencePathPatterns: ["lib/db/repository\\.ts|README\\.md"], exampleClaim: "Uses a DynamoDB repository layer for the application runtime." }),
    ],
    falsePositiveTraps: [
      {
        label: "A data model filename alone is not an AI runtime",
        capabilityPatterns: ["ai[_ -]?runtime|llm|generative ai"],
        misleadingEvidencePathPatterns: ["lib/feed/model\\.ts|lib/db/"],
        allowedEvidencePathPatterns: ["scripts/train-feed-model\\.ts|lib/feed/ranking\\.ts"],
      },
    ],
    budget: budget("medium"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "solopilot-agent-documents",
    title: "SoloPilot client-to-codebase agent workflow",
    repository: "arkb75/SoloPilot",
    sourceKind: "curated_real_repository",
    snapshotCommit: "46477b744db2aa61c53763c4832cad1b239e8ce5",
    archetype: "agent-document-platform",
    languages: ["Python", "TypeScript", "JavaScript"],
    description: "A polyglot AI workflow for email intake, proposal review, document versioning, and future planning exports.",
    files: files([
      "README.md",
      "src/agents/email_intake/conversational_responder.py",
      "src/agents/email_intake/metadata_extractor.py",
      "src/agents/email_intake/requirement_extractor.py",
      "src/agents/email_intake/pdf_generator.py",
      "src/agents/email_intake/vision_analyzer.py",
      "src/agents/email_intake/reviewer.py",
      "src/agents/email_intake/response_reviser.py",
      "src/providers/base.py",
      "frontend/email-intake/src/components/PDFAnnotator.tsx",
      "frontend/email-intake/src/components/ReplyEditor.tsx",
      "docs/PROGRESSIVE_CONTEXT.md",
      ".workflow-data/runs/local.json",
      ".playwright-cli/session.json",
    ]),
    ignoredPathPatterns: ignoredPaths(),
    expectedDomains: [
      domain({ key: "intake", label: "Client intake", matchPatterns: ["email|client|intake|requirement|metadata"], evidencePathPatterns: ["email_intake|Conversation"] }),
      domain({ key: "proposals", label: "Proposal documents", matchPatterns: ["proposal|pdf|document|annotation|vision"], evidencePathPatterns: ["pdf|PDF|vision"] }),
      domain({ key: "quality", label: "AI quality and review", matchPatterns: ["review|revis|evaluat|human.{0,20}loop|provider"], evidencePathPatterns: ["reviewer|reviser|provider|ReplyEditor"] }),
    ],
    expectedCapabilities: [
      capability({ key: "email_intake", label: "Conversational email intake", domainKey: "intake", matchPatterns: ["(?:email|client).{0,30}(?:intake|conversation)|conversation.{0,30}email"], evidencePathPatterns: ["conversational_responder\\.py|email_intake"], exampleClaim: "Built conversational email intake that turns client threads into managed project context." }),
      capability({ key: "metadata_requirements", label: "Metadata and requirement extraction", domainKey: "intake", matchPatterns: ["metadata.{0,30}requirement|requirement.{0,30}extract|extract.{0,30}(?:budget|timeline|client)"], evidencePathPatterns: ["metadata_extractor\\.py|requirement_extractor\\.py"], exampleClaim: "Implemented metadata and requirement extraction for client conversations." }),
      capability({ key: "versioned_proposals", label: "Versioned proposal PDF workflow", domainKey: "proposals", matchPatterns: ["proposal.{0,30}(?:pdf|version)|versioned.{0,30}(?:pdf|proposal)|pdf.{0,30}proposal"], evidencePathPatterns: ["pdf_generator\\.py|ProposalViewer|README\\.md"], exampleClaim: "Delivered proposal PDF rendering with versioned storage and revision history." }),
      capability({ key: "vision_annotation", label: "Vision-assisted PDF annotation", domainKey: "proposals", matchPatterns: ["(?:vision|visual).{0,30}(?:pdf|annotation|feedback)|pdf.{0,30}annotat"], evidencePathPatterns: ["vision_analyzer\\.py|PDFAnnotator\\.tsx"], exampleClaim: "Integrated vision feedback into direct PDF proposal annotation." }),
      capability({ key: "evaluator_reviser", label: "Evaluator-reviser response loop", domainKey: "quality", matchPatterns: ["evaluat.{0,30}revis|reviewer.{0,30}reviser|quality.{0,30}(?:score|loop)"], evidencePathPatterns: ["reviewer\\.py|response_reviser\\.py"], exampleClaim: "Built an evaluator-reviser loop that scores and improves drafted responses." }),
      capability({ key: "human_review", label: "Human approval workflow", domainKey: "quality", importance: "supporting", matchPatterns: ["human.{0,30}(?:review|approval|loop)|approve.{0,20}reject.{0,20}edit"], evidencePathPatterns: ["ReplyEditor\\.tsx|reviewer\\.py|README\\.md"], exampleClaim: "Added human approve, reject, and edit controls around generated work." }),
      capability({ key: "provider_abstraction", label: "Provider-neutral LLM layer", domainKey: "quality", importance: "supporting", expectedInHighlights: false, matchPatterns: ["provider.{0,20}(?:agnostic|neutral|abstraction)|swap.{0,30}(?:bedrock|openai)"], evidencePathPatterns: ["src/providers/|README\\.md"], exampleClaim: "Uses a provider-neutral model interface across Bedrock and OpenAI." }),
      capability({ key: "prd_export", label: "PRD generation and IDE export", domainKey: "proposals", implementationState: "planned", expectedInHighlights: false, matchPatterns: ["prd|ide.{0,20}export|cursor.{0,20}export|plan generation"], evidencePathPatterns: ["README\\.md|src/agents/planning|src/agents/export"], exampleClaim: "PRD generation and IDE export are documented as in progress, not delivered." }),
    ],
    falsePositiveTraps: [],
    budget: budget("large"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "circlefund-fintech",
    title: "CircleFund lending-circle workflow",
    repository: "arkb75/CircleFund",
    sourceKind: "curated_real_repository",
    snapshotCommit: "22d1968ff13f649ad6ce06a07714b3ecc279121f",
    archetype: "fintech-group-workflow",
    languages: ["TypeScript", "SQL"],
    description: "A small finance-oriented application where a good extractor must cover auth, group governance, and contributions without inventing future loans.",
    files: files([
      "README.md",
      "prisma/schema.prisma",
      "src/app/api/v1/auth/signup/route.ts",
      "src/app/api/v1/auth/login/route.ts",
      "src/app/api/v1/circles/route.ts",
      "src/app/api/v1/circles/join/route.ts",
      "src/app/api/v1/circles/[circleId]/contributions/route.ts",
      "src/server/data/circle-repository.ts",
      "src/server/services/circle-onboarding-service.ts",
      "src/server/services/contribution-service.ts",
      "src/server/services/contribution-analytics.ts",
      "src/components/circle/contribution-workspace.tsx",
      ".agents/skills/neon-postgres/SKILL.md",
      "public/next.svg",
    ]),
    ignoredPathPatterns: ignoredPaths("(?:^|/)\\.agents/skills/", "(?:^|/)public/(?:next|vercel|globe|file|window)\\.svg$"),
    expectedDomains: [
      domain({ key: "access", label: "Account access", matchPatterns: ["auth|account|session|login|signup"], evidencePathPatterns: ["auth|session"] }),
      domain({ key: "circle_governance", label: "Circle membership and governance", matchPatterns: ["circle|member|invite|governance|approval"], evidencePathPatterns: ["circle|schema"] }),
      domain({ key: "contributions", label: "Contribution operations", matchPatterns: ["contribution|period|payment|analytics"], evidencePathPatterns: ["contribution"] }),
    ],
    expectedCapabilities: [
      capability({ key: "account_session", label: "Account and signed session flow", domainKey: "access", matchPatterns: ["(?:account|signup|login).{0,40}(?:session|cookie|auth)|signed.{0,20}session"], evidencePathPatterns: ["src/app/api/v1/auth/|src/lib/session\\.ts"], exampleClaim: "Implemented account signup and login with a signed cookie-backed session." }),
      capability({ key: "circle_onboarding", label: "Circle creation and invite joining", domainKey: "circle_governance", matchPatterns: ["circle.{0,35}(?:creat|join|invite)|invite.{0,20}circle"], evidencePathPatterns: ["src/app/api/v1/circles/(?:route|join/route)\\.ts|circle-onboarding-service\\.ts"], exampleClaim: "Built authenticated circle creation and invite-code joining." }),
      capability({ key: "circle_rules", label: "Contribution and approval rules", domainKey: "circle_governance", importance: "supporting", matchPatterns: ["circle.{0,25}(?:rule|approval)|contribution.{0,25}(?:frequency|rule)"], evidencePathPatterns: ["prisma/schema\\.prisma|circle-repository\\.ts"], exampleClaim: "Persisted circle contribution rules and approval modes with membership state." }),
      capability({ key: "contribution_workflow", label: "Contribution recording workflow", domainKey: "contributions", matchPatterns: ["(?:record|submit|manage).{0,30}contribution|contribution.{0,30}(?:workflow|period|payment)"], evidencePathPatterns: ["contributions/route\\.ts|contribution-service\\.ts|contribution-workspace\\.tsx"], exampleClaim: "Delivered contribution recording across API, service, and workspace layers." }),
      capability({ key: "contribution_analytics", label: "Contribution analytics", domainKey: "contributions", matchPatterns: ["contribution.{0,25}analytic|analytic.{0,25}contribution|payment.{0,25}(?:summary|status)"], evidencePathPatterns: ["contribution-analytics\\.ts"], exampleClaim: "Added contribution analytics for the circle dashboard." }),
      capability({ key: "loan_repayment", label: "Loan and repayment lifecycle", domainKey: "contributions", implementationState: "planned", expectedInHighlights: false, matchPatterns: ["loan|repayment|disbursement"], evidencePathPatterns: ["README\\.md|prisma/schema\\.prisma"], exampleClaim: "Loan and repayment models are future extensions rather than implemented flows." }),
    ],
    falsePositiveTraps: [
      {
        label: "Prisma models are not an AI model runtime",
        capabilityPatterns: ["ai[_ -]?runtime|llm|model inference"],
        misleadingEvidencePathPatterns: ["prisma/schema\\.prisma|src/server/data/"],
      },
    ],
    budget: budget("small"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "workbase-project-knowledge",
    title: "Workbase repository knowledge platform",
    repository: "arkb75/Workbase",
    sourceKind: "curated_real_repository",
    snapshotCommit: "e470dcb3534ee8eb9c0c1030a4a58adc9c25f404",
    archetype: "developer-knowledge-platform",
    languages: ["TypeScript", "SQL"],
    description: "A developer tool with ingestion, repository analysis, reviewed knowledge, grounded chat, and artifact generation; it receives no special scorer rules.",
    files: files([
      "README.md",
      "src/services/github-repo-import-service.ts",
      "src/services/knowledge-refresh-service.ts",
      "src/services/repository-semantic-orchestrator-service.ts",
      "src/services/repository-knowledge-synthesis-service.ts",
      "src/services/knowledge-reconciliation-service.ts",
      "src/services/knowledge-review-service.ts",
      "src/services/project-chat-agent-service.ts",
      "src/services/project-answer-grounding-service.ts",
      "src/services/artifact-generation-service.ts",
      "workflows/project-chat.ts",
      "app/work-items/[id]/page.tsx",
      ".workflow-data/runs/local.json",
      ".playwright-cli/session.json",
    ]),
    ignoredPathPatterns: ignoredPaths(),
    expectedDomains: [
      domain({ key: "ingestion", label: "Repository ingestion", matchPatterns: ["github|repository|import|snapshot|commit"], evidencePathPatterns: ["github|knowledge-refresh"] }),
      domain({ key: "knowledge", label: "Project knowledge lifecycle", matchPatterns: ["knowledge|highlight|fact|review|reconcil|stale"], evidencePathPatterns: ["knowledge|highlight"] }),
      domain({ key: "assistant", label: "Grounded project assistant", matchPatterns: ["chat|assistant|ground|citation|research"], evidencePathPatterns: ["project-chat|grounding"] }),
      domain({ key: "artifacts", label: "Artifact output", matchPatterns: ["artifact|resume|linkedin|project summary"], evidencePathPatterns: ["artifact"] }),
    ],
    expectedCapabilities: [
      capability({ key: "commit_inventory", label: "Commit-pinned repository inventory", domainKey: "ingestion", matchPatterns: ["commit.?pinned|repository.{0,30}(?:snapshot|inventory)|github.{0,25}import"], evidencePathPatterns: ["github-repo-import-service\\.ts|knowledge-refresh-service\\.ts"], exampleClaim: "Built commit-pinned repository import and bounded file inventory." }),
      capability({ key: "semantic_synthesis", label: "Repository knowledge synthesis", domainKey: "knowledge", matchPatterns: ["semantic.{0,30}(?:analysis|synthesis)|repository.{0,25}(?:fact|highlight|knowledge)|synthesi[sz].{0,30}(?:fact|highlight)"], evidencePathPatterns: ["repository-semantic-orchestrator-service\\.ts|repository-knowledge-synthesis-service\\.ts"], exampleClaim: "Implemented repository analysis that synthesizes evidence-backed facts and highlights." }),
      capability({ key: "knowledge_lifecycle", label: "Review and staleness lifecycle", domainKey: "knowledge", matchPatterns: ["(?:review|stale|supersed|reconcil).{0,35}(?:fact|highlight|knowledge)|knowledge.{0,30}(?:review|lifecycle|stale)"], evidencePathPatterns: ["knowledge-review-service\\.ts|knowledge-reconciliation-service\\.ts|knowledge-staleness"] , exampleClaim: "Added review, supersession, and staleness handling for durable project knowledge." }),
      capability({ key: "grounded_chat", label: "Grounded project chat", domainKey: "assistant", matchPatterns: ["(?:ground|citation|evidence).{0,35}(?:chat|answer)|project.{0,20}chat|chat.{0,30}(?:citation|research)"], evidencePathPatterns: ["project-chat-agent-service\\.ts|project-answer-grounding-service\\.ts|workflows/project-chat\\.ts"], exampleClaim: "Delivered multi-turn project chat with claim-local citations and bounded repository research." }),
      capability({ key: "artifact_generation", label: "Reviewed artifact generation", domainKey: "artifacts", matchPatterns: ["approved.{0,25}highlight.{0,35}artifact|artifact.{0,30}(?:resume|linkedin|highlight)|resume.{0,25}generat"], evidencePathPatterns: ["artifact-generation-service\\.ts|README\\.md"], exampleClaim: "Generates career artifacts from approved, provenance-backed highlights." }),
      capability({ key: "durable_workflows", label: "Durable workflow recovery", domainKey: "assistant", importance: "supporting", matchPatterns: ["durable.{0,30}(?:workflow|recover|resume)|workflow.{0,30}(?:retry|resume|recover)"], evidencePathPatterns: ["workflows/project-chat\\.ts"], exampleClaim: "Uses durable workflow boundaries for resumable repository and chat operations." }),
    ],
    falsePositiveTraps: [],
    budget: budget("large"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "insightubc-dataset-platform",
    title: "InsightUBC dataset query platform",
    repository: "arkb75/InsightUBC",
    sourceKind: "curated_real_repository",
    snapshotCommit: "ffbe87899d191ec72191fbf796852960581105e3",
    archetype: "dataset-query-application",
    languages: ["TypeScript", "JavaScript"],
    description: "A previously untested full-stack dataset processor with archive ingestion, a query language, REST endpoints, and visualization.",
    files: files([
      "README.md",
      "src/controller/InsightFacade.ts",
      "src/controller/RoomsProcessor.ts",
      "src/controller/SectionModel.ts",
      "src/controller/query/QueryParser.ts",
      "src/controller/query/QueryExecutor.ts",
      "src/controller/query/Calculations.ts",
      "src/rest/Server.ts",
      "frontend/insightubc/src/components/AddDataset.js",
      "frontend/insightubc/src/components/ListDataset.js",
      "frontend/insightubc/src/components/Insights.js",
      "test/controller/InsightFacade.spec.ts",
      "test/controller/QueryParser.spec.ts",
      ".nyc_output/processinfo/index.json",
      "test/resources/archives/campus.zip",
    ]),
    ignoredPathPatterns: ignoredPaths(),
    expectedDomains: [
      domain({ key: "datasets", label: "Dataset lifecycle", matchPatterns: ["dataset|zip|archive|upload|remove"], evidencePathPatterns: ["InsightFacade|AddDataset|ListDataset"] }),
      domain({ key: "query", label: "Query parsing and execution", matchPatterns: ["query|filter|group|sort|calculation"], evidencePathPatterns: ["query/|QueryParser|QueryExecutor"] }),
      domain({ key: "experience", label: "REST and visualization experience", matchPatterns: ["rest|api|visual|chart|insight"], evidencePathPatterns: ["rest/Server|components/Insights"] }),
    ],
    expectedCapabilities: [
      capability({ key: "dataset_lifecycle", label: "ZIP dataset validation and lifecycle", domainKey: "datasets", matchPatterns: ["(?:zip|archive).{0,30}(?:dataset|valid)|dataset.{0,30}(?:add|upload|remove|list)"], evidencePathPatterns: ["InsightFacade\\.ts|AddDataset\\.js|ListDataset\\.js"], exampleClaim: "Implemented ZIP dataset validation plus add, list, and remove operations." }),
      capability({ key: "query_engine", label: "Validated query parser and executor", domainKey: "query", matchPatterns: ["query.{0,30}(?:pars|execut|valid)|(?:pars|execut).{0,25}query"], evidencePathPatterns: ["QueryParser\\.ts|QueryExecutor\\.ts"], exampleClaim: "Built a validated query parser and executor for dataset analysis." }),
      capability({ key: "query_calculations", label: "Grouped dataset calculations", domainKey: "query", importance: "supporting", matchPatterns: ["(?:group|average|aggregate|calculation).{0,35}(?:dataset|query|course)|query.{0,30}(?:group|aggregate|average)"], evidencePathPatterns: ["Calculations\\.ts|QueryExecutor\\.ts"], exampleClaim: "Added grouping, sorting, and aggregate calculations to the query engine." }),
      capability({ key: "rest_api", label: "Dataset REST API", domainKey: "experience", matchPatterns: ["rest.{0,20}(?:api|endpoint)|(?:get|put|delete|post).{0,30}(?:dataset|query)|dataset.{0,20}api"], evidencePathPatterns: ["src/rest/Server\\.ts"], exampleClaim: "Exposed dataset lifecycle and query execution through a REST API." }),
      capability({ key: "visual_insights", label: "Interactive insight visualization", domainKey: "experience", matchPatterns: ["(?:visual|chart|graph).{0,30}(?:insight|dataset)|interactive.{0,25}insight"], evidencePathPatterns: ["components/Insights\\.js"], exampleClaim: "Delivered parameterized insights with interactive chart visualization." }),
      capability({ key: "future_experience", label: "CSV, broader visualization, loading, caching, and history enhancements", domainKey: "datasets", implementationState: "planned", expectedInHighlights: false, matchPatterns: ["csv|cache.{0,20}history|user.{0,20}history|loading state|broader.{0,20}visual|different.{0,20}visual"], evidencePathPatterns: ["README\\.md"], exampleClaim: "CSV, broader visualizations, loading state, caching, and user history are future enhancements." }),
    ],
    falsePositiveTraps: [
      {
        label: "A TypeScript Model class is not an AI runtime",
        capabilityPatterns: ["ai[_ -]?runtime|llm|model inference"],
        misleadingEvidencePathPatterns: ["src/controller/(?:Room|Section)Model\\.ts"],
      },
      {
        label: "A generic REST API is not an ingestion integration",
        capabilityPatterns: ["ingestion[_ -]?integration|source ingestion|external connector"],
        misleadingEvidencePathPatterns: ["src/rest/Server\\.ts"],
        allowedEvidencePathPatterns: ["InsightFacade\\.ts|AddDataset\\.js"],
      },
    ],
    budget: budget("medium"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "amazon-marketplace-analytics",
    title: "Amazon Marketplace Analytics desktop and ML service",
    repository: "arkb75/Amazon-Marketplace-Analytic-Software",
    sourceKind: "curated_real_repository",
    snapshotCommit: "dc7a5e854e69f34edba0b77dd9be04f981414b54",
    archetype: "java-data-ml-backend",
    languages: ["Java", "Python", "JSON"],
    description: "A previously untested Java desktop analytics application backed by JSON persistence and a Python forecasting service.",
    files: files([
      "README.md",
      "src/main/model/ProductDetails.java",
      "src/main/model/ProductPerformance.java",
      "src/main/model/PurchaseOrders.java",
      "src/main/persistence/DataLoader.java",
      "src/main/persistence/DataWriter.java",
      "src/main/service/ForecastClient.java",
      "src/main/ui/MainMenu.java",
      "src/main/ui/ForecastPanel.java",
      "ml_service/forecast_service.py",
      "src/test/persistence/DataLoaderTest.java",
      "src/test/model/ProductPerformanceListTest.java",
      ".idea/workspace.xml",
      "AmazonAnalytics.jar",
      "lib/junit-jupiter-5.4.2.jar",
      "data/tobs.jpg",
    ]),
    ignoredPathPatterns: ignoredPaths("(?:^|/)data/.*\\.(?:json|jpg)$"),
    expectedDomains: [
      domain({ key: "inventory", label: "Marketplace inventory data", matchPatterns: ["product|purchase|inventory|sales|performance"], evidencePathPatterns: ["model/|persistence/"] }),
      domain({ key: "forecasting", label: "Demand forecasting", matchPatterns: ["forecast|prophet|prediction|seasonality"], evidencePathPatterns: ["forecast|Forecast"] }),
      domain({ key: "desktop", label: "Desktop analytics experience", matchPatterns: ["swing|desktop|panel|menu|analytics"], evidencePathPatterns: ["ui/"] }),
    ],
    expectedCapabilities: [
      capability({ key: "catalog_orders", label: "Product and purchase-order management", domainKey: "inventory", matchPatterns: ["product.{0,35}(?:detail|catalog|manage).{0,35}(?:purchase|order)?|purchase.?order.{0,30}(?:track|manage)"], evidencePathPatterns: ["model/ProductDetails\\.java|model/PurchaseOrders\\.java"], exampleClaim: "Implemented product catalog and purchase-order management for marketplace inventory." }),
      capability({ key: "sales_analytics", label: "Sales performance analytics", domainKey: "inventory", matchPatterns: ["sales.{0,30}(?:performance|revenue|margin|analytic)|unit economics"], evidencePathPatterns: ["model/ProductPerformance\\.java|ProductPerformanceList"] , exampleClaim: "Built sales performance tracking across revenue, margins, and unit economics." }),
      capability({ key: "json_persistence", label: "JSON persistence", domainKey: "inventory", importance: "supporting", expectedInHighlights: false, matchPatterns: ["json.{0,25}(?:persist|load|writ|storage)|(?:load|writ).{0,20}json"], evidencePathPatterns: ["persistence/Data(?:Loader|Writer)\\.java"], exampleClaim: "Uses tested JSON loading and writing for local persistence." }),
      capability({ key: "prophet_forecast", label: "Prophet demand forecasting", domainKey: "forecasting", matchPatterns: ["prophet.{0,30}(?:forecast|predict)|(?:demand|sales).{0,30}forecast|30.?day.{0,20}predict"], evidencePathPatterns: ["ml_service/forecast_service\\.py"], exampleClaim: "Integrated Prophet-based 30-day demand forecasts with confidence intervals." }),
      capability({ key: "java_ml_bridge", label: "Java-to-Python forecast integration", domainKey: "forecasting", matchPatterns: ["java.{0,30}(?:python|forecast|http)|forecast.{0,25}(?:client|service|microservice)"], evidencePathPatterns: ["service/ForecastClient\\.java|ml_service/forecast_service\\.py"], exampleClaim: "Connected the Java application to a Python forecasting microservice through an HTTP client." }),
      capability({ key: "swing_ui", label: "Swing analytics interface", domainKey: "desktop", matchPatterns: ["(?:java )?swing.{0,30}(?:ui|interface|panel)|desktop.{0,30}(?:analytics|interface)"], evidencePathPatterns: ["src/main/ui/"] , exampleClaim: "Delivered a Java Swing interface for inventory analytics and forecast review." }),
    ],
    falsePositiveTraps: [
      {
        label: "Java domain models are not an AI runtime",
        capabilityPatterns: ["ai[_ -]?runtime|llm|model inference"],
        misleadingEvidencePathPatterns: ["src/main/model/"],
        allowedEvidencePathPatterns: ["ml_service/forecast_service\\.py|service/ForecastClient\\.java"],
      },
      {
        label: "A forecast HTTP endpoint is not repository ingestion",
        capabilityPatterns: ["ingestion[_ -]?integration|source ingestion|repository import"],
        misleadingEvidencePathPatterns: ["ml_service/forecast_service\\.py|service/ForecastClient\\.java"],
      },
    ],
    budget: budget("small"),
  },
  {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    id: "cloudsync-cli-library",
    title: "CloudSync CLI and embeddable library",
    repository: null,
    sourceKind: "synthetic_archetype",
    snapshotCommit: null,
    archetype: "cli-library",
    languages: ["TypeScript"],
    description: "A compact library/CLI shape that prevents the suite from learning only web-application conventions.",
    files: files([
      "README.md",
      "docs/roadmap.md",
      "package.json",
      "src/index.ts",
      "src/cli.ts",
      "src/config.ts",
      "src/planner.ts",
      "src/executor.ts",
      "src/checkpoint-store.ts",
      "src/adapters/local.ts",
      "src/adapters/s3.ts",
      "test/cli.test.ts",
      "test/planner.test.ts",
      "dist/cli.js",
      "coverage/index.html",
    ]),
    ignoredPathPatterns: ignoredPaths(),
    expectedDomains: [
      domain({ key: "interface", label: "CLI and library interface", matchPatterns: ["cli|command|library|api|configuration"], evidencePathPatterns: ["cli|index|config"] }),
      domain({ key: "sync", label: "Synchronization engine", matchPatterns: ["sync|plan|transfer|adapter|dry.?run"], evidencePathPatterns: ["planner|executor|adapters"] }),
      domain({ key: "recovery", label: "Recovery and safety", matchPatterns: ["checkpoint|resume|recover|conflict|safe"], evidencePathPatterns: ["checkpoint|executor"] }),
    ],
    expectedCapabilities: [
      capability({ key: "cli_config", label: "Validated CLI configuration", domainKey: "interface", matchPatterns: ["cli.{0,30}(?:config|argument|command)|validated.{0,25}config"], evidencePathPatterns: ["src/cli\\.ts|src/config\\.ts"], exampleClaim: "Built a CLI with validated configuration and explicit commands." }),
      capability({ key: "library_api", label: "Embeddable library API", domainKey: "interface", matchPatterns: ["(?:library|public).{0,20}api|embeddable.{0,20}(?:sync|library)|programmatic.{0,20}interface"], evidencePathPatterns: ["src/index\\.ts"], exampleClaim: "Exposed the same synchronization engine as an embeddable library API." }),
      capability({ key: "dry_run_planner", label: "Dry-run synchronization planning", domainKey: "sync", matchPatterns: ["dry.?run.{0,30}(?:plan|sync)|sync.{0,30}(?:plan|preview)|planner.{0,20}transfer"], evidencePathPatterns: ["src/planner\\.ts|src/cli\\.ts"], exampleClaim: "Implemented dry-run planning so users can preview file transfers before execution." }),
      capability({ key: "storage_adapters", label: "Local and S3 storage adapters", domainKey: "sync", importance: "supporting", matchPatterns: ["local.{0,20}s3.{0,30}adapter|storage.{0,25}adapter|s3.{0,20}sync"], evidencePathPatterns: ["src/adapters/(?:local|s3)\\.ts"], exampleClaim: "Added local filesystem and S3 adapters behind a shared storage contract." }),
      capability({ key: "checkpoint_resume", label: "Checkpointed resume", domainKey: "recovery", matchPatterns: ["checkpoint.{0,30}(?:resume|recover)|resume.{0,25}(?:sync|transfer)"], evidencePathPatterns: ["checkpoint-store\\.ts|executor\\.ts"], exampleClaim: "Added checkpointed execution that resumes interrupted transfers without replaying completed work." }),
      capability({ key: "daemon_mode", label: "Continuous daemon mode", domainKey: "recovery", implementationState: "planned", expectedInHighlights: false, matchPatterns: ["daemon|continuous.{0,20}(?:sync|watch)|background watcher"], evidencePathPatterns: ["docs/roadmap\\.md"], exampleClaim: "Continuous daemon mode is roadmap work rather than implemented behavior." }),
    ],
    falsePositiveTraps: [
      {
        label: "A command API is not an external ingestion connector",
        capabilityPatterns: ["ingestion[_ -]?integration|external connector"],
        misleadingEvidencePathPatterns: ["src/cli\\.ts|src/index\\.ts"],
      },
    ],
    budget: budget("small"),
  },
] as const satisfies readonly RepositoryKnowledgeFixture[];

export function repositoryKnowledgeFixture(fixtureId: string) {
  return repositoryKnowledgeFixtures.find((fixture) => fixture.id === fixtureId) ?? null;
}
