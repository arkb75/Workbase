import type { ArtifactGenerationService } from "@/src/services/types";
import { targetAngleKeywordMap } from "@/src/lib/options";

function scoreClaim(text: string, category: string | null | undefined, angle: string) {
  if (angle === "general") {
    return 1;
  }

  let score = category === angle ? 4 : 0;

  for (const keyword of targetAngleKeywordMap[angle as keyof typeof targetAngleKeywordMap] ?? []) {
    if (text.toLowerCase().includes(keyword)) {
      score += 1;
    }
  }

  return score;
}

function compareConfidence(value: string) {
  if (value === "high") {
    return 3;
  }

  if (value === "medium") {
    return 2;
  }

  return 1;
}

function selectClaims(
  claims: Parameters<ArtifactGenerationService["generate"]>[0]["claims"],
  angle: string,
) {
  return [...claims]
    .sort((left, right) => {
      const scoreDelta =
        scoreClaim(right.text, right.category, angle) -
        scoreClaim(left.text, left.category, angle);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return compareConfidence(right.confidence) - compareConfidence(left.confidence);
    })
    .slice(0, 3);
}

function toResumeBullet(text: string, tone: string) {
  const normalized = text.replace(/\.$/, "");

  if (tone === "technical") {
    return `- ${normalized}.`;
  }

  if (tone === "recruiter_friendly") {
    return `- ${normalized}, keeping the scope grounded in verified implementation work.`;
  }

  return `- ${normalized}.`;
}

export const artifactGenerationService: ArtifactGenerationService = {
  async generate({ request, claims }) {
    const selectedClaims = selectClaims(claims, request.targetAngle);

    if (!selectedClaims.length) {
      throw new Error(
        "No approved claims match the current artifact visibility and sensitivity rules.",
      );
    }

    let content = "";

    if (request.type === "resume_bullets") {
      content = selectedClaims
        .map((claim) => toResumeBullet(claim.text, request.tone))
        .join("\n");
    }

    if (request.type === "linkedin_experience") {
      const intro =
        request.tone === "technical"
          ? "Focused on implementation depth, system shape, and execution details."
          : request.tone === "recruiter_friendly"
            ? "Focused on clear scope, collaboration context, and credible delivery."
            : "Focused on the strongest approved work from this Work Item.";

      content = [
        intro,
        ...selectedClaims.map((claim) => claim.text.replace(/\.$/, ".")),
      ].join(" ");
    }

    if (request.type === "project_summary") {
      const opening =
        request.targetAngle === "ai_ml"
          ? "This project highlights applied technical work with an AI/ML angle."
          : request.targetAngle === "data_engineering"
            ? "This project highlights data flow, reliability, and system organization."
            : request.targetAngle === "backend"
              ? "This project highlights backend implementation and system behavior."
              : request.targetAngle === "full_stack"
                ? "This project highlights the full-stack workflow from interface to data."
                : "This project highlights a concise, evidence-backed technical story.";

      content = `${opening} ${selectedClaims
        .map((claim) => claim.text.replace(/\.$/, "."))
        .join(" ")}`;
    }

    return {
      type: request.type,
      targetAngle: request.targetAngle,
      tone: request.tone,
      content,
      usedClaimIds: selectedClaims.map((claim) => claim.id),
    };
  },
};
