const repositoryActionVerb =
  "(?:pull|inspect|search|read(?!\\s*(?:(?:[-/:]?\\s*(?:vs\\.?|versus)\\s*[-/:]?\\s*|compared\\s+(?:with|to)\\s+|and\\s+)writ\\w*|[-/:]\\s*writ\\w*))|check|access|look(?:\\s+at)?)";
const repositoryActionTarget =
  "(?:(?:repo|repository|github|codebase)\\b|[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\b)";
const repositoryCommandPrefix =
  "(?:(?:(?:before answering|first|then|now),?\\s+)?(?:please\\s+)?|(?:please\\s+)?go ahead(?:\\s+and)?\\s+)";

const explicitLiveRepositoryActionPattern = new RegExp(
  `(?:(?:^|[.!?]\\s+)${repositoryCommandPrefix}${repositoryActionVerb}\\b.{0,100}\\b${repositoryActionTarget}|\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${repositoryActionVerb}\\b.{0,100}\\b${repositoryActionTarget}|\\b(?:i|we)\\s+(?:need|want|would like)\\s+you\\s+to\\s+${repositoryActionVerb}\\b.{0,100}\\b${repositoryActionTarget})`,
  "i",
);

const explicitRepositoryKnowledgeRefreshPattern =
  /(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:(?:workbase|project)\s+)?(?:the\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b|(?:^|[.!?]\s+)(?:please\s+)?refresh\s+(?:the\s+)?knowledge\s+(?:from|using)\s+(?:the\s+)?(?:repo(?:sitory)?|codebase)\b|\bplease\s+refresh\s+(?:(?:workbase|project)\s+)?(?:repo(?:sitory)?|codebase)\s+knowledge\b/i;

const repositoryRefreshTarget =
  "(?:(?:the|this|my|our)\\s+)?(?:(?:workbase|project)\\s+)?(?:repo(?:sitory)?|codebase)(?:\\s+knowledge)?";

const explicitRepositoryRefreshActionPattern = new RegExp(
  `(?:(?:^|[.!?]\\s+)${repositoryCommandPrefix}refresh\\s+${repositoryRefreshTarget}\\b|\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?refresh\\s+${repositoryRefreshTarget}\\b|\\b(?:i|we)\\s+(?:need|want|would like)\\s+you\\s+to\\s+refresh\\s+${repositoryRefreshTarget}\\b|\\b(?:run|start|perform|trigger)\\b.{0,50}\\b(?:repo|repository|codebase)(?:\\s+knowledge)?\\s+refresh\\b)`,
  "i",
);

export function hasExplicitLiveRepositoryAction(question: string) {
  return explicitLiveRepositoryActionPattern.test(question) ||
    hasExplicitRepositoryRefreshAction(question);
}

export function hasExplicitRepositoryRefreshAction(question: string) {
  return explicitRepositoryRefreshActionPattern.test(question) ||
    explicitRepositoryKnowledgeRefreshPattern.test(question);
}
