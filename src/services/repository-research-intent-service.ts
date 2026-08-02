const explicitLiveRepositoryActionPattern =
  /(?:(?:^|[.!?]\s+)(?:(?:please|go ahead(?:\s+and)?|before answering,?)\s+)?(?:pull|inspect|search|read|check|access|look(?:\s+at)?)\b.{0,100}\b(?:(?:repo|repository|github|codebase)\b|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b))|(?:\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:pull|inspect|search|read|check|access|look(?:\s+at)?)\b.{0,100}\b(?:(?:repo|repository|github|codebase)\b|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b))|(?:\b(?:i|we)\s+(?:need|want|would like)\s+you\s+to\s+(?:pull|inspect|search|read|check|access|look(?:\s+at)?)\b.{0,100}\b(?:(?:repo|repository|github|codebase)\b|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b))/i;

const explicitRepositoryKnowledgeRefreshPattern =
  /(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:(?:workbase|project)\s+)?(?:the\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b|(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:the\s+)?knowledge\s+(?:from|using)\s+(?:the\s+)?(?:repo(?:sitory)?|codebase)\b|\bplease\s+refresh\s+(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b/i;

const explicitRepositoryRefreshActionPattern =
  /(?:(?:^|[.!?]\s+)(?:(?:please|go ahead(?:\s+and)?)\s+)?refresh\s+(?:(?:the|this|my|our)\s+)?(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)(?:\s+knowledge)?\b)|(?:\b(?:can|could|would|will)\s+you\s+(?:please\s+)?refresh\s+(?:(?:the|this|my|our)\s+)?(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)(?:\s+knowledge)?\b)|(?:\b(?:i|we)\s+(?:need|want|would like)\s+you\s+to\s+refresh\s+(?:(?:the|this|my|our)\s+)?(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)(?:\s+knowledge)?\b)|(?:\b(?:run|start|perform|trigger)\b.{0,50}\b(?:repo|repository|codebase)(?:\s+knowledge)?\s+refresh\b)/i;

export function hasExplicitLiveRepositoryAction(question: string) {
  return explicitLiveRepositoryActionPattern.test(question) ||
    hasExplicitRepositoryRefreshAction(question);
}

export function hasExplicitRepositoryRefreshAction(question: string) {
  return explicitRepositoryRefreshActionPattern.test(question) ||
    explicitRepositoryKnowledgeRefreshPattern.test(question);
}
