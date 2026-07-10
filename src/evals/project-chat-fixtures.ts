export const projectChatEvaluationFixtures = [
  {
    id: "accomplishment",
    question: "What is the strongest measurable accomplishment in this project?",
    expects: ["citation", "ownership", "impact"],
  },
  {
    id: "provenance",
    question: "Which evidence supports the claim that I owned the migration?",
    expects: ["citation", "authority_label"],
  },
  {
    id: "architecture",
    question: "How does the import queue flow through the repository?",
    expects: ["immutable_github_citation", "inference_label"],
  },
  {
    id: "artifact",
    question: "Write resume bullets about the backend architecture and latency impact.",
    expects: ["approved_highlights_only", "artifact_provenance"],
  },
  {
    id: "missing_context",
    question: "What was the production request volume?",
    expects: ["specific_coverage_gap", "no_unsupported_claim"],
  },
  {
    id: "revision",
    question: "I owned the retry design; update the existing queue highlight.",
    expects: ["revision_candidate", "self_reported_label", "review_required"],
  },
] as const;
