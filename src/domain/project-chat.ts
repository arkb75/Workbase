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
  | "candidate_highlight"
  | "included_evidence"
  | "rejected_guidance"
  | "prior_artifact";

export interface ProjectKnowledgeCitation {
  kind: "highlight" | "evidence" | "artifact" | "github_file";
  label: string;
  excerpt: string;
  highlightId?: string;
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
}

export interface ProjectKnowledgeHit {
  id: string;
  kind: "highlight" | "evidence" | "artifact";
  authority: ProjectKnowledgeAuthority;
  title: string;
  content: string;
  score: number;
  status?: VerificationStatus;
  visibility?: VisibilityLevel;
  sensitivityFlag?: boolean;
  citations: ProjectKnowledgeCitation[];
}

export interface ProjectKnowledgeResult {
  query: string;
  purpose: ProjectKnowledgePurpose;
  hits: ProjectKnowledgeHit[];
  selectedHighlightIds: string[];
  selectedEvidenceItemIds: string[];
  selectedArtifactIds: string[];
  warnings: string[];
}

export type ProjectResearchPurpose = "answer_question" | "discover_highlights";

export interface ProjectResearchFinding {
  statement: string;
  confidence: "low" | "medium" | "high";
  isInference: boolean;
  citationIndexes: number[];
}

export interface ProjectResearchResult {
  status: "answered" | "insufficient_context" | "failed";
  answer: string;
  findings: ProjectResearchFinding[];
  citations: ProjectKnowledgeCitation[];
  coverageGaps: string[];
  warnings: string[];
  candidateIds: string[];
  generationRunIds: string[];
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
