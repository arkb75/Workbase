import type {
  ArtifactTone,
  ArtifactType,
  ClaimConfidence,
  EvidenceItemType,
  FocusPreference,
  OwnershipClarity,
  TargetAngle,
  VerificationStatus,
  VisibilityLevel,
  WorkItemType,
  SourceType,
  CareerStage,
} from "@/src/lib/options";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export interface WorkbaseUserProfile {
  id: string;
  email: string;
  name: string;
  careerStage: CareerStage | null;
  currentGoal: string | null;
  focusPreference: FocusPreference | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface WorkItemSnapshot {
  id: string;
  userId: string;
  title: string;
  type: WorkItemType;
  description: string;
  startDate: Date | null;
  endDate: Date | null;
}

export interface SourceSnapshot {
  id: string;
  workItemId: string;
  type: SourceType;
  label: string;
  externalId?: string | null;
  rawContent: string | null;
  metadata: JsonValue | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface GitHubConnectionSnapshot {
  id: string;
  userId: string;
  githubUserId: string;
  login: string;
  scope: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EvidenceItemSnapshot {
  id: string;
  workItemId: string;
  sourceId: string;
  externalId: string;
  type: EvidenceItemType;
  title: string;
  content: string;
  included: boolean;
  metadata: JsonValue | null;
  source: Pick<SourceSnapshot, "id" | "label" | "type" | "externalId">;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EvidenceClusterItemSnapshot {
  id: string;
  clusterId: string;
  evidenceItemId: string;
  relevanceScore: number | null;
  createdAt?: Date;
}

export interface EvidenceClusterSnapshot {
  id: string;
  workItemId: string;
  title: string;
  summary: string;
  theme: string;
  confidence: ClaimConfidence;
  metadata: JsonValue | null;
  items: Array<{
    id: string;
    evidenceItemId: string;
    relevanceScore: number | null;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EvidenceSourceReference {
  evidenceItemId?: string;
  sourceId: string;
  sourceLabel: string;
  sourceType: SourceType;
  title?: string;
  excerpt: string;
}

export interface EvidenceCardDraft {
  evidenceSummary: string;
  rationaleSummary: string;
  sourceRefs: EvidenceSourceReference[];
  verificationNotes?: string | null;
}

export interface ClaimDraft {
  text: string;
  category?: string | null;
  confidence: ClaimConfidence;
  ownershipClarity: OwnershipClarity;
  sensitivityFlag: boolean;
  verificationStatus: VerificationStatus;
  visibility: VisibilityLevel;
  risksSummary?: string | null;
  missingInfo?: string | null;
  rejectionReason?: string | null;
  evidenceCard: EvidenceCardDraft;
}

export interface ClaimSnapshot extends ClaimDraft {
  id: string;
  workItemId: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ArtifactRequest {
  userId: string;
  workItemId: string;
  type: ArtifactType;
  targetAngle: TargetAngle;
  tone: ArtifactTone;
}

export interface GeneratedArtifact {
  type: ArtifactType;
  targetAngle: TargetAngle;
  tone: ArtifactTone;
  content: string;
  usedClaimIds: string[];
}

export interface NormalizedEvidenceItem {
  id: string;
  sourceId: string;
  label: string;
  type: SourceType;
  evidenceType: EvidenceItemType;
  body: string;
  excerpts: string[];
  metadata: JsonValue | null;
}

export interface EvidenceClusterDraft {
  title: string;
  summary: string;
  theme: string;
  confidence: ClaimConfidence;
  metadata: JsonValue | null;
  items: Array<{
    evidenceItemId: string;
    relevanceScore: number | null;
  }>;
}

export interface GenerationTraceSnapshot {
  id: string;
  workItemId: string;
  kind:
    | "claim_research"
    | "claim_cluster_research"
    | "claim_merge"
    | "claim_verification"
    | "artifact_generation"
    | "evidence_clustering";
  status: "success" | "provider_error" | "parse_error" | "validation_error";
  provider: string;
  modelId: string;
  inputSummary: JsonValue;
  rawOutput: string | null;
  parsedOutput: JsonValue | null;
  validationErrors: JsonValue | null;
  resultRefs: JsonValue | null;
  tokenUsage: JsonValue | null;
  estimatedCostUsd: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}
