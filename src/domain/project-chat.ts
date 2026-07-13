import type {
  ArtifactTone,
  ArtifactType,
  TargetAngle,
  VerificationStatus,
  VisibilityLevel,
} from "@/src/lib/options";

export type ProjectKnowledgePurpose =
  | "private_chat"
  | "project_research"
  | "public_artifact";

export type ProjectKnowledgeAuthority =
  | "verified_highlight"
  | "verified_project_fact"
  | "candidate_highlight"
  | "included_evidence"
  | "rejected_guidance"
  | "prior_artifact";

export interface ProjectKnowledgeCitation {
  kind: "highlight" | "project_fact" | "evidence" | "artifact" | "github_file";
  label: string;
  excerpt: string;
  highlightId?: string;
  projectFactId?: string;
  evidenceItemId?: string;
  artifactId?: string;
  sourceId?: string;
  repository?: string;
  commitSha?: string;
  blobSha?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  url?: string;
  contentHash?: string;
  redacted?: boolean;
  redactionCategories?: string[];
  provenance?: Array<{
    evidenceItemId: string;
    title: string;
    excerpt: string;
    repository?: string;
    commitSha?: string;
    blobSha?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    url?: string;
    contentHash?: string;
  }>;
}

export interface ProjectKnowledgeHit {
  id: string;
  kind: "highlight" | "project_fact" | "evidence" | "artifact";
  authority: ProjectKnowledgeAuthority;
  title: string;
  content: string;
  score: number;
  status?: VerificationStatus;
  visibility?: VisibilityLevel;
  sensitivityFlag?: boolean;
  ownershipAuthority?: number;
  subsystemKey?: string | null;
  validatedThroughSha?: string | null;
  accomplishmentRanking?: {
    evidenceStrength: number;
    productImportance: number;
    implementationBreadth: number;
    technicalDifficulty: number;
    ownershipAuthority: number;
    distinctiveness: number;
    freshness: number;
    impactBonus: number;
    uncertainty: string | null;
  };
  citations: ProjectKnowledgeCitation[];
}

export interface ProjectKnowledgeResult {
  query: string;
  purpose: ProjectKnowledgePurpose;
  hits: ProjectKnowledgeHit[];
  selectedHighlightIds: string[];
  selectedProjectFactIds: string[];
  selectedEvidenceItemIds: string[];
  selectedArtifactIds: string[];
  warnings: string[];
}

export type ProjectResearchPurpose = "answer_question" | "discover_highlights";

export type ProjectFactCategory =
  | "architecture"
  | "behavior"
  | "data_flow"
  | "code_location"
  | "dependency"
  | "configuration";

export type ProjectFactStatus = "draft" | "approved" | "rejected" | "superseded";

export interface ProjectFactDraft {
  statement: string;
  category: ProjectFactCategory;
  confidence: "low" | "medium" | "high";
  sensitivityFlag: boolean;
  reviewNotes?: string | null;
  citationIndexes: number[];
  supersedesProjectFactId?: string | null;
}

export interface ProjectResearchFinding {
  statement: string;
  confidence: "low" | "medium" | "high";
  isInference: boolean;
  citationIndexes: number[];
}

export interface ProjectResearchResult {
  status: "answered" | "awaiting_review" | "insufficient_context" | "failed";
  answer: string;
  findings: ProjectResearchFinding[];
  citations: ProjectKnowledgeCitation[];
  coverageGaps: string[];
  warnings: string[];
  candidateIds: string[];
  generationRunIds: string[];
  partial: boolean;
  exploredEvidence: ProjectKnowledgeCitation[];
  coverage: {
    planned: string[];
    achieved: string[];
    uninspected: string[];
    omittedRepositories: string[];
  } | null;
  groundedClaims?: Array<{
    claim: string;
    citationIndexes: number[];
  }>;
}

export type AnswerCitationPolicy = "required_inline" | "attached" | "none";

export interface GroundedAnswerBlock {
  heading?: string | null;
  bodyMarkdown: string;
  citationIndexes: number[];
}

export interface FinalizedChatAnswer {
  answerKind: "project_grounded" | "process_metadata" | "conversational";
  citationPolicy: AnswerCitationPolicy;
  markdown: string;
  citations: ProjectKnowledgeCitation[];
  groundedClaims: Array<{
    claim: string;
    citationIndexes: number[];
  }>;
  freshness?: {
    repositories: Array<{
      name: string;
      commitSha: string;
      resolvedAt: string;
    }>;
    coverage: "complete" | "partial";
    gaps: string[];
  } | null;
}

export interface ProjectResearchRepositorySnapshot {
  sourceId: string;
  name: string;
  importedAt: string;
  pinnedSha: string | null;
  committedAt: string | null;
  resolvedAt: string | null;
}

export interface ProjectResearchDossier {
  version: 1;
  controllerVersion: string | null;
  allowedActions: string[];
  remaining: Record<string, unknown> | null;
  objective: string;
  phase:
    | "planning"
    | "searching"
    | "reading"
    | "extracting"
    | "awaiting_review"
    | "finalizing"
    | "completed"
    | "insufficient_context"
    | "failed";
  startedAt: string;
  updatedAt: string;
  researchedAt: string | null;
  completedAt: string | null;
  repositories: ProjectResearchRepositorySnapshot[];
  coverage: ProjectResearchResult["coverage"];
  coverageGaps: string[];
  warnings: string[];
  partial: boolean;
  usage: Record<string, unknown> | null;
  notebook: {
    paths: Array<{
      handle: string;
      sourceId: string;
      repository: string;
      path: string;
      origin: string;
      score: number;
    }>;
    citations: Array<{
      type: ProjectKnowledgeCitation["kind"];
      title: string;
      repository?: string;
      commitSha?: string;
      path?: string;
      startLine?: number;
      endLine?: number;
    }>;
  } | null;
  candidateIds: string[];
  provisionalProjectFactIds: string[];
  generationRunIds: string[];
  modelUsage: unknown[];
  finalization: {
    citationCount: number;
    usedProjectFactIds: string[];
  } | null;
}

export interface NormalizedArtifactBrief {
  type: ArtifactType;
  targetAngle: TargetAngle;
  tone: ArtifactTone;
  brief: string;
}

export type ArtifactWorkflowState =
  | {
      status: "queued";
      runId: string;
      threadId: string;
      workflowId: string;
    }
  | {
      status: "completed";
      artifactId: string;
      content: string;
    }
  | {
      status: "awaiting_review";
      runId: string;
      candidateIds: string[];
      attempt: number;
    }
  | {
      status: "clarification_required" | "insufficient_context";
      message: string;
      coverageGaps: string[];
    }
  | {
      status: "failed" | "cancelled";
      message: string;
    };

export interface ChatProgressEvent {
  type:
    | "status"
    | "retrieval"
    | "research"
    | "candidate"
    | "artifact"
    | "complete"
    | "error";
  message: string;
  createdAt: string;
  refs?: Record<string, string | number | boolean | string[] | null>;
}
