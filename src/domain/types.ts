import type {
  ArtifactTone,
  ArtifactType,
  ClaimConfidence,
  EvidenceItemType,
  OwnershipClarity,
  TargetAngle,
  VerificationStatus,
  VisibilityLevel,
  WorkItemType,
  SourceType,
} from "@/src/lib/options";
import type {
  HighlightTagDimension,
  HighlightTagValue,
} from "@/src/lib/highlight-taxonomy";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

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
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  included: boolean;
  lifecycleStatus?: "active" | "needs_validation" | "stale" | "superseded" | "retired" | "quarantined";
  reviewState?: "pending_review" | "reviewed" | "reverted";
  approvalSource?: "automation" | "user" | "legacy";
  metadata: JsonValue | null;
  source: Pick<SourceSnapshot, "id" | "label" | "type" | "externalId"> &
    Partial<Pick<SourceSnapshot, "metadata">>;
  tags?: HighlightTagAssignment[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface HighlightTagAssignment {
  dimension: HighlightTagDimension;
  tag: HighlightTagValue;
  score?: number | null;
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
  summary: string;
  verificationNotes?: string | null;
  sourceRefs: EvidenceSourceReference[];
}

export interface HighlightDraft {
  text: string;
  confidence: ClaimConfidence;
  ownershipClarity: OwnershipClarity;
  sensitivityFlag: boolean;
  verificationStatus: VerificationStatus;
  visibility: VisibilityLevel;
  risksSummary?: string | null;
  missingInfo?: string | null;
  rejectionReason?: string | null;
  summary: string;
  verificationNotes?: string | null;
  metadata?: JsonValue | null;
  evidence: EvidenceCardDraft;
  tags: HighlightTagAssignment[];
}

export interface HighlightSnapshot extends HighlightDraft {
  id: string;
  workItemId: string;
  lifecycleStatus?: "active" | "needs_validation" | "stale" | "superseded" | "retired" | "quarantined";
  reviewState?: "pending_review" | "reviewed" | "reverted";
  approvalSource?: "automation" | "user" | "legacy";
  publicSafetyStatus?: "not_eligible" | "pending" | "verified" | "failed";
  validatedThroughSha?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ClaimDraft = HighlightDraft;
export type ClaimSnapshot = HighlightSnapshot;

export interface ArtifactRequest {
  userId: string;
  workItemId: string;
  type: ArtifactType;
  targetAngle: TargetAngle;
  tone: ArtifactTone;
  brief?: string;
}

export interface GeneratedArtifact {
  type: ArtifactType;
  targetAngle: TargetAngle;
  tone: ArtifactTone;
  content: string;
  usedHighlightIds: string[];
  supportingEvidenceItemIds: string[];
}

export interface NormalizedEvidenceItem {
  id: string;
  sourceId: string;
  label: string;
  type: SourceType;
  evidenceType: EvidenceItemType;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  body: string;
  excerpts: string[];
  metadata: JsonValue | null;
  tags?: HighlightTagAssignment[];
}
