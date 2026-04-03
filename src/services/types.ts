import type {
  ArtifactRequest,
  ClaimDraft,
  ClaimSnapshot,
  GeneratedArtifact,
  NormalizedSource,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";

export interface SourceIngestionService {
  normalize(input: {
    workItem: WorkItemSnapshot;
    sources: SourceSnapshot[];
  }): Promise<NormalizedSource[]>;
}

export interface ClaimResearchService {
  generate(input: {
    workItem: WorkItemSnapshot;
    sources: NormalizedSource[];
  }): Promise<ClaimDraft[]>;
}

export interface ClaimVerificationService {
  verify(input: {
    workItem: WorkItemSnapshot;
    sources: NormalizedSource[];
    claims: ClaimDraft[];
  }): Promise<ClaimDraft[]>;
}

export interface ArtifactGenerationService {
  generate(input: {
    request: ArtifactRequest;
    claims: ClaimSnapshot[];
  }): Promise<GeneratedArtifact>;
}
