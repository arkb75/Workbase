import type {
  ArtifactRequest,
  ClaimDraft,
  ClaimSnapshot,
  EvidenceClusterDraft,
  EvidenceClusterSnapshot,
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

export interface ClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    clusters: EvidenceClusterSnapshot[];
  }): Promise<ClaimDraft[]>;
}

export interface ClaimVerificationService {
  verify(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    clusters: EvidenceClusterSnapshot[];
    claims: ClaimDraft[];
  }): Promise<ClaimDraft[]>;
}

export interface ArtifactGenerationService {
  generate(input: {
    request: ArtifactRequest;
    claims: ClaimSnapshot[];
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

export interface EvidenceClusteringService {
  cluster(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: EvidenceItemSnapshot[];
  }): Promise<{
    clusters: EvidenceClusterDraft[];
    generationRunId: string | null;
  }>;
}
