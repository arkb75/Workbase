export const DEMO_USER_EMAIL =
  process.env.WORKBASE_DEMO_USER_EMAIL ?? "demo@workbase.app";

export const DEMO_USER_NAME =
  process.env.WORKBASE_DEMO_USER_NAME ?? "Workbase Demo User";

export const careerStageOptions = [
  { value: "student", label: "CS student" },
  { value: "intern", label: "Intern" },
  { value: "new_grad", label: "New grad" },
  { value: "early_career_engineer", label: "Early-career engineer" },
] as const;

export type CareerStage = (typeof careerStageOptions)[number]["value"];

export const focusPreferenceOptions = [
  { value: "projects", label: "Projects" },
  { value: "work_experience", label: "Work experience" },
  { value: "both", label: "Both" },
] as const;

export type FocusPreference = (typeof focusPreferenceOptions)[number]["value"];

export const workItemTypeOptions = [
  { value: "project", label: "Project" },
  { value: "experience", label: "Experience" },
] as const;

export type WorkItemType = (typeof workItemTypeOptions)[number]["value"];

export const sourceTypeOptions = [
  { value: "manual_note", label: "Manual note" },
  { value: "github_repo", label: "GitHub repo" },
] as const;

export type SourceType = (typeof sourceTypeOptions)[number]["value"];

export const evidenceItemTypeOptions = [
  { value: "manual_note_excerpt", label: "Manual note excerpt" },
  { value: "github_readme", label: "README" },
  { value: "github_commit", label: "Commit" },
  { value: "github_pull_request", label: "Pull request" },
  { value: "github_issue", label: "Issue" },
  { value: "github_release", label: "Release" },
] as const;

export type EvidenceItemType =
  (typeof evidenceItemTypeOptions)[number]["value"];

export const confidenceOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export type ClaimConfidence = (typeof confidenceOptions)[number]["value"];

export const ownershipClarityOptions = [
  { value: "unclear", label: "Unclear" },
  { value: "partial", label: "Partial" },
  { value: "clear", label: "Clear" },
] as const;

export type OwnershipClarity =
  (typeof ownershipClarityOptions)[number]["value"];

export const verificationStatusOptions = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "flagged", label: "Flagged" },
  { value: "rejected", label: "Rejected" },
] as const;

export type VerificationStatus =
  (typeof verificationStatusOptions)[number]["value"];

export const visibilityOptions = [
  { value: "private", label: "Private" },
  { value: "resume_safe", label: "Resume-safe" },
  { value: "linkedin_safe", label: "LinkedIn-safe" },
  { value: "public_safe", label: "Public-safe" },
] as const;

export type VisibilityLevel = (typeof visibilityOptions)[number]["value"];

export const artifactTypeOptions = [
  { value: "resume_bullets", label: "Resume bullets" },
  { value: "linkedin_experience", label: "LinkedIn experience" },
  { value: "project_summary", label: "Project summary" },
] as const;

export type ArtifactType = (typeof artifactTypeOptions)[number]["value"];

export const targetAngleOptions = [
  { value: "general", label: "Recruiter-friendly general" },
  { value: "ai_ml", label: "AI/ML" },
  { value: "data_engineering", label: "Data engineering" },
  { value: "backend", label: "Backend" },
  { value: "full_stack", label: "Full stack" },
] as const;

export type TargetAngle = (typeof targetAngleOptions)[number]["value"];

export const artifactToneOptions = [
  { value: "concise", label: "Concise" },
  { value: "technical", label: "Technical" },
  { value: "recruiter_friendly", label: "Recruiter-friendly" },
] as const;

export type ArtifactTone = (typeof artifactToneOptions)[number]["value"];

export const targetAngleKeywordMap: Record<TargetAngle, string[]> = {
  general: ["built", "implemented", "collaborated", "delivered", "improved"],
  ai_ml: [
    "model",
    "inference",
    "training",
    "embedding",
    "llm",
    "classification",
    "ml",
    "prompt",
  ],
  data_engineering: [
    "pipeline",
    "etl",
    "warehouse",
    "postgresql",
    "dbt",
    "airflow",
    "dataset",
    "ingest",
  ],
  backend: [
    "api",
    "service",
    "database",
    "queue",
    "auth",
    "prisma",
    "postgresql",
    "worker",
  ],
  full_stack: [
    "next.js",
    "react",
    "dashboard",
    "frontend",
    "backend",
    "full-stack",
    "ui",
    "api",
  ],
};

export const publicArtifactVisibilityRules: Record<ArtifactType, VisibilityLevel[]> =
  {
    resume_bullets: ["resume_safe", "linkedin_safe", "public_safe"],
    linkedin_experience: ["linkedin_safe", "public_safe"],
    project_summary: ["public_safe"],
  };
