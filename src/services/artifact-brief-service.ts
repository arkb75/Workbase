import type { NormalizedArtifactBrief } from "@/src/domain/project-chat";
import { normalizeWhitespace } from "@/src/lib/utils";

const typeSignals = {
  resume_bullets: ["resume", "bullet", "cv"],
  linkedin_experience: ["linkedin", "experience entry", "profile entry"],
  project_summary: ["project summary", "portfolio summary", "summary", "overview"],
} as const;

const angleSignals = {
  ai_ml: ["ai", "ml", "model", "inference", "embedding", "llm"],
  data_engineering: ["data", "pipeline", "etl", "warehouse", "analytics"],
  backend: ["backend", "api", "service", "database", "queue", "auth"],
  full_stack: ["full stack", "full-stack", "frontend", "react", "next.js", "ui"],
} as const;

export function looksLikeArtifactRequest(value: string) {
  const normalized = value.toLowerCase();
  return (
    /\b(write|draft|create|generate|revise|rewrite)\b/.test(normalized) &&
    Object.values(typeSignals).some((signals) =>
      signals.some((signal) => normalized.includes(signal)),
    )
  );
}

export function normalizeArtifactBrief(brief: string):
  | { status: "ok"; request: NormalizedArtifactBrief }
  | { status: "clarification_required"; message: string } {
  const normalizedBrief = normalizeWhitespace(brief).slice(0, 2_000);
  const searchable = normalizedBrief.toLowerCase();
  const type = (Object.entries(typeSignals) as Array<
    [NormalizedArtifactBrief["type"], readonly string[]]
  >).find(([, signals]) => signals.some((signal) => searchable.includes(signal)))?.[0];

  if (!type) {
    return {
      status: "clarification_required",
      message:
        "I can create resume bullets, a LinkedIn experience entry, or a project summary. Which of those should this become?",
    };
  }

  const targetAngle = (Object.entries(angleSignals) as Array<
    [Exclude<NormalizedArtifactBrief["targetAngle"], "general">, readonly string[]]
  >).find(([, signals]) => signals.some((signal) => searchable.includes(signal)))?.[0] ?? "general";
  const tone = /recruiter|accessible|nontechnical|non-technical/.test(searchable)
    ? "recruiter_friendly"
    : /technical|architecture|implementation|engineering/.test(searchable)
      ? "technical"
      : "concise";

  return {
    status: "ok",
    request: {
      type,
      targetAngle,
      tone,
      brief: normalizedBrief,
    },
  };
}

