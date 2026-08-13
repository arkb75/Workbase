const citationMarkerPattern = /\[citation:\d+\]/gi;
const citationOnlyPattern = /^(?:\[citation:\d+\]\s*)+$/i;
const internalProtocolTagPattern = /<\/?(?:message_id|used_sources|used_citations|available_context|untrusted_semantic_plan|capability_manifest_json|untrusted_complete_repository_refresh_json|untrusted_conversation_context_json|untrusted_editorial_plan_json|untrusted_retrieved_project_memory_json|untrusted_reviewed_research_json|untrusted_user_request_json)\b[^>]*>/gi;

export interface ProjectChatPublicationIssue {
  code: "internal_protocol_exposed" | "uncited_project_claim_block";
  explanation: string;
}

export const WITHHELD_PROJECT_CHAT_ANSWER =
  "This answer was withheld because it contained internal response metadata. Regenerate it from the current project sources.";

function sectionClaimSegments(section: string) {
  const lines = section.split("\n");
  const table = lines.filter((line) => line.trim()).every((line) =>
    /^\s*\|.*\|\s*$/.test(line)
  );
  if (table) return [section];

  const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
  if (!lines.some((line) => listItemPattern.test(line))) return [section];

  const segments: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) segments.push(value);
    current = [];
  };
  for (const line of lines) {
    if (listItemPattern.test(line)) flush();
    if (current.length || listItemPattern.test(line)) current.push(line);
  }
  flush();
  return segments.length ? segments : [section];
}

function visibleClaimText(segment: string) {
  return segment
    .replace(citationMarkerPattern, "")
    .replace(/^\s*#{1,6}\s+.*$/gm, "")
    .replace(/^\s*(?:---+|___+|\*\*\*+)\s*$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function substantiveClaimBlock(segment: string) {
  const visible = visibleClaimText(segment);
  const tokens = visible.match(/[\p{L}\p{N}]+/gu) ?? [];
  return visible.length >= 24 && tokens.length >= 4;
}

function groundingSegments(answer: string) {
  const sections = answer
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);
  const segments: Array<{ content: string; cited: boolean }> = [];
  for (const section of sections) {
    if (citationOnlyPattern.test(section)) {
      const previous = segments.at(-1);
      if (previous) previous.cited = true;
      continue;
    }
    for (const content of sectionClaimSegments(section)) {
      segments.push({
        content,
        cited: citationMarkerPattern.test(content),
      });
      citationMarkerPattern.lastIndex = 0;
    }
  }
  return segments;
}

export function analyzeProjectChatPublicationSafety(input: {
  answer: string;
  requiresProjectCitations: boolean;
}): ProjectChatPublicationIssue[] {
  const issues: ProjectChatPublicationIssue[] = [];
  const internalTags = Array.from(input.answer.matchAll(internalProtocolTagPattern));
  if (internalTags.length) {
    issues.push({
      code: "internal_protocol_exposed",
      explanation: "The answer exposes internal conversation or provenance transport syntax.",
    });
  }
  internalProtocolTagPattern.lastIndex = 0;

  if (!input.requiresProjectCitations) return issues;
  const segments = groundingSegments(input.answer);
  const substantiveIndexes = segments
    .map((segment, index) => substantiveClaimBlock(segment.content) ? index : -1)
    .filter((index) => index >= 0);
  for (const [substantivePosition, segmentIndex] of substantiveIndexes.entries()) {
    const segment = segments[segmentIndex]!;
    // Permit one short opening transition before the grounded body. It can
    // introduce the response, but every subsequent substantive claim block
    // must carry its own source attachment.
    const isOpeningTransition = substantivePosition === 0 &&
      segmentIndex === 0 &&
      substantiveIndexes.length > 1 &&
      visibleClaimText(segment.content).length <= 120;
    if (!segment.cited && !isOpeningTransition) {
      issues.push({
        code: "uncited_project_claim_block",
        explanation: `Substantive project claim block ${substantivePosition + 1} has no inline source attachment.`,
      });
    }
  }
  return issues;
}

export function projectChatAnswerExposesInternalProtocol(answer: string) {
  const exposed = internalProtocolTagPattern.test(answer);
  internalProtocolTagPattern.lastIndex = 0;
  return exposed;
}

export function safeProjectChatPublishedContent(answer: string) {
  return projectChatAnswerExposesInternalProtocol(answer)
    ? { safe: false as const, content: WITHHELD_PROJECT_CHAT_ANSWER }
    : { safe: true as const, content: answer };
}
