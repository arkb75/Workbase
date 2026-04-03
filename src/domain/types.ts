import type {
  ArtifactTone,
  ArtifactType,
  ClaimConfidence,
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
  rawContent: string | null;
  metadata: JsonValue | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EvidenceSourceReference {
  sourceId: string;
  sourceLabel: string;
  sourceType: SourceType;
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

export interface NormalizedSource {
  id: string;
  label: string;
  type: SourceType;
  body: string;
  excerpts: string[];
  metadata: JsonValue | null;
}
