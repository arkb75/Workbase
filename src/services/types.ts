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

export interface ClaimResearchResult {
  claims: ClaimDraft[];
  generationRunIds: {
    clusterResearch: string[];
    merge: string | null;
  };
}

export interface ClusterClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    cluster: EvidenceClusterSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    rejectedClaimGuidance: string | null;
  }): Promise<{
    claims: ClaimDraft[];
    generationRunId: string | null;
  }>;
}

export interface ClaimMergeService {
  merge(input: {
    workItem: WorkItemSnapshot;
    clusters: EvidenceClusterSnapshot[];
    clusterClaims: Array<{
      clusterId: string;
      clusterTitle: string;
      clusterTheme: string;
      clusterConfidence: EvidenceClusterSnapshot["confidence"];
      claims: ClaimDraft[];
    }>;
    rejectedClaimGuidance: string | null;
  }): Promise<{
    claims: ClaimDraft[];
    generationRunId: string | null;
  }>;
}

export interface ClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    evidenceItems: NormalizedEvidenceItem[];
    clusters: EvidenceClusterSnapshot[];
  }): Promise<ClaimResearchResult>;
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
