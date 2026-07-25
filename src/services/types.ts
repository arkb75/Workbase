import type {
  ArtifactRequest,
  HighlightDraft,
  HighlightSnapshot,
  EvidenceItemSnapshot,
  GitHubConnectionSnapshot,
  GeneratedArtifact,
  NormalizedEvidenceItem,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import type {
  ArtifactWorkflowState,
  ProjectFactCategory,
  ProjectKnowledgePurpose,
  ProjectKnowledgeResult,
  ProjectResearchPurpose,
  ProjectResearchResult,
} from "@/src/domain/project-chat";
import type { BedrockConverseAgentEvent } from "@/src/lib/bedrock-converse-agent";

export interface SourceIngestionService {
  normalize(input: {
    workItem: WorkItemSnapshot;
    sources: SourceSnapshot[];
    evidenceItems: EvidenceItemSnapshot[];
  }): Promise<NormalizedEvidenceItem[]>;
}

export interface ClaimResearchResult {
  highlights: HighlightDraft[];
  generationRunIds: {
    generation: string[];
    verification: string | null;
  };
}

export interface HighlightGenerationService {
  generate(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    existingHighlights: HighlightSnapshot[];
    artifactRequest?: ArtifactRequest;
  }): Promise<ClaimResearchResult>;
}

export interface ClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    existingHighlights?: HighlightSnapshot[];
    artifactRequest?: ArtifactRequest;
  }): Promise<ClaimResearchResult>;
}

export interface ClaimVerificationService {
  verify(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    highlights: HighlightDraft[];
  }): Promise<HighlightDraft[]>;
}

export interface HighlightRetrievalService {
  retrieve(input: {
    workItem: WorkItemSnapshot;
    request: ArtifactRequest;
    highlights: HighlightSnapshot[];
    evidenceItems: EvidenceItemSnapshot[];
  }): Promise<{
    highlights: HighlightSnapshot[];
    supportingEvidence: EvidenceItemSnapshot[];
    generationRunId: string | null;
    adequacy: {
      status: "sufficient" | "needs_research";
      score: number;
      reasons: string[];
      coverageGaps: string[];
    };
  }>;
}

export interface ArtifactGenerationService {
  generate(input: {
    request: ArtifactRequest;
    highlights: HighlightSnapshot[];
    supportingEvidence: EvidenceItemSnapshot[];
  }): Promise<GeneratedArtifact>;
}

export interface GitHubRepositorySummary {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  url: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string | null;
}

export interface GitHubAuthService {
  getConnection(userId: string): Promise<GitHubConnectionSnapshot | null>;
  listRepositories(input: {
    userId: string;
    query?: string;
    limit?: number;
  }): Promise<GitHubRepositorySummary[]>;
  exchangeCodeForUser(input: {
    userId: string;
    code: string;
  }): Promise<GitHubConnectionSnapshot>;
}

export interface GitHubRepoImportService {
  importRepository(input: {
    userId: string;
    workItem: WorkItemSnapshot;
    repositoryId: string;
    repositoryFullName: string;
  }): Promise<{
    source: SourceSnapshot;
    importedEvidenceItems: Array<
      Omit<EvidenceItemSnapshot, "id" | "createdAt" | "updatedAt">
    >;
    importSummary: {
      repository: GitHubRepositorySummary;
      importedAt: string;
      counts: Record<string, number>;
      webhook:
        | {
            status: "configured";
            hookId: string;
            created: boolean;
            configuredAt: string;
            configurationFingerprint: string;
          }
        | {
            status: "not_configured" | "unavailable";
            reasonCode: string;
            checkedAt?: string;
            configurationFingerprint?: string;
          };
    };
  }>;
}

export interface ProjectKnowledgeRetrievalService {
  retrieve(input: {
    userId: string;
    workItemId: string;
    query: string;
    purpose: ProjectKnowledgePurpose;
    limits?: {
      highlights?: number;
      projectFacts?: number;
      evidence?: number;
      artifacts?: number;
    };
    preferredProjectFactIds?: string[];
  }): Promise<ProjectKnowledgeResult>;
}

export interface ProjectResearchService {
  research(input: {
    runId?: string;
    userId: string;
    workItemId: string;
    question: string;
    purpose: ProjectResearchPurpose;
    hints?: string[];
    preloadedKnowledge?: ProjectKnowledgeResult;
    onAgentEvent?: (event: BedrockConverseAgentEvent) => void | Promise<void>;
  }): Promise<ProjectResearchResult>;
}

export interface ArtifactWorkflowService {
  start(input: {
    userId: string;
    workItemId: string;
    threadId?: string | null;
    supersedesArtifactId?: string | null;
    brief: string;
    idempotencyKey: string;
  }): Promise<ArtifactWorkflowState>;
}

export interface CandidateReviewService {
  resolve(input: {
    userId: string;
    candidateId: string;
    decision: "approve" | "deny";
    editedText?: string | null;
    feedback?: string | null;
    visibility?: "private" | "resume_safe" | "linkedin_safe" | "public_safe" | null;
    sensitivityFlag?: boolean | null;
    reviewNotes?: string | null;
    category?: ProjectFactCategory | null;
    idempotencyKey: string;
  }): Promise<{
    candidateId: string;
    status: "approved" | "denied";
    resumedRunId: string | null;
  }>;
}

export interface PriorTurnProvenanceService {
  inspect(input: {
    userId: string;
    workItemId: string;
    threadId: string;
    assistantMessageId?: string | null;
    auditRunId?: string | null;
  }): Promise<{
    messageId: string;
    repositoryInspected: boolean;
    repositoryActivity:
      | "none"
      | "targeted_research"
      | "knowledge_refresh"
      | "knowledge_refresh_and_targeted_research";
    partial: boolean;
    fallbackUsed: boolean;
    toolCalls: Array<{ name: string; count: number }>;
    usedSources: Array<{ kind: string; title: string }>;
  }>;
}

export interface RepositoryKnowledgeSyncService {
  start(input: {
    userId: string;
    workItemId: string;
    trigger: "repository_attach" | "webhook_push" | "scheduled" | "manual" | "chat_freshness" | "backfill";
    idempotencyKey: string;
  }): Promise<{
    runId: string;
    workflowId: string;
    status: "queued" | "inventorying" | "analyzing" | "reconciling" | "completed" | "failed" | "cancelled";
  }>;
  awaitCurrent(input: {
    userId: string;
    workItemId: string;
    requiredFor: "broad_chat" | "public_artifact" | "explicit_freshness";
    idempotencyKey: string;
  }): Promise<{
    runId: string;
    targetHeads: Array<{ sourceId: string; repository: string; commitSha: string; resolvedAt: string }>;
    coverageComplete: boolean;
  }>;
}

export interface KnowledgeReviewService {
  resolve(input: {
    userId: string;
    changeId: string;
    decision: "keep" | "edit_and_keep" | "revert" | "retire";
    patch?: Record<string, unknown>;
    feedback?: string | null;
  }): Promise<{
    changeId: string;
    decision: "kept" | "edited_and_kept" | "reverted" | "retired";
    successor: { kind: string; id: string } | null;
  }>;
}

export interface KnowledgeLifecycleService {
  edit(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    patch: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ successorId: string }>;
  retire(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    reason?: string | null;
    idempotencyKey: string;
  }): Promise<{ entityId: string; lifecycleStatus: "retired" }>;
}
