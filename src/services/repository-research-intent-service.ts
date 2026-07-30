const explicitLiveRepositoryActionPattern =
  /(?:\b(?:please\s+)?(?:pull|inspect|search|read|check|access|look(?:\s+at)?)\b.{0,100}\b(?:repo|repository|github|codebase)\b)|(?:\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:pull|refresh|inspect|search|read|check|access|look(?:\s+at)?)\b.{0,100}\b(?:repo|repository|github|codebase)\b)|(?:\brefresh\b(?:\s+(?:the|this|my|our))?\s+(?:repo|repository|codebase|repository knowledge)\b)|(?:\b(?:run|start|perform|trigger)\b.{0,50}\b(?:repo|repository|codebase)(?:\s+knowledge)?\s+refresh\b)|(?:\b(?:inspect|search|read|check|access|compare)\b.{0,100}\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b)/i;

const explicitRepositoryKnowledgeRefreshPattern =
  /(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:(?:workbase|project)\s+)?(?:the\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b|(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:the\s+)?knowledge\s+(?:from|using)\s+(?:the\s+)?(?:repo(?:sitory)?|codebase)\b|\bplease\s+refresh\s+(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b/i;

const explicitRepositoryRefreshActionPattern =
  /(?:^|[.!?]\s+)(?:please\s+)?refresh\b.{0,100}\b(?:repo|repository|codebase|repository knowledge)\b|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?refresh\b.{0,100}\b(?:repo|repository|codebase|repository knowledge)\b|\b(?:run|start|perform|trigger)\b.{0,50}\b(?:repo|repository|codebase)(?:\s+knowledge)?\s+refresh\b/i;

export function hasExplicitLiveRepositoryAction(question: string) {
  return explicitLiveRepositoryActionPattern.test(question) ||
    explicitRepositoryKnowledgeRefreshPattern.test(question);
}

export function hasExplicitRepositoryRefreshAction(question: string) {
  return explicitRepositoryRefreshActionPattern.test(question) ||
    explicitRepositoryKnowledgeRefreshPattern.test(question);
}
