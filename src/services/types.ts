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
    onAgentEvent?: (event: BedrockConverseAgentEvent) => void | Promise<void>;
  }): Promise<ProjectResearchResult>;
}

export interface ArtifactWorkflowService {
  start(input: {
    userId: string;
    workItemId: string;
    threadId?: string | null;
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
  }): Promise<{
    messageId: string;
    repositoryInspected: boolean;
    partial: boolean;
    fallbackUsed: boolean;
    toolCalls: Array<{ name: string; count: number }>;
    usedSources: Array<{ kind: string; title: string }>;
  }>;
}
