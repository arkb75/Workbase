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
  }): Promise<ClaimResearchResult>;
}

export interface ClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    existingHighlights?: HighlightSnapshot[];
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
