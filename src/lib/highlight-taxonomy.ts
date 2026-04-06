export const highlightDomainTags = [
  "general",
  "ai_ml",
  "data_engineering",
  "backend",
  "full_stack",
  "frontend",
  "design",
  "product",
  "research",
  "operations",
] as const;

export const highlightCompetencyTags = [
  "technology",
  "problem_solving",
  "ownership",
  "teamwork",
  "communication",
  "leadership",
  "execution",
] as const;

export const highlightEmphasisTags = [
  "implementation",
  "architecture",
  "optimization",
  "reliability",
  "user_experience",
  "experimentation",
  "collaboration",
] as const;

export const highlightAudienceFitTags = [
  "resume_safe",
  "linkedin_safe",
  "project_summary",
  "technical_interview",
] as const;

export const highlightTagDimensions = [
  "domain",
  "competency",
  "emphasis",
  "audience_fit",
] as const;

export type HighlightTagDimension =
  (typeof highlightTagDimensions)[number];

export type HighlightDomainTag =
  (typeof highlightDomainTags)[number];
export type HighlightCompetencyTag =
  (typeof highlightCompetencyTags)[number];
export type HighlightEmphasisTag =
  (typeof highlightEmphasisTags)[number];
export type HighlightAudienceFitTag =
  (typeof highlightAudienceFitTags)[number];

export type HighlightTagValue =
  | HighlightDomainTag
  | HighlightCompetencyTag
  | HighlightEmphasisTag
  | HighlightAudienceFitTag;

export const highlightTagVocabulary = {
  domain: highlightDomainTags,
  competency: highlightCompetencyTags,
  emphasis: highlightEmphasisTags,
  audience_fit: highlightAudienceFitTags,
} as const;

export const domainKeywordMap: Record<HighlightDomainTag, string[]> = {
  general: ["built", "implemented", "developed", "improved", "delivered"],
  ai_ml: [
    "model",
    "machine learning",
    "ml",
    "ranking",
    "classification",
    "training",
    "inference",
    "feed signal",
    "logistic regression",
  ],
  data_engineering: [
    "pipeline",
    "ingest",
    "etl",
    "event tracking",
    "data store",
    "warehouse",
    "dataset",
  ],
  backend: [
    "api",
    "database",
    "dynamodb",
    "service",
    "repository",
    "auth",
    "validation",
  ],
  full_stack: ["next.js", "react", "ui", "api", "frontend", "backend"],
  frontend: [
    "ui",
    "component",
    "reelcard",
    "video",
    "dark mode",
    "theme",
    "form",
  ],
  design: ["theme", "design system", "palette", "typography", "layout", "css"],
  product: ["onboarding", "workflow", "invite", "profile", "messaging", "feed"],
  research: ["experiment", "analysis", "evaluation", "prototype", "research"],
  operations: ["deployment", "release", "setup", "scripts", "maintenance"],
};

export const competencyKeywordMap: Record<HighlightCompetencyTag, string[]> = {
  technology: ["implemented", "built", "developed", "engineered"],
  problem_solving: ["optimized", "fixed", "stabilized", "fallback", "ranking"],
  ownership: ["owned", "end-to-end", "introduced", "designed", "implemented"],
  teamwork: ["collaborated", "co-founder", "invite", "founder", "investor"],
  communication: ["summary", "notes", "profile", "experience", "invite email"],
  leadership: ["led", "drove", "defined", "guided"],
  execution: ["delivered", "shipped", "launched", "implemented"],
};

export const emphasisKeywordMap: Record<HighlightEmphasisTag, string[]> = {
  implementation: ["implemented", "built", "developed", "added"],
  architecture: ["architecture", "system", "data model", "routing", "structure"],
  optimization: ["optimized", "ranking", "performance", "dedupe", "improved"],
  reliability: ["validation", "error handling", "read tracking", "state handling"],
  user_experience: ["user experience", "ui", "layout", "touch", "video", "wizard"],
  experimentation: ["model", "training", "signals", "feature engineering"],
  collaboration: ["collaborated", "co-founder", "team", "shared"],
};

export const audienceFitDefaultsByArtifactType = {
  resume_bullets: ["resume_safe", "technical_interview"],
  linkedin_experience: ["linkedin_safe", "resume_safe"],
  project_summary: ["project_summary", "linkedin_safe"],
} as const;

export function isAllowedHighlightTag(
  dimension: HighlightTagDimension,
  tag: string,
) {
  return (highlightTagVocabulary[dimension] as readonly string[]).includes(tag);
}
