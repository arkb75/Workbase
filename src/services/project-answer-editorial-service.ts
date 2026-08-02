import type { GroundedAnswerBlock } from "@/src/domain/project-chat";
import { inferProjectSubsystemKey } from "@/src/domain/project-subsystems";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";

export type ProjectAnswerEditorialKind =
  | "accomplishment"
  | "architecture"
  | "overview"
  | "assessment"
  | "comparison"
  | "focused";

export type ProjectAnswerAudience =
  | "general"
  | "recruiter"
  | "hiring_manager"
  | "executive"
  | "technical";

export type ProjectAnswerDepth = "concise" | "standard" | "detailed";
export type ProjectAnswerFormat = "headings" | "bullets" | "table" | "paragraphs";

export type ProjectAnswerComparisonTemporalRole = "earlier" | "current" | null;

export interface ProjectAnswerComparisonSubject {
  /** The bounded subject phrase as written in the current user request. */
  label: string;
  /** A presentation-safe form of the user phrase; never an internal theme label. */
  heading: string;
  temporalRole: ProjectAnswerComparisonTemporalRole;
  /** Compact conversational context that resolves a referential subject. */
  resolvedAnchor: string | null;
}

export interface ProjectAnswerComparisonContract {
  subjects: [
    ProjectAnswerComparisonSubject,
    ProjectAnswerComparisonSubject,
  ];
  requestedDimensions: string[];
}

export interface ProjectAnswerComparisonContext {
  rollingSummary?: string | null;
  priorUserObjective?: string | null;
  priorAssistantAnswer?: string | null;
}

export interface ProjectAnswerEditorialProfile {
  kind: ProjectAnswerEditorialKind;
  audience: ProjectAnswerAudience;
  depth: ProjectAnswerDepth;
  format: ProjectAnswerFormat;
  requestedItemCount: number | null;
  comprehensive: boolean;
  focusTerms: string[];
  comparisonContract: ProjectAnswerComparisonContract | null;
  targetItemCount: {
    minimum: number;
    preferred: number;
    maximum: number;
  };
}

export interface EditorialScoreComponents {
  queryRelevance: number;
  lexicalQueryRelevance: number;
  semanticConceptMatch: number;
  productValue: number;
  implementationBreadth: number;
  technicalDifficulty: number;
  evidenceStrength: number;
  distinctiveness: number;
  freshness: number;
  impact: number;
  currentRun: number;
  authority: number;
  uncertaintyPenalty: number;
  lowLevelPenalty: number;
}

export interface RankedEditorialEntry {
  entry: ProjectAnswerGroundingEntry;
  entryIndex: number;
  score: number;
  components: EditorialScoreComponents;
  highPriority: boolean;
  lowLevelDetail: boolean;
}

export interface ProjectAnswerEditorialTheme {
  key: string;
  label: string;
  subsystemKeys: string[];
  members: RankedEditorialEntry[];
  highPriorityMembers: RankedEditorialEntry[];
  representativeMembers: RankedEditorialEntry[];
  score: number;
}

export interface ProjectAnswerComparisonBinding {
  subjectIndex: 0 | 1;
  themeKey: string;
  /** Entry indexes whose exact text establishes this side and every requested dimension. */
  evidenceEntryIndexes: number[];
  supportedDimensions: string[];
}

export interface ProjectAnswerEditorialSelection {
  profile: ProjectAnswerEditorialProfile;
  rankedEntries: RankedEditorialEntry[];
  themes: ProjectAnswerEditorialTheme[];
  selectedThemes: ProjectAnswerEditorialTheme[];
  omittedThemes: ProjectAnswerEditorialTheme[];
  highPriorityMembers: RankedEditorialEntry[];
  ownershipCitationIndexes: number[];
  comparisonBindings: [
    ProjectAnswerComparisonBinding,
    ProjectAnswerComparisonBinding,
  ] | null;
}

export interface ProjectAnswerEditorialQualityAudit {
  passed: boolean;
  checks: {
    format: boolean;
    itemCount: boolean;
    prioritization: boolean;
    depth: boolean;
    mechanism: boolean;
    value: boolean;
    analysis: boolean;
    nonredundant: boolean;
    lowLevelDetail: boolean;
    genericVerificationErrorFree: boolean;
    comparisonContract: boolean;
  };
  actualItemCount: number;
  expectedItemCount: ProjectAnswerEditorialProfile["targetItemCount"];
  representedThemeKeys: string[];
  missingPriorityThemeKeys: string[];
  outOfOrderThemeKeys: string[];
  mechanismBlockCount: number;
  valueBlockCount: number;
  lowLevelDetailBlocks: number[];
  redundantBlockPairs: Array<[number, number]>;
}

const numberWords = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

const generalPromptTerms = new Set([
  "about", "accomplishment", "accomplishments", "achievement", "achievements",
  "answer", "assess", "assessment", "best", "brief", "capabilities", "capability",
  "compare", "comparison", "comprehensive", "concise", "current", "currently",
  "detailed", "explain", "give", "high", "information", "key", "latest", "main",
  "major", "make", "most", "overview", "project", "rank", "recent", "strongest",
  "summarize", "summary", "system", "technical", "tell", "thing", "things",
  "update", "updated", "work",
]);

const editorialTokenStopWords = new Set([
  ...generalPromptTerms,
  "and", "are", "built", "created", "developed", "did", "does", "for", "from",
  "has", "have", "how", "implemented", "into", "its", "that", "the", "this",
  "through", "using", "what", "which", "with", "workbase", "you", "your",
]);

const lowLevelDetailPattern =
  /(?:^|[\s`(])(?:src|app|lib|prisma|scripts|workflows)\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|prisma|sql)\b|\b\d{2,4}[- ]dimensional\b|\b(?:column|field|variable|property|encoding|binary file|error code|schema field)s?\b|\b(?:analyzerVersion|policyVersion|semanticVersion|staticVersion)\b/i;

const mechanismPattern =
  /\b(?:by|through|using|via|pipeline|workflow|service|runtime|retrieval|routing|orchestrat\w*|reconcil\w*|synthesi[sz]\w*|persist\w*|validat\w*|ingest\w*|refresh\w*|cluster\w*|embed\w*|stream\w*|coordinate\w*)\b/i;

const valuePattern =
  /\b(?:so that|in order to|enabl\w*|allow\w*|support\w*|prevent\w*|avoid\w*|preserv\w*|ground\w*|safe\w*|trust\w*|reliab\w*|recover\w*|resume\w*|career|user\w*|review\w*|current|fresh\w*|accur\w*|reduce\w*|improv\w*|turns?|produces?)\b/i;

const assessmentPattern =
  /\b(?:strength|weakness|risk|gap|limitation|trade[- ]?off|maturity|concern|opportunity|improve|recommend)\w*/i;

const comparisonPattern =
  /\b(?:compared? (?:with|to)|whereas|while|versus|vs\.?|difference|trade[- ]?off|both|unlike|respectively)\b/i;

const comparisonIntentPattern =
  /(?:\b(?:compar(?:e|ed|es|ing)|comparison|contrast(?:ed|s|ing)?|versus|vs|differences?\s+between)\b|\bhow\s+(?:does|do|did|would)\b.{0,180}\band\b.{0,180}\bdiffer(?:s|ed)?\b|\b(?:differ(?:s|ed|ing)?|different)\b.{0,180}\b(?:from|than)\b|\bdifferentiat(?:e|es|ed|ing)\b.{0,180}\bfrom\b|\bdistinguish(?:es|ed|ing)?\b.{0,180}\bfrom\b|\btrade[- ]?offs?\s+between\b|\bvs\.(?=\s|$))/i;

const genericVerificationErrorPattern =
  /\b(?:the answer could not be verified against its sources|could not be verified against (?:its|the) sources|grounding verifier returned no supported|citation integrity failed|durable agent run failed unexpectedly|durable agent run failed without)\b/i;

function clampScore(value: number | null | undefined, fallback: number) {
  return Math.max(0, Math.min(5, typeof value === "number" && Number.isFinite(value) ? value : fallback));
}

function stem(term: string) {
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ing") && term.length > 5) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 4) return term.slice(0, -2);
  if (term.endsWith("es") && term.length > 4) return term.slice(0, -2);
  if (term.endsWith("s") && term.length > 3) return term.slice(0, -1);
  return term;
}

function tokens(value: string, stopWords = editorialTokenStopWords) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      // Filter natural-language stop words before applying the intentionally
      // small stemmer. Otherwise common words such as "this" and "does" become
      // synthetic query terms ("thi", "doe") that dilute focused relevance.
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .map(stem)
      .filter((term) => term.length > 2),
  );
}

function lexicalSimilarity(left: string, right: string) {
  const leftTerms = tokens(left);
  const rightTerms = tokens(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  const overlap = Array.from(leftTerms).filter((term) => rightTerms.has(term)).length;
  return overlap / new Set([...leftTerms, ...rightTerms]).size;
}

const editorialRedundancyThreshold = 0.65;

function explicitItemCount(question: string) {
  const match = question.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:[a-z][\w-]*\s+){0,4}(?:accomplishments?|achievements?|items?|bullets?|points?|steps?|sections?|themes?|paragraphs?|sentences?|strengths?|risks?|limitations?|capabilities?|trade[- ]?offs?|decisions?|comparisons?|findings?|recommendations?|advantages?)\b/i,
  );
  if (!match?.[1]) return null;
  const normalized = match[1].toLowerCase();
  const value = numberWords.get(normalized) ?? Number(normalized);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
}

function classifyKind(question: string): ProjectAnswerEditorialKind {
  if (comparisonIntentPattern.test(question)) {
    return "comparison";
  }
  if (/\b(?:strengths?(?: and weaknesses?)?|weaknesses?|risks?|maturity|gaps?|limitations?|trade[- ]?offs?|design decisions?|assess(?:ment)?|evaluate|critique|what should .*improve)\b/i.test(question)) {
    return "assessment";
  }
  if (
    /\b(?:strongest|top|best|key|major|most impressive|most difficult|hardest|distinctive)\b.{0,100}\b(?:accomplishments?|achievements?|contributions?|work|features?|systems?)\b|\b(?:accomplishments?|achievements?|contributions?)\b|\bwhat (?:did|have) (?:i|we|you) (?:build|implement|create|ship)\b/i.test(
      question,
    ) ||
    /\b(?:hardest|most difficult|most valuable)\s+(?:parts?|problems?|challenges?)\b.{0,120}\b(?:build|built|solve|deliver|create)\b/i.test(question)
  ) {
    return "accomplishment";
  }
  if (/\b(?:architecture|system design|data flow|pipeline)\b/i.test(question)) {
    return "architecture";
  }
  if (
    /\b(?:how|explain)\b.{0,80}\b(?:repository|github|source code|code)\b.{0,120}\b(?:project knowledge|durable memory|reusable (?:memory|knowledge)|trusted (?:memory|knowledge))\b/i.test(
      question,
    )
  ) {
    return "architecture";
  }
  if (/\b(?:overview|gist|summari[sz]e|tell me about|describe (?:workbase(?!['’]s)|this|the project)|explain (?:workbase(?!['’]s)|this|the project)|what (?:is|does) (?:this|the) project|why (?:this|the) project (?:would )?matter|whole project|project-wide)\b/i.test(question)) {
    return "overview";
  }
  return "focused";
}

function classifyAudience(question: string): ProjectAnswerAudience {
  if (/\b(?:recruiter|talent|resume screener)\b/i.test(question)) return "recruiter";
  if (/\b(?:hiring manager|interview panel)\b/i.test(question)) return "hiring_manager";
  if (/\b(?:executive|leadership|stakeholder|nontechnical|non-technical)\b/i.test(question)) return "executive";
  if (/\b(?:senior engineer|staff engineer|architect|technical audience|technical interview|engineering team)\b/i.test(question)) {
    return "technical";
  }
  return "general";
}

function classifyFormat(question: string): ProjectAnswerFormat {
  if (/\btable\b/i.test(question)) return "table";
  if (/\b(?:bullets?|bullet points?|list)\b/i.test(question)) return "bullets";
  if (/\b(?:one |single )?paragraphs?\b/i.test(question)) return "paragraphs";
  return "headings";
}

function classifyDepth(question: string): ProjectAnswerDepth {
  if (/\b(?:concise|brief|short|quick|tl;?dr|under \d+ words?|\d+[- ]word)\b/i.test(question)) {
    return "concise";
  }
  if (/\b(?:detailed|in[- ]depth|deep dive|thorough|comprehensive|exhaustive)\b/i.test(question)) {
    return "detailed";
  }
  return "standard";
}

function extractFocusTerms(question: string) {
  return Array.from(tokens(question, new Set([...editorialTokenStopWords, ...generalPromptTerms]))).slice(0, 12);
}

const comparisonPresentationSuffixPattern =
  /\s+(?:(?:in|as)\s+(?:a|an)\s+)?(?:(?:concise|brief|detailed|formatted|two-column|side-by-side)\s+)?(?:markdown\s+)?(?:table|list|answer|comparison|format)\b.*$/i;

function cleanComparisonSubject(value: string) {
  return value
    .replace(comparisonPresentationSuffixPattern, "")
    .replace(
      /^(?:please\s+)?(?:give|show|explain|describe|provide|write|make)\s+(?:me\s+)?(?:a\s+)?/i,
      "",
    )
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`,;:]+$/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function comparisonSubjectHeading(value: string) {
  const heading = value
    .replace(/^(?:that|this|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!heading) return value;
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`.slice(0, 160);
}

function comparisonTemporalRole(value: string): ProjectAnswerComparisonTemporalRole {
  if (/\b(?:earlier|prior|previous|former|original|before)\b/i.test(value)) return "earlier";
  if (/\b(?:current|present|latest|newer|now|today)\b/i.test(value)) return "current";
  return null;
}

function splitComparisonDimensions(value: string | undefined) {
  if (!value) return [];
  const cleaned = value
    .replace(comparisonPresentationSuffixPattern, "")
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!cleaned) return [];
  return Array.from(new Set(
    cleaned
      .split(/\s*,\s*|\s+(?:and|or)\s+/i)
      .map((dimension) =>
        dimension.replace(/^(?:(?:and|or)\s+)?(?:the|their|its)?\s*/i, "").trim()
      )
      .filter((dimension) => dimension.length >= 2 && dimension.length <= 100),
  )).slice(0, 6);
}

interface ExtractedComparisonSubjects {
  subjects: [string, string];
  subjectEndIndex: number;
}

const bareComparisonDimensionStart =
  "(?:latency|delay|speed|throughput|performance|response\\s+time|failure|recovery|resilien\\w*|retry|fault\\s+tolerance|cost|price|spend|expense|complexity|operational(?:\\s+complexity)?|operations?|maintenance|operability|security|privacy|authorization|access|reliability|scalability|accuracy|correctness|quality)";

function extractComparisonDimensions(
  question: string,
  extracted: ExtractedComparisonSubjects | null,
) {
  const normalizedQuestion = question.replace(/\s+/g, " ").trim();
  const suffix = extracted
    ? normalizedQuestion.slice(extracted.subjectEndIndex)
    : "";
  const explicitLens = suffix.match(
    /^\s+(?:in terms of|with respect to|focusing on|across|regarding|on the dimensions? of)\s+(.+?)(?=[?.!]|$|\s+(?:(?:in|as)\s+(?:a|an)\s+)?(?:(?:concise|brief|detailed|formatted|two-column|side-by-side)\s+)?(?:markdown\s+)?(?:table|list|answer|comparison|format)\b)/i,
  );
  if (explicitLens?.[1]) return splitComparisonDimensions(explicitLens[1]);
  const bareOnLens = suffix.match(
    new RegExp(
      `^\\s+(?:on|in)\\s+(${bareComparisonDimensionStart}\\b.+?|${bareComparisonDimensionStart})(?=[?.!]|$|\\s+(?:(?:in|as)\\s+(?:a|an)\\s+)?(?:(?:concise|brief|detailed|formatted|two-column|side-by-side)\\s+)?(?:markdown\\s+)?(?:table|list|answer|comparison|format)\\b)`,
      "i",
    ),
  );
  if (bareOnLens?.[1]) {
    return splitComparisonDimensions(bareOnLens[1]);
  }
  const followUpInstruction = question.match(
    /(?:^|[.!?]\s+)\b(?:explain|cover|include|address)\s+(.+?)(?=[.!?]|$)/i,
  );
  return splitComparisonDimensions(followUpInstruction?.[1]);
}

function extractComparisonSubjects(
  question: string,
): ExtractedComparisonSubjects | null {
  const normalized = question.replace(/\s+/g, " ").trim();
  const terminal =
    `(?=$|[?.!]|\\s+(?:in terms of|with respect to|focusing on|across|regarding|on the dimensions? of)\\b|\\s+(?:on|in)\\s+(?=${bareComparisonDimensionStart}\\b)|\\s+(?:(?:in|as)\\s+(?:a|an)\\s+)?(?:(?:concise|brief|detailed|formatted|two-column|side-by-side)\\s+)?(?:markdown\\s+)?(?:table|list|answer|comparison|format)\\b)`;
  const patterns = [
    new RegExp(
      `\\bhow\\s+(?:does|do|did|would)\\s+(.+?)\\s+and\\s+(.+?)\\s+differ(?:s|ed)?${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bhow\\s+(?:does|do|did|would)\\s+(.+?)\\s+and\\s+(.+?)\\s+compare${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bhow\\s+(?:does|do|did|would)\\s+(.+?)\\s+compare\\s+(?:with|to|against)\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bhow\\s+(?:does|do|did|would)\\s+(.+?)\\s+differ(?:s|ed)?\\s+from\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bhow\\s+(?:is|are|was|were)\\s+(.+?)\\s+different\\s+(?:from|than)\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `(?:^|[.!?]\\s+)(.+?)\\s+(?:is|are|was|were)\\s+different\\s+(?:from|than)\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bwhat\\s+differentiat(?:e|es|ed)\\s+(.+?)\\s+from\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\bwhat\\s+distinguish(?:es|ed)?\\s+(.+?)\\s+from\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:compare|compared|comparing|contrast|contrasted|contrasting)\\s+(.+?)\\s+(?:with|to|against|versus|vs\\.?)\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:difference|differences)\\s+between\\s+(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\btrade[- ]?offs?\\s+between\\s+(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:compare|contrast)\\s+between\\s+(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:compare|compared|comparing|contrast|contrasted|contrasting)\\s+(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:a|the)?\\s*comparison\\s+(?:of|between)\\s+(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `\\b(?:a|the)?\\s*comparison\\s*:\\s*(.+?)\\s+and\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `(?:^|[.!?]\\s+)(.+?)\\s+(?:compared|contrasted)\\s+(?:with|to|against)\\s+(.+?)${terminal}`,
      "i",
    ),
    new RegExp(
      `(?:^|[.!?]\\s+)(.+?)\\s+(?:versus|vs\\.?)\\s+(.+?)${terminal}`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const first = cleanComparisonSubject(match?.[1] ?? "");
    const second = cleanComparisonSubject(match?.[2] ?? "");
    if (
      first &&
      second &&
      first.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() !==
        second.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    ) {
      return {
        subjects: [first, second],
        subjectEndIndex: (match?.index ?? 0) + (match?.[0]?.length ?? 0),
      };
    }
  }
  return null;
}

const referentialComparisonSubjectPattern =
  /\b(?:that|this|those|these|earlier|prior|previous|former|original|current|present|latest|newer|now|today|one|ones)\b/i;

const demonstrativeComparisonSubjectPattern =
  /\b(?:that|this|those|these|one|ones)\b/i;

const earlierComparisonEvidencePattern =
  /\b(?:earlier|prior|previous|former|original|before|historical|legacy|formerly|used to|decision|decided|admit(?:ted|s)?|reviewed|durable memory|provenance)\b/i;

const currentComparisonEvidencePattern =
  /\b(?:current|present|latest|newer|now|today|runtime|execution)\b/i;

function compactComparisonAnchor(value: string) {
  return value
    .replace(/\[citation:\d+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function resolveComparisonAnchor(
  subject: string,
  role: ProjectAnswerComparisonTemporalRole,
  context: ProjectAnswerComparisonContext,
) {
  if (!referentialComparisonSubjectPattern.test(subject)) return null;
  const subjectTerms = tokens(subject, new Set([
    ...editorialTokenStopWords,
    "approach",
    "current",
    "decision",
    "earlier",
    "one",
    "previous",
    "prior",
    "runtime",
    "that",
    "this",
  ]));
  const candidates = [
    { value: context.rollingSummary, source: "summary" as const },
    { value: context.priorAssistantAnswer, source: "assistant" as const },
    { value: context.priorUserObjective, source: "user" as const },
  ].flatMap(({ value, source }, sourceOrder) =>
    (value ?? "")
      .split(/\n+|(?<=[.!?])\s+/)
      .map(compactComparisonAnchor)
      .filter(Boolean)
      .map((text, textOrder) => ({ text, source, sourceOrder, textOrder }))
  );
  const ranked = candidates
    .map((candidate) => {
      const candidateTerms = tokens(candidate.text);
      const overlap = Array.from(subjectTerms).filter((term) => candidateTerms.has(term)).length;
      const temporal =
        role === "earlier"
          ? Number(/\b(?:earlier|prior|previous|decision|decided|approach|policy)\b/i.test(candidate.text))
          : role === "current"
            ? Number(/\b(?:current|present|latest|runtime|now)\b/i.test(candidate.text))
            : 0;
      const sourcePrecedence =
        role === "earlier"
          ? Number(candidate.source === "summary") * 2
          : role === "current"
            ? candidate.source === "assistant"
              ? 2
              : Number(candidate.source === "user")
            : Number(candidate.source === "assistant");
      return {
        ...candidate,
        score: overlap * 4 + temporal * 3 + sourcePrecedence,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.sourceOrder - right.sourceOrder ||
      left.textOrder - right.textOrder
    );
  return ranked[0]?.text ?? null;
}

export function deriveProjectAnswerComparisonContract(
  question: string,
  context: ProjectAnswerComparisonContext = {},
): ProjectAnswerComparisonContract | null {
  const extracted = extractComparisonSubjects(question);
  if (!extracted) return null;
  const { subjects } = extracted;
  return {
    subjects: subjects.map((label) => {
      const temporalRole = comparisonTemporalRole(label);
      return {
        label,
        heading: comparisonSubjectHeading(label),
        temporalRole,
        resolvedAnchor: resolveComparisonAnchor(label, temporalRole, context),
      };
    }) as ProjectAnswerComparisonContract["subjects"],
    requestedDimensions: extractComparisonDimensions(question, extracted),
  };
}

function targetCount(input: {
  kind: ProjectAnswerEditorialKind;
  depth: ProjectAnswerDepth;
  comprehensive: boolean;
  requestedItemCount: number | null;
}) {
  if (input.requestedItemCount) {
    return {
      minimum: input.requestedItemCount,
      preferred: input.requestedItemCount,
      maximum: input.requestedItemCount,
    };
  }
  // "Comprehensive" is an explicit coverage contract. Select every supported
  // distinct inventory theme up to the hard ten-theme presentation ceiling.
  if (input.comprehensive) return { minimum: 7, preferred: 10, maximum: 10 };
  const defaults: Record<ProjectAnswerEditorialKind, { minimum: number; preferred: number; maximum: number }> = {
    accomplishment: { minimum: 4, preferred: 5, maximum: 6 },
    architecture: { minimum: 4, preferred: 5, maximum: 6 },
    overview: { minimum: 3, preferred: 4, maximum: 5 },
    assessment: { minimum: 4, preferred: 5, maximum: 6 },
    comparison: { minimum: 2, preferred: 2, maximum: 4 },
    focused: { minimum: 1, preferred: 2, maximum: 3 },
  };
  const selected = defaults[input.kind];
  if (input.depth === "concise") {
    const preferred = Math.min(selected.preferred, input.kind === "focused" ? 2 : 4);
    return {
      minimum: Math.min(selected.minimum, preferred),
      preferred,
      maximum: preferred,
    };
  }
  if (input.depth === "detailed") {
    return {
      minimum: selected.minimum,
      preferred: selected.maximum,
      maximum: Math.min(8, selected.maximum + 1),
    };
  }
  return selected;
}

export function classifyProjectAnswerEditorialProfile(
  question: string,
  comparisonContext: ProjectAnswerComparisonContext = {},
): ProjectAnswerEditorialProfile {
  const kind = classifyKind(question);
  const audience = classifyAudience(question);
  const depth = classifyDepth(question);
  const format = classifyFormat(question);
  const requestedItemCount = explicitItemCount(question);
  const comprehensive =
    /\b(?:comprehensive|exhaustive|complete inventory|cover everything|all major (?:capabilities|systems|areas)|whole codebase)\b/i.test(
      question,
    );
  const itemCountTarget = targetCount({ kind, depth, comprehensive, requestedItemCount });
  const focusedCrossBoundaryTopic =
    kind === "focused" &&
    /\b(?:(?:explor\w*|inspect\w*).{0,80}(?:unused|unreferenced|source|citation)|(?:unused|unreferenced).{0,80}(?:files?|source|citation)|artifact.{0,80}(?:fallback|insufficient|evidence gap)|approved highlights?.{0,60}insufficient)\b/i.test(
      question,
    );
  const focusedSingleTopic =
    kind === "focused" &&
    !comprehensive &&
    requestedItemCount == null &&
    !focusedCrossBoundaryTopic &&
    (
      !/\b(?:and|together|both|across|versus|vs\.?)\b/i.test(question) ||
      (
        /\bresilien\w*\b/i.test(question) &&
        /\brecover\w*\b/i.test(question)
      )
    );
  return {
    kind,
    audience,
    depth,
    format,
    requestedItemCount,
    comprehensive,
    focusTerms: extractFocusTerms(question),
    comparisonContract: kind === "comparison"
      ? deriveProjectAnswerComparisonContract(question, comparisonContext)
      : null,
    targetItemCount: focusedSingleTopic
      ? { minimum: 1, preferred: 1, maximum: 2 }
      : itemCountTarget,
  };
}

function authorityScore(entry: ProjectAnswerGroundingEntry) {
  if (entry.authority === "verified_highlight" || entry.authority === "verified_project_fact") return 3;
  if (entry.authority === "included_evidence") return 2;
  if (entry.authority === "prior_artifact") return 1;
  return 0;
}

function lexicalQueryRelevance(
  entry: ProjectAnswerGroundingEntry,
  profile: ProjectAnswerEditorialProfile,
) {
  if (!profile.focusTerms.length) return profile.kind === "focused" ? 0 : 2.5;
  const entryTerms = tokens(`${entry.title} ${entry.content} ${entry.subsystemKey ?? ""}`);
  const overlap = profile.focusTerms.filter((term) => entryTerms.has(stem(term))).length;
  return Math.min(5, (overlap / profile.focusTerms.length) * 5);
}

function queryRelevance(entry: ProjectAnswerGroundingEntry, profile: ProjectAnswerEditorialProfile) {
  const retrievalRelevance = Math.max(
    0,
    Math.min(1, entry.retrievalRelevance ?? 0),
  ) * 5;
  return Math.max(
    retrievalRelevance,
    lexicalQueryRelevance(entry, profile),
  );
}

const focusedSemanticConcepts = [
  {
    query: /\b(?:security|secure|secrets?|credentials?|threat|trust boundary|posture)\b/i,
    entry: /\b(?:redact\w*|secrets?|credentials?|oauth|authori[sz]\w*|permissions?|attached repositor|bounded repository|repository (?:access|exploration)|untrusted|access control)\b/i,
  },
  {
    query: /\b(?:authentication|authorization|permissions?|access control|oauth)\b/i,
    entry: /\b(?:oauth|authentication|authorization|permissions?|attached repositor|work item ownership|access control)\b/i,
  },
  {
    query: /\b(?:resilien\w*|recovery|recover\w*|fault tolerance|interruption)\b/i,
    entry: /\b(?:durable workflow|resume\w*|recover\w*|retr(?:y|ied|ies)|partial result|progress events?|idempot\w*|(?:run|workflow|progress|state).{0,30}persist\w*|persist\w*.{0,30}(?:run|workflow|progress|state))\b/i,
  },
  {
    query: /\b(?:cdn|deployment topology|hosting topology|production deployment|edge network|load balancer)\b/i,
    entry: /\b(?:cdn|content delivery network|deployment topology|hosting topology|production deploy\w*|edge network|load balancer|cloudfront|vercel deploy\w*|container orchestrat\w*|kubernetes|ecs|lambda)\b/i,
  },
  {
    query: /\b(?:(?:repo(?:sitory)?|repository).{0,40}(?:know\w*\s+)?refresh|refresh\w*.{0,50}stale|stale.{0,50}refresh\w*)\b/i,
    entry: /\b(?:repository knowledge|knowledge refresh|refresh\w*|reconcil\w*|stale knowledge|current (?:files?|source|repository)|incremental analys\w*)\b/i,
  },
  {
    query: /\b(?:targeted|specific|focused|bounded)\b.{0,50}\b(?:repo(?:sitory)?|code|source)?\s*(?:research|investigation|exploration)\b|\b(?:repo(?:sitory)?|code|source)\b.{0,50}\b(?:research|investigation|exploration)\b/i,
    entry: /\b(?:targeted|focused|bounded|specific)\b.{0,60}\b(?:research|exploration|search|read|retrieval|evidence gap)\b|\b(?:project chat|hybrid retrieval|grounded follow-up|reviewed durable memory)\b/i,
  },
  {
    query: /\b(?:(?:explor\w*|inspect\w*).{0,60}(?:unus\w*|source|citation)|(?:unus\w*|unreferenced).{0,60}(?:files?|source|citation)|citation\w*|provenance)\b/i,
    entry: /\b(?:hybrid retrieval|citation (?:tracking|pruning|selection)|explored evidence|explored-but-unused|unreferenced|provenance|peer sources?|project facts?|highlights?|durable memory|nested (?:repository )?excerpts?)\b/i,
  },
  {
    query: /\b(?:data model|stor\w*|persist\w*|version\w*|correct\w*|retir\w*|supersed\w*|stale facts?|knowledge lifecycle)\b/i,
    entry: /\b(?:prisma|data model|persist\w*|version\w*|supersed\w*|retir\w*|stale|embedding|immutable successors?|audit trail)\b/i,
  },
  {
    query: /\b(?:(?:artifact|highlight).{0,80}(?:fallback|insufficient|evidence gap)|approved highlights?.{0,60}insufficient)\b/i,
    entry: /\b(?:artifact|approved highlights?|bounded research|evidence gap|approval hook|human review|pause\w*.{0,30}resume\w*)\b/i,
  },
  {
    query: /\b(?:(?:openrouter|bedrock|model (?:runtime|tool loop)|tool loop|ai runtime).{0,100}durable workflow|durable workflow.{0,100}(?:openrouter|bedrock|model (?:runtime|tool loop)|tool loop|ai runtime))\b/i,
    entry: /\b(?:openrouter|bedrock|model (?:runtime|provider|routing)|tool loop|ai runtime|durable workflow|approval hook|pause\w*.{0,30}resume\w*|iteration|tool-call|token (?:limit|budget))\b/i,
  },
  {
    query: /\b(?:test(?:ing)? strategy|automated tests?|test coverage|regression|evaluation suite)\b/i,
    entry: /\b(?:vitest|automated tests?|test coverage|evaluation|scenario tests?|regression|integration tests?|workflow tests?)\b/i,
  },
  {
    query: /\b(?:github|oauth|repository ingestion|repo ingestion|code exploration)\b/i,
    entry: /\b(?:github|oauth|ingest\w*|import\w*|repository exploration|tree\/search\/read|read\/byte\/time budgets?)\b/i,
  },
  {
    query: /\b(?:workspace|review experience|review ui|user-facing|frontend)\b/i,
    entry: /\b(?:workspace|review ui|review experience|highlight review|candidate review|citation navigation|artifact history|lifecycle state)\b/i,
  },
  {
    query: /\b(?:chat layer|supporting evidence|evidence is missing|missing evidence|insufficient evidence|cannot answer|can't answer)\b/i,
    entry: /\b(?:project chat|fail[- ]closed|supporting evidence|insufficient (?:context|evidence)|does not (?:answer|guess)|refus\w*|coverage gap)\b/i,
  },
] as const;

function semanticConceptMatch(
  entry: ProjectAnswerGroundingEntry,
  profile: ProjectAnswerEditorialProfile,
) {
  const query = profile.focusTerms.join(" ");
  const content = `${entry.title} ${entry.content} ${entry.subsystemKey ?? ""}`;
  return focusedSemanticConcepts.some((concept) =>
    concept.query.test(query) && concept.entry.test(content)
  );
}

export function scoreProjectAnswerEditorialEntry(input: {
  entry: ProjectAnswerGroundingEntry;
  entryIndex: number;
  profile: ProjectAnswerEditorialProfile;
}): RankedEditorialEntry {
  const ranking = input.entry.accomplishmentRanking;
  const evidenceStrength = clampScore(ranking?.evidenceStrength, input.entry.citationIndexes.length ? 3 : 0);
  const productValue = clampScore(ranking?.productImportance, 2);
  const implementationBreadth = clampScore(ranking?.implementationBreadth, 2);
  const technicalDifficulty = clampScore(ranking?.technicalDifficulty, 2);
  const distinctiveness = clampScore(ranking?.distinctiveness, 2);
  const freshness = clampScore(ranking?.freshness, input.entry.currentRun ? 5 : 2);
  const relevance = queryRelevance(input.entry, input.profile);
  const lexicalRelevance = lexicalQueryRelevance(input.entry, input.profile);
  const conceptMatch = semanticConceptMatch(input.entry, input.profile);
  const impact = Math.max(0, Math.min(10, ranking?.impactBonus ?? 0));
  const currentRun = input.entry.currentRun ? 4 : 0;
  const authority = authorityScore(input.entry);
  const uncertaintyPenalty = ranking?.uncertainty ? 3 : 0;
  const lowLevelDetail = lowLevelDetailPattern.test(`${input.entry.title} ${input.entry.content}`);
  const lowLevelPenalty = lowLevelDetail && input.profile.kind !== "focused" ? 20 : 0;
  const components: EditorialScoreComponents = {
    queryRelevance: relevance * 6,
    lexicalQueryRelevance: lexicalRelevance * 6,
    semanticConceptMatch: conceptMatch
      ? input.entry.kind === "evidence" ? 6 : 12
      : 0,
    productValue: productValue * 5,
    implementationBreadth: implementationBreadth * 4,
    technicalDifficulty: technicalDifficulty * 3,
    evidenceStrength: evidenceStrength * 3,
    distinctiveness: distinctiveness * 2,
    freshness,
    impact,
    currentRun,
    authority,
    uncertaintyPenalty,
    lowLevelPenalty,
  };
  const score = components.queryRelevance +
    components.semanticConceptMatch +
    components.productValue +
    components.implementationBreadth +
    components.technicalDifficulty +
    components.evidenceStrength +
    components.distinctiveness +
    components.freshness +
    components.impact +
    components.currentRun +
    components.authority -
    components.uncertaintyPenalty -
    components.lowLevelPenalty;
  return {
    entry: input.entry,
    entryIndex: input.entryIndex,
    score: Number(score.toFixed(4)),
    components,
    highPriority:
      productValue >= 4 &&
      implementationBreadth >= 3 &&
      evidenceStrength >= 3,
    lowLevelDetail,
  };
}

export function rankProjectAnswerEditorialEntries(input: {
  question: string;
  entries: ProjectAnswerGroundingEntry[];
  profile?: ProjectAnswerEditorialProfile;
}) {
  const profile = input.profile ?? classifyProjectAnswerEditorialProfile(input.question);
  return input.entries
    .map((entry, entryIndex) => scoreProjectAnswerEditorialEntry({ entry, entryIndex, profile }))
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.entry.currentRun) - Number(left.entry.currentRun) ||
      left.entry.title.localeCompare(right.entry.title)
    );
}

const readerThemeDefinitions = [
  {
    key: "product_outcomes",
    label: "Career Content Product & Trustworthy Artifact Pipeline",
    subsystemKeys: ["product_surface", "artifact_generation"],
    readerValue: 6,
  },
  {
    key: "repository_intelligence",
    label: "Incremental Repository Intelligence",
    subsystemKeys: ["repository_knowledge_lifecycle", "ingestion_integrations"],
    readerValue: 5.5,
  },
  {
    key: "grounded_project_agent",
    label: "Grounded Multi-Turn Project Agent",
    subsystemKeys: ["project_chat_grounding", "retrieval_provenance"],
    readerValue: 5.5,
  },
  {
    key: "trusted_knowledge_lifecycle",
    label: "Reviewable and Versioned Project Knowledge",
    subsystemKeys: ["knowledge_review_lifecycle", "review_ui"],
    readerValue: 4.5,
  },
  {
    key: "durable_ai_platform",
    label: "Durable, Bounded AI Execution",
    subsystemKeys: ["workflow_orchestration", "ai_runtime"],
    readerValue: 5,
  },
  {
    key: "engineering_foundation",
    label: "Data and Quality Foundation",
    subsystemKeys: ["domain_data", "tests_operations"],
    readerValue: 2.5,
  },
] as const;

const inventoryThemeDefinitions = [
  {
    key: "product_and_artifact_generation",
    label: "Career Content Product & Artifact Pipeline",
    subsystemKeys: ["product_surface", "artifact_generation"],
  },
  {
    key: "repository_knowledge_lifecycle",
    label: "Repository Knowledge Lifecycle",
    subsystemKeys: ["repository_knowledge_lifecycle"],
  },
  {
    key: "project_chat_grounding",
    label: "Grounded Multi-Turn Project Chat",
    subsystemKeys: ["project_chat_grounding"],
  },
  {
    key: "knowledge_review_experience",
    label: "Knowledge Review Lifecycle & Workspace",
    subsystemKeys: ["knowledge_review_lifecycle", "review_ui"],
  },
  {
    key: "workflow_orchestration",
    label: "Durable Workflow Orchestration",
    subsystemKeys: ["workflow_orchestration"],
  },
  {
    key: "ai_runtime",
    label: "Structured AI Runtime",
    subsystemKeys: ["ai_runtime"],
  },
  {
    key: "retrieval_provenance",
    label: "Knowledge Retrieval & Provenance",
    subsystemKeys: ["retrieval_provenance"],
  },
  {
    key: "ingestion_integrations",
    label: "GitHub Ingestion & Integrations",
    subsystemKeys: ["ingestion_integrations"],
  },
  {
    key: "domain_data",
    label: "Domain & Data Model",
    subsystemKeys: ["domain_data"],
  },
  {
    key: "tests_operations",
    label: "Automated Testing & Operations",
    subsystemKeys: ["tests_operations"],
  },
] as const;

function diverseRepresentatives(members: RankedEditorialEntry[], limit = 3) {
  const remaining = [...members];
  const selected: RankedEditorialEntry[] = [];
  while (remaining.length && selected.length < limit) {
    const candidates = remaining.filter((candidate) =>
      selected.every((chosen) =>
        lexicalSimilarity(
          `${candidate.entry.title} ${candidate.entry.content}`,
          `${chosen.entry.title} ${chosen.entry.content}`,
        ) < editorialRedundancyThreshold
      )
    );
    if (!candidates.length) break;
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        adjusted: candidate.score -
          30 * Math.max(0, ...selected.map((chosen) =>
            lexicalSimilarity(
              `${candidate.entry.title} ${candidate.entry.content}`,
              `${chosen.entry.title} ${chosen.entry.content}`,
            )
          )),
      }))
      .sort((left, right) => right.adjusted - left.adjusted);
    const next = ranked[0]?.candidate;
    if (!next) break;
    selected.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return selected;
}

function inferredEditorialSubsystemKey(entry: ProjectAnswerGroundingEntry) {
  return entry.subsystemKey ?? inferProjectSubsystemKey({
    text: `${entry.title} ${entry.content}`,
    paths: entry.supportingSources.flatMap((source) => source.path ? [source.path] : []),
  });
}

function themeFromDefinition(
  definition: { key: string; label: string; subsystemKeys: readonly string[]; readerValue?: number },
  rankedEntries: RankedEditorialEntry[],
) {
  const members = rankedEntries.filter((entry) =>
    definition.subsystemKeys.includes(inferredEditorialSubsystemKey(entry.entry) ?? "")
  );
  if (!members.length) return null;
  // Imported commits and README snippets remain useful when no reviewed
  // durable memory covers a focused request. When a reviewed Project Fact or
  // Highlight exists for the same theme, prefer that synthesized statement:
  // terse commit subjects are provenance, not reader-facing accomplishments.
  const durableMembers = members.filter((member) =>
    member.entry.kind === "project_fact" || member.entry.kind === "highlight"
  );
  const directlyMatchedDurable = durableMembers.filter((member) =>
    member.components.semanticConceptMatch >= 12
  );
  const directHighInformationEvidence = members.filter((member) =>
    member.entry.kind === "evidence" &&
    member.components.semanticConceptMatch > 0 &&
    member.entry.content.trim().length >= 120 &&
    !/^(?:feat|fix|chore|refactor|test|docs|build|ci)(?:\([^)]*\))?:/i.test(
      member.entry.title.trim(),
    )
  );
  const representativePool = directlyMatchedDurable.length
    ? durableMembers
    : directHighInformationEvidence.length
      ? [...directHighInformationEvidence, ...durableMembers]
      : durableMembers.length
        ? durableMembers
        : members;
  const representativeMembers = diverseRepresentatives(
    [...representativePool].sort((left, right) =>
      right.components.semanticConceptMatch - left.components.semanticConceptMatch ||
      right.components.lexicalQueryRelevance - left.components.lexicalQueryRelevance ||
      right.score - left.score
    ),
  );
  const highPriorityMembers = members.filter((member) => member.highPriority);
  const score = representativeMembers[0]!.score +
    (representativeMembers[1]?.score ?? 0) * 0.12 +
    (definition.readerValue ?? 0) * 8 +
    Math.min(2, highPriorityMembers.length * 0.25);
  return {
    key: definition.key,
    label: definition.label,
    subsystemKeys: [...definition.subsystemKeys],
    members,
    highPriorityMembers,
    representativeMembers,
    score: Number(score.toFixed(4)),
  } satisfies ProjectAnswerEditorialTheme;
}

function unknownThemes(
  rankedEntries: RankedEditorialEntry[],
  knownSubsystems: Set<string>,
) {
  const grouped = new Map<string, RankedEditorialEntry[]>();
  for (const entry of rankedEntries) {
    const subsystemKey = inferredEditorialSubsystemKey(entry.entry);
    if (!subsystemKey || knownSubsystems.has(subsystemKey)) continue;
    const group = grouped.get(subsystemKey) ?? [];
    group.push(entry);
    grouped.set(subsystemKey, group);
  }
  return Array.from(grouped.entries()).map(([subsystemKey, members]) => {
    const representativeMembers = diverseRepresentatives(
      [...members].sort((left, right) =>
        right.components.semanticConceptMatch - left.components.semanticConceptMatch ||
        right.components.lexicalQueryRelevance - left.components.lexicalQueryRelevance ||
        right.score - left.score
      ),
    );
    return {
      key: subsystemKey,
      label: subsystemKey
        .replace(/^module:/, "")
        .split(/[_-]+/)
        .filter(Boolean)
        .map((term) => `${term.slice(0, 1).toUpperCase()}${term.slice(1)}`)
        .join(" "),
      subsystemKeys: [subsystemKey],
      members,
      highPriorityMembers: members.filter((member) => member.highPriority),
      representativeMembers,
      score: representativeMembers[0]!.score,
    } satisfies ProjectAnswerEditorialTheme;
  });
}

function explicitPriorityFacets(question: string) {
  const clause = question.match(
    /\b(?:prioritize|focus on|cover)\b\s+(.+?)(?=(?:\.\s+|\b(?:omit|exclude|avoid|without|do not include|don't include)\b|$))/i,
  )?.[1];
  if (!clause) return [];
  return clause
    .split(/\s*,\s*|\s+\band\b\s+/i)
    .map((facet) => facet.trim())
    .filter(Boolean);
}

function priorityThemeCandidatesForFacet(facet: string) {
  if (/\b(?:architecture|system design|backend|pipeline|end-to-end)\b/i.test(facet)) {
    return [
      "product_and_artifact_generation",
      "repository_knowledge_lifecycle",
      "workflow_orchestration",
    ];
  }
  if (/\b(?:data integrity|provenance|citation|grounding|traceab)\w*/i.test(facet)) {
    return [
      "retrieval_provenance",
      "domain_data",
      "knowledge_review_experience",
    ];
  }
  if (/\b(?:ai|model|openrouter|bedrock|runtime|tool loop|tool use|agent control)\b/i.test(facet)) {
    return ["ai_runtime", "workflow_orchestration", "project_chat_grounding"];
  }
  if (/\b(?:reliab|resilien|recover|retry|durable|fault toleran)\w*/i.test(facet)) {
    return ["workflow_orchestration", "tests_operations", "knowledge_review_experience"];
  }
  if (/\b(?:repository|github|fresh|current|semantic analys)\w*/i.test(facet)) {
    return ["repository_knowledge_lifecycle", "ingestion_integrations"];
  }
  if (/\b(?:storage|data model|database|persist)\w*/i.test(facet)) {
    return ["domain_data", "knowledge_review_experience"];
  }
  if (/\b(?:review|governance|correct|retir|supersed|lifecycle)\w*/i.test(facet)) {
    return ["knowledge_review_experience", "domain_data"];
  }
  if (/\b(?:test|quality|regression)\w*/i.test(facet)) {
    return ["tests_operations"];
  }
  if (/\b(?:chat|conversation|multi-turn)\b/i.test(facet)) {
    return ["project_chat_grounding", "retrieval_provenance"];
  }
  if (/\b(?:artifact|career|resume|linkedin|product|user value|trustworthy output)\b/i.test(facet)) {
    return ["product_and_artifact_generation"];
  }
  return [];
}

function explicitFacetPriorityKeys(
  question: string,
  themes: readonly ProjectAnswerEditorialTheme[],
) {
  const availableKeys = new Set(themes.map((theme) => theme.key));
  const selected = new Set<string>();
  for (const facet of explicitPriorityFacets(question)) {
    const key = priorityThemeCandidatesForFacet(facet)
      .find((candidate) => availableKeys.has(candidate) && !selected.has(candidate));
    if (key) selected.add(key);
  }
  return Array.from(selected);
}

const comparisonSubjectStopWords = new Set([
  ...editorialTokenStopWords,
  "approach",
  "current",
  "decision",
  "earlier",
  "former",
  "one",
  "ones",
  "present",
  "previous",
  "prior",
  "system",
]);

function comparisonMemberText(member: RankedEditorialEntry) {
  return [
    member.entry.title,
    member.entry.content,
    member.entry.subsystemKey ?? "",
  ].join(" ");
}

const comparisonSubjectAliasGroups = [
  ["repo", "repository", "github", "codebase"],
  ["research", "exploration", "investigation", "search"],
  ["target", "bound", "focus", "specific"],
  ["refresh", "update", "reconcile", "synchronize", "sync"],
  ["import", "ingestion", "ingest"],
  ["batch", "bulk"],
  ["stream", "continuous", "continuously"],
] as const;

function normalizedComparisonPhrase(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function comparisonSubjectTermSupported(
  term: string,
  evidenceTerms: ReadonlySet<string>,
) {
  if (evidenceTerms.has(term)) return true;
  const aliases = comparisonSubjectAliasGroups.find((group) =>
    group.some((alias) => alias === term)
  );
  return Boolean(aliases?.some((alias) => evidenceTerms.has(stem(alias))));
}

const comparisonAnchorQualifierStopWords = new Set([
  ...comparisonSubjectStopWords,
  "answer",
  "assistant",
  "call",
  "called",
  "context",
  "describe",
  "described",
  "discuss",
  "discussed",
  "known",
  "mention",
  "mentioned",
  "name",
  "named",
  "reference",
  "referenced",
  "referencing",
]);

function demonstrativeAnchorQualifierTerms(
  subject: ProjectAnswerComparisonSubject,
) {
  if (!subject.resolvedAnchor) return [];
  const labelTerms = Array.from(tokens(
    subject.label,
    comparisonSubjectStopWords,
  ));
  if (!labelTerms.length) return [];
  const anchorTerms = subject.resolvedAnchor
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) =>
      term.length > 2 && !comparisonAnchorQualifierStopWords.has(term)
    )
    .map(stem)
    .filter((term) => term.length > 2);
  const firstLabelIndex = anchorTerms.findIndex((term) =>
    comparisonSubjectTermSupported(term, new Set([labelTerms[0]!])) ||
    comparisonSubjectTermSupported(labelTerms[0]!, new Set([term]))
  );
  if (firstLabelIndex < 0) return [];
  const nearbyLabelTerms = new Set(
    anchorTerms.slice(
      firstLabelIndex + 1,
      firstLabelIndex + labelTerms.length + 2,
    ),
  );
  if (
    labelTerms.slice(1).some((term) =>
      !comparisonSubjectTermSupported(term, nearbyLabelTerms)
    )
  ) {
    return [];
  }
  return anchorTerms
    .slice(Math.max(0, firstLabelIndex - 3), firstLabelIndex)
    .filter((term) =>
      !labelTerms.some((labelTerm) =>
        comparisonSubjectTermSupported(term, new Set([labelTerm])) ||
        comparisonSubjectTermSupported(labelTerm, new Set([term]))
      )
    )
    .slice(-2);
}

function explicitComparisonSubjectSupported(
  subject: ProjectAnswerComparisonSubject,
  evidenceText: string,
) {
  const normalizedLabel = normalizedComparisonPhrase(subject.label);
  const normalizedEvidence = normalizedComparisonPhrase(evidenceText);
  if (
    !referentialComparisonSubjectPattern.test(subject.label) &&
    normalizedLabel &&
    ` ${normalizedEvidence} `.includes(` ${normalizedLabel} `)
  ) {
    return true;
  }
  const labelTerms = Array.from(tokens(subject.label, comparisonSubjectStopWords));
  const evidenceTerms = tokens(evidenceText, comparisonSubjectStopWords);
  if (!labelTerms.every((term) =>
    comparisonSubjectTermSupported(term, evidenceTerms)
  )) {
    return false;
  }
  const anchorTerms = Array.from(tokens(
    subject.resolvedAnchor ?? "",
    comparisonSubjectStopWords,
  ));
  const supportedAnchorTerms = anchorTerms.filter((term) =>
    comparisonSubjectTermSupported(term, evidenceTerms)
  ).length;
  const requiredAnchorTerms = demonstrativeComparisonSubjectPattern.test(
    subject.label,
  )
    ? Math.min(5, Math.max(2, Math.ceil(anchorTerms.length * 0.6)))
    : Math.min(3, Math.max(1, Math.ceil(anchorTerms.length * 0.3)));
  const anchorSupported = anchorTerms.length > 0 &&
    supportedAnchorTerms >= requiredAnchorTerms;
  const anchorQualifiersSupported = demonstrativeAnchorQualifierTerms(subject)
    .every((term) => comparisonSubjectTermSupported(term, evidenceTerms));
  const temporalSupported = subject.temporalRole === "earlier"
    ? earlierComparisonEvidencePattern.test(evidenceText)
    : subject.temporalRole === "current"
      ? currentComparisonEvidencePattern.test(evidenceText)
      : false;
  if (
    demonstrativeComparisonSubjectPattern.test(subject.label) &&
    subject.resolvedAnchor &&
    (!anchorSupported || !anchorQualifiersSupported)
  ) {
    return false;
  }
  if (
    demonstrativeComparisonSubjectPattern.test(subject.label) &&
    !labelTerms.length &&
    !anchorSupported &&
    !temporalSupported
  ) {
    return false;
  }
  if (
    subject.temporalRole === "earlier" &&
    !anchorSupported &&
    !temporalSupported
  ) {
    return false;
  }
  return labelTerms.length > 0 || anchorSupported || temporalSupported;
}

function comparisonSubjectMemberScore(
  subject: ProjectAnswerComparisonSubject,
  member: RankedEditorialEntry,
) {
  if (subject.temporalRole === "earlier") {
    const temporalDescription = `${member.entry.title} ${member.entry.content}`;
    if (/\b(?:current|present|latest|newer|now|today)\b/i.test(temporalDescription)) {
      return 0;
    }
  }
  const labelTerms = tokens(subject.label, comparisonSubjectStopWords);
  const anchorTerms = tokens(subject.resolvedAnchor ?? "", comparisonSubjectStopWords);
  const evidenceText = comparisonMemberText(member);
  if (!explicitComparisonSubjectSupported(subject, evidenceText)) return 0;
  const evidenceTerms = tokens(evidenceText, comparisonSubjectStopWords);
  const labelOverlap = Array.from(labelTerms).filter((term) =>
    evidenceTerms.has(term)
  ).length;
  const anchorOverlap = Array.from(anchorTerms).filter((term) =>
    evidenceTerms.has(term)
  ).length;
  const subjectText = [subject.label, subject.resolvedAnchor].filter(Boolean).join(" ");
  const semanticMatches = focusedSemanticConcepts.filter((concept) =>
    concept.query.test(subjectText) && concept.entry.test(evidenceText)
  ).length;
  const normalizedLabel = subject.label.toLowerCase();
  const phraseMatch =
    !referentialComparisonSubjectPattern.test(subject.label) &&
    (
      member.entry.content.toLowerCase().includes(normalizedLabel) ||
      member.entry.title.toLowerCase().includes(normalizedLabel)
    );
  const temporalMatch =
    subject.temporalRole === "current"
      ? Number(
          member.entry.currentRun &&
          /\b(?:current|runtime|execution|now|latest)\b/i.test(evidenceText),
        )
      : subject.temporalRole === "earlier"
        ? Number(
            /\b(?:earlier|prior|previous|decision|admit|reviewed|durable memory|provenance)\b/i.test(
              evidenceText,
            ),
          )
        : 0;
  return labelOverlap * 10 +
    anchorOverlap * 4 +
    semanticMatches * 12 +
    Number(phraseMatch) * 20 +
    temporalMatch * 5;
}

function comparisonDimensionSupported(dimension: string, evidenceText: string) {
  const dimensionTerms = Array.from(tokens(dimension, comparisonDimensionStopWords));
  if (!dimensionTerms.length) return false;
  const evidenceTerms = tokens(evidenceText, comparisonDimensionStopWords);
  const semanticDimensionTerms = [
    {
      term: /^(?:latency|delay|speed|throughput|performance|response|time)$/i,
      evidence: /\b(?:latency|delay|speed|throughput|performance|response time|fast(?:er)?)\b/i,
    },
    {
      term: /^(?:fail|failure|recovery|resilien\w*|retry|fault|tolerance)$/i,
      evidence: /\b(?:failure|recover|resilien|retry|replay|resume|fault toleran)\w*/i,
    },
    {
      term: /^(?:cost|price|spend|expense)\w*/i,
      evidence: /\b(?:cost|price|spend|expense|billing|token usage)\w*/i,
    },
    {
      term: /^(?:complexity|operation\w*|maintenance|operability)$/i,
      evidence: /\b(?:complexity|operations?|maintenance|operability|coordination|overhead)\b/i,
    },
    {
      term: /^(?:security|privacy|authorization|access)$/i,
      evidence: /\b(?:security|privacy|authorization|permission|access|credential|secret)\w*/i,
    },
  ];
  return dimensionTerms.every((term) =>
    evidenceTerms.has(term) ||
    semanticDimensionTerms.some((concept) =>
      concept.term.test(term) && concept.evidence.test(evidenceText)
    )
  );
}

const comparisonNegationPattern =
  /\b(?:cannot|can't|does not|doesn't|do not|don't|is not|isn't|never|no longer|without|disabled|excludes?|prevents?|rejects?|denies?|forbids?|blocks?|disallows?)\b/i;

const comparisonContradictionStopWords = new Set([
  ...comparisonSubjectStopWords,
  "across",
  "after",
  "before",
  "during",
  "each",
  "enforce",
  "enforces",
  "entry",
  "fact",
  "handle",
  "handles",
  "item",
  "module",
  "process",
  "processes",
  "project",
  "source",
  "support",
  "supports",
  "use",
  "uses",
]);

function comparisonSentences(value: string) {
  return value
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function negatedComparisonClauses(value: string) {
  return comparisonSentences(value).flatMap((sentence) => {
    const forward = Array.from(sentence.matchAll(
      /\b(?:cannot|can't|does not|doesn't|do not|don't|is not|isn't|never|no longer|without|disabled|excludes?|prevents?|rejects?|denies?|forbids?|blocks?|disallows?)\b\s+([^,.;:]+?)(?=\b(?:but|while|whereas|although)\b|[,.;:]|$)/gi,
    )).flatMap((match) => {
      const terms = tokens(match[1] ?? "", comparisonContradictionStopWords);
      return terms.size ? [{ terms, sentence }] : [];
    });
    const predicativeDisabled = Array.from(sentence.matchAll(
      /(?:^|[,;:]\s*)([^,.;:]{1,160}?)\s+\b(?:is|are|was|were)\s+disabled\b/gi,
    )).flatMap((match) => {
      const terms = tokens(match[1] ?? "", comparisonContradictionStopWords);
      return terms.size ? [{ terms, sentence }] : [];
    });
    return [...forward, ...predicativeDisabled];
  });
}

function positiveComparisonTerms(value: string) {
  const withoutNegatedClauses = value.replace(
    /\b(?:cannot|can't|does not|doesn't|do not|don't|is not|isn't|never|no longer|without|disabled|excludes?|prevents?|rejects?|denies?|forbids?|blocks?|disallows?)\b\s+([^,.;:]+?)(?=\b(?:but|while|whereas|although)\b|[,.;:]|$)/gi,
    " ",
  );
  return tokens(withoutNegatedClauses, comparisonContradictionStopWords);
}

const comparisonExclusiveScopePairs = [
  [
    new Set(["success", "successful", "succeed"]),
    new Set(["fail", "failure"]),
  ],
  [
    new Set(["batch", "bulk"]),
    new Set(["stream", "continuou", "continuously"]),
  ],
  [
    new Set(["read", "reader"]),
    new Set(["write", "writer"]),
  ],
  [
    new Set(["input", "prompt"]),
    new Set(["output", "completion"]),
  ],
  [
    new Set(["interactive", "foreground", "synchronous", "synchronou"]),
    new Set(["background", "asynchronous", "asynchronou", "offline"]),
  ],
] as const;

function hasComparisonScopeTerm(
  terms: ReadonlySet<string>,
  scope: ReadonlySet<string>,
) {
  return Array.from(scope).some((term) => terms.has(term));
}

function comparisonScopesDisjoint(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) {
  const leftNonIdempotent =
    left.has("nonidempotent") ||
    (left.has("non") && left.has("idempotent"));
  const rightNonIdempotent =
    right.has("nonidempotent") ||
    (right.has("non") && right.has("idempotent"));
  const leftIdempotent = left.has("idempotent") && !leftNonIdempotent;
  const rightIdempotent = right.has("idempotent") && !rightNonIdempotent;
  if (
    (leftIdempotent && rightNonIdempotent) ||
    (leftNonIdempotent && rightIdempotent)
  ) {
    return true;
  }
  return comparisonExclusiveScopePairs.some(([first, second]) => {
    const leftFirst = hasComparisonScopeTerm(left, first);
    const leftSecond = hasComparisonScopeTerm(left, second);
    const rightFirst = hasComparisonScopeTerm(right, first);
    const rightSecond = hasComparisonScopeTerm(right, second);
    return (
      leftFirst &&
      !leftSecond &&
      rightSecond &&
      !rightFirst
    ) || (
      leftSecond &&
      !leftFirst &&
      rightFirst &&
      !rightSecond
    );
  });
}

function negationContradiction(left: string, right: string) {
  const rightPositive = positiveComparisonTerms(right);
  return negatedComparisonClauses(left).some(({ terms }) => {
    if (comparisonScopesDisjoint(terms, rightPositive)) return false;
    const overlap = Array.from(terms).filter((term) =>
      rightPositive.has(term)
    ).length;
    return overlap >= Math.max(1, Math.ceil(terms.size * 0.6));
  });
}

interface ComparisonNumericClaim {
  value: string;
  metricTerms: Set<string>;
  sentenceTerms: Set<string>;
}

function comparisonNumericClaims(value: string): ComparisonNumericClaim[] {
  return comparisonSentences(value).flatMap((sentence) => {
    const words = sentence.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?%?/g) ?? [];
    return words.flatMap((word, index) => {
      if (!/^\d/.test(word)) return [];
      const following = words
        .slice(index + 1, index + 3)
        .filter((candidate) => /^[a-z]/.test(candidate));
      const preceding = words
        .slice(Math.max(0, index - 3), index)
        .filter((candidate) =>
          /^[a-z]/.test(candidate) &&
          !/^(?:a|an|at|by|for|in|is|of|on|the|to)$/.test(candidate)
        );
      const metricSource = following.length ? following : preceding.slice(-2);
      return [{
        value: word,
        metricTerms: tokens(
          metricSource.join(" "),
          comparisonContradictionStopWords,
        ),
        sentenceTerms: tokens(sentence, comparisonContradictionStopWords),
      }];
    });
  });
}

function numericComparisonContradiction(left: string, right: string) {
  return comparisonNumericClaims(left).some((leftClaim) =>
    comparisonNumericClaims(right).some((rightClaim) => {
      if (leftClaim.value === rightClaim.value) return false;
      if (
        comparisonScopesDisjoint(
          leftClaim.sentenceTerms,
          rightClaim.sentenceTerms,
        )
      ) {
        return false;
      }
      const metricOverlap = Array.from(leftClaim.metricTerms).filter((term) =>
        rightClaim.metricTerms.has(term)
      ).length;
      const sentenceOverlap = Array.from(leftClaim.sentenceTerms).filter((term) =>
        rightClaim.sentenceTerms.has(term)
      ).length;
      return metricOverlap > 0 && sentenceOverlap >= 2;
    })
  );
}

/**
 * Detects contradictions without binding the policy to a particular provider
 * or subsystem. Current and stale sources are resolved before this check; two
 * equally current statements with the same subject but opposite polarity or
 * incompatible measurements make the side unsafe to synthesize.
 */
function comparisonEvidenceContradicts(left: string, right: string) {
  const leftTerms = tokens(left, comparisonSubjectStopWords);
  const rightTerms = tokens(right, comparisonSubjectStopWords);
  const shared = Array.from(leftTerms).filter((term) => rightTerms.has(term));
  const sharedEnough =
    shared.length >= 3 &&
    shared.length / Math.max(1, Math.min(leftTerms.size, rightTerms.size)) >= 0.35;
  if (!sharedEnough) return false;
  if (
    comparisonNegationPattern.test(left) !== comparisonNegationPattern.test(right) &&
    (
      negationContradiction(left, right) ||
      negationContradiction(right, left)
    )
  ) {
    return true;
  }
  return numericComparisonContradiction(left, right);
}

function authoritativeLogicalComparisonSubjectEntries(
  subject: ProjectAnswerComparisonSubject,
  themes: readonly ProjectAnswerEditorialTheme[],
) {
  const matches = Array.from(new Map(
    themes
      .flatMap((theme) => theme.members)
      .filter((member) => comparisonSubjectMemberScore(subject, member) > 0)
      .map((member) => [member.entryIndex, member] as const),
  ).values());
  const current = matches.filter((member) => member.entry.currentRun);
  if (subject.temporalRole === "current" && !current.length) return null;
  const authoritative = current.length ? current : matches;
  for (let left = 0; left < authoritative.length; left += 1) {
    for (let right = left + 1; right < authoritative.length; right += 1) {
      if (
        comparisonEvidenceContradicts(
          comparisonMemberText(authoritative[left]!),
          comparisonMemberText(authoritative[right]!),
        )
      ) {
        return null;
      }
    }
  }
  return new Set(authoritative.map((member) => member.entryIndex));
}

function comparisonThemeBindingCandidate(
  subject: ProjectAnswerComparisonSubject,
  subjectIndex: 0 | 1,
  requestedDimensions: readonly string[],
  theme: ProjectAnswerEditorialTheme,
  authoritativeEntryIndexes: ReadonlySet<number>,
) {
  const scored = theme.members
    .map((member) => ({
      member,
      score: comparisonSubjectMemberScore(subject, member),
    }))
    .filter((candidate) =>
      candidate.score > 0 &&
      authoritativeEntryIndexes.has(candidate.member.entryIndex)
    );
  if (!scored.length) return null;
  // A current fact is authoritative over an older memory item. Conversation
  // anchors help resolve "that decision" or "the current runtime", but never
  // override the source chronology or supply factual support themselves.
  const current = scored.filter((candidate) => candidate.member.entry.currentRun);
  if (subject.temporalRole === "current" && !current.length) return null;
  const authoritative = current.length ? current : scored;
  for (let left = 0; left < authoritative.length; left += 1) {
    for (let right = left + 1; right < authoritative.length; right += 1) {
      if (
        comparisonEvidenceContradicts(
          comparisonMemberText(authoritative[left]!.member),
          comparisonMemberText(authoritative[right]!.member),
        )
      ) {
        return null;
      }
    }
  }
  const ordered = authoritative.sort((left, right) =>
    right.score - left.score ||
    right.member.score - left.member.score ||
    left.member.entryIndex - right.member.entryIndex
  );
  const selected = [ordered[0]!];
  for (const dimension of requestedDimensions) {
    if (selected.some((candidate) =>
      comparisonDimensionSupported(dimension, comparisonMemberText(candidate.member))
    )) {
      continue;
    }
    const supporting = ordered.find((candidate) =>
      comparisonDimensionSupported(dimension, comparisonMemberText(candidate.member))
    );
    if (!supporting) return null;
    if (!selected.includes(supporting)) selected.push(supporting);
  }
  const evidenceText = selected.map((candidate) =>
    comparisonMemberText(candidate.member)
  ).join(" ");
  const supportedDimensions = requestedDimensions.filter((dimension) =>
    comparisonDimensionSupported(dimension, evidenceText)
  );
  if (
    supportedDimensions.length !== requestedDimensions.length ||
    selected.length > 3
  ) {
    return null;
  }
  return {
    binding: {
      subjectIndex,
      themeKey: theme.key,
      evidenceEntryIndexes: selected.map((candidate) => candidate.member.entryIndex),
      supportedDimensions,
    } satisfies ProjectAnswerComparisonBinding,
    score: selected.reduce((total, candidate) => total + candidate.score, 0) +
      theme.score * 0.01,
    current: current.length > 0,
    evidenceText,
  };
}

function reconcileLogicalComparisonSubject<T extends {
  current: boolean;
  evidenceText: string;
}>(candidates: T[]) {
  const current = candidates.filter((candidate) => candidate.current);
  const authoritative = current.length ? current : candidates;
  for (let left = 0; left < authoritative.length; left += 1) {
    for (let right = left + 1; right < authoritative.length; right += 1) {
      if (
        comparisonEvidenceContradicts(
          authoritative[left]!.evidenceText,
          authoritative[right]!.evidenceText,
        )
      ) {
        return null;
      }
    }
  }
  return authoritative;
}

function groundedComparisonBindings(
  profile: ProjectAnswerEditorialProfile,
  themes: readonly ProjectAnswerEditorialTheme[],
) {
  const contract = profile.comparisonContract;
  if (!contract) return null;
  const firstAuthoritative = authoritativeLogicalComparisonSubjectEntries(
    contract.subjects[0],
    themes,
  );
  const secondAuthoritative = authoritativeLogicalComparisonSubjectEntries(
    contract.subjects[1],
    themes,
  );
  if (!firstAuthoritative?.size || !secondAuthoritative?.size) return null;
  const firstCandidates = themes.flatMap((theme) => {
    const candidate = comparisonThemeBindingCandidate(
      contract.subjects[0],
      0,
      contract.requestedDimensions,
      theme,
      firstAuthoritative,
    );
    return candidate ? [{ ...candidate, theme }] : [];
  });
  const secondCandidates = themes.flatMap((theme) => {
    const candidate = comparisonThemeBindingCandidate(
      contract.subjects[1],
      1,
      contract.requestedDimensions,
      theme,
      secondAuthoritative,
    );
    return candidate ? [{ ...candidate, theme }] : [];
  });
  const first = reconcileLogicalComparisonSubject(firstCandidates);
  const second = reconcileLogicalComparisonSubject(secondCandidates);
  if (!first || !second) return null;
  const pairs = first.flatMap((left) =>
    second
      .filter((right) =>
        right.theme.key !== left.theme.key ||
        !right.binding.evidenceEntryIndexes.some((entryIndex) =>
          left.binding.evidenceEntryIndexes.includes(entryIndex)
        )
      )
      .map((right) => ({
        left,
        right,
        score: left.score + right.score,
      }))
  ).sort((left, right) =>
    right.score - left.score ||
    left.left.theme.label.localeCompare(right.left.theme.label) ||
    left.right.theme.label.localeCompare(right.right.theme.label)
  );
  const best = pairs[0];
  if (!best) return null;
  return [
    best.left.binding,
    best.right.binding,
  ] satisfies [
    ProjectAnswerComparisonBinding,
    ProjectAnswerComparisonBinding,
  ];
}

function comparisonPriorityThemeKeys(
  bindings: ProjectAnswerEditorialSelection["comparisonBindings"],
) {
  if (!bindings) return [];
  return bindings.map((binding) => binding.themeKey);
}

export function hasGroundedProjectAnswerComparison(
  selection: Pick<
    ProjectAnswerEditorialSelection,
    "profile" | "selectedThemes" | "comparisonBindings"
  >,
) {
  if (selection.profile.kind !== "comparison") return true;
  if (!selection.profile.comparisonContract || !selection.comparisonBindings) {
    return false;
  }
  return selection.selectedThemes.length === 2 &&
    selection.comparisonBindings.every((binding, index) =>
      binding.subjectIndex === index &&
      selection.selectedThemes[index]?.key === binding.themeKey &&
      binding.supportedDimensions.length ===
        selection.profile.comparisonContract!.requestedDimensions.length &&
      binding.evidenceEntryIndexes.length > 0
    );
}

export function selectProjectAnswerEditorialThemes(input: {
  question: string;
  entries: ProjectAnswerGroundingEntry[];
  profile?: ProjectAnswerEditorialProfile;
}): ProjectAnswerEditorialSelection {
  const profile = input.profile ?? classifyProjectAnswerEditorialProfile(input.question);
  const rankedEntries = rankProjectAnswerEditorialEntries({
    question: input.question,
    entries: input.entries,
    profile,
  });
  const exclusionClause = input.question.match(
    /\b(?:omit|exclude|avoid|without|do not include|don't include)\b([^.;\n]+)/i,
  )?.[1] ?? "";
  const excludedPatterns = [
    /\b(?:ui|user interface)\b/i.test(exclusionClause)
      ? /\b(?:ui|user interface)\b/i
      : null,
    /\bonboarding\b/i.test(exclusionClause)
      ? /\bonboarding\b/i
      : null,
    /\b(?:local setup|setup)\b/i.test(exclusionClause)
      ? /\b(?:local setup|npm (?:install|run)|development setup)\b/i
      : null,
    /\b(?:framework|routine framework|framework choices?)\b/i.test(exclusionClause)
      ? /\b(?:next\.?js|tailwind|framework choices?)\b/i
      : null,
  ].filter((pattern): pattern is RegExp => pattern !== null);
  const contentEntries = rankedEntries.filter((entry) =>
    (
      (
        entry.entry.kind === "highlight" &&
        entry.entry.authority === "verified_highlight"
      ) ||
      (
        entry.entry.kind === "project_fact" &&
        entry.entry.authority === "verified_project_fact"
      ) ||
      (
        profile.kind === "focused" &&
        entry.entry.kind === "evidence" &&
        entry.entry.authority === "included_evidence"
      )
    ) &&
    !excludedPatterns.some((pattern) =>
      pattern.test(`${entry.entry.title} ${entry.entry.content}`)
    )
  );
  const priorityFacets = explicitPriorityFacets(input.question);
  const preserveExplicitTechnicalFacets =
    profile.requestedItemCount !== null &&
    priorityFacets.length >= 2 &&
    (
      profile.audience === "technical" ||
      /\b(?:backend|architecture|system design|runtime|reliability|data integrity)\b/i.test(
        priorityFacets.join(" "),
      )
    );
  const definitions =
    profile.comprehensive ||
      profile.kind === "focused" ||
      preserveExplicitTechnicalFacets
    ? inventoryThemeDefinitions
    : readerThemeDefinitions;
  const knownSubsystems = new Set(definitions.flatMap((definition) => [...definition.subsystemKeys]));
  const themes = [
    ...definitions.flatMap((definition) => {
      const theme = themeFromDefinition(definition, contentEntries);
      return theme ? [theme] : [];
    }),
    ...unknownThemes(contentEntries, knownSubsystems),
  ].sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
  const strongConceptThemes = themes.filter((theme) =>
    theme.representativeMembers.some((member) =>
      member.components.semanticConceptMatch >= 12
    )
  );
  const weakConceptThemes = themes.filter((theme) =>
    theme.representativeMembers.some((member) =>
      member.components.semanticConceptMatch > 0
    )
  );
  const requiresDirectConceptMatch =
    /\b(?:cdn|deployment topology|hosting topology|production deployment|edge network|load balancer|authentication|authorization|permissions?|access control|oauth)\b/i.test(
      input.question,
    );
  const securityOrAuthorizationFocus =
    profile.focusTerms.some((term) =>
      /^(?:security|secure|posture|secret|credential|authentication|authorization|permission|oauth)$/i.test(term)
    );
  const focusedThemePool = strongConceptThemes.length
    ? themes.filter((theme) =>
        strongConceptThemes.includes(theme) ||
        (
          securityOrAuthorizationFocus &&
          weakConceptThemes.includes(theme)
        ) ||
        theme.representativeMembers.some((member) =>
          member.entry.kind !== "evidence" &&
          (
            member.components.queryRelevance >= 12 ||
            member.components.lexicalQueryRelevance >= 8
          )
        )
      )
    : weakConceptThemes.length
      ? weakConceptThemes
      : requiresDirectConceptMatch
        ? []
        : themes;
  const bestFocusedRelevance = Math.max(
    0,
    ...focusedThemePool.flatMap((theme) =>
      theme.representativeMembers.map((member) => member.components.queryRelevance)
    ),
  );
  const eligibleThemes = profile.kind === "focused" && !profile.comprehensive
    ? focusedThemePool.filter((theme) =>
        theme.representativeMembers.some((member) =>
          member.components.queryRelevance >= Math.max(4, bestFocusedRelevance * 0.65) ||
          (
            strongConceptThemes.length > 0 &&
            member.entry.kind !== "evidence" &&
            member.components.semanticConceptMatch >= 12
          )
        )
      )
    : themes;
  const comparisonBindings = profile.kind === "comparison"
    ? groundedComparisonBindings(profile, themes)
    : null;
  const comparisonPriorityKeys = comparisonPriorityThemeKeys(comparisonBindings);
  const focusedPriorityKeys = profile.kind === "focused"
    ? (
        /\b(?:(?:artifact|highlight).{0,80}(?:fallback|insufficient|evidence gap)|approved highlights?.{0,60}insufficient)\b/i.test(
          input.question,
        )
          ? ["product_and_artifact_generation", "workflow_orchestration"]
          : /\b(?:(?:openrouter|bedrock|model (?:runtime|tool loop)|tool loop|ai runtime).{0,100}durable workflow|durable workflow.{0,100}(?:openrouter|bedrock|model (?:runtime|tool loop)|tool loop|ai runtime))\b/i.test(
              input.question,
            )
            ? ["ai_runtime", "workflow_orchestration"]
            : /\b(?:(?:repo(?:sitory)?|repository).{0,50}(?:know\w*\s+)?refresh|refresh\w*.{0,70}stale|stale.{0,70}refresh\w*)\b/i.test(
                input.question,
              )
              ? ["repository_knowledge_lifecycle", "knowledge_review_experience", "domain_data"]
              : /\b(?:(?:explor\w*|inspect\w*).{0,80}(?:unused|unreferenced|source|citation)|(?:unused|unreferenced).{0,80}(?:files?|source|citation)|citation pruning|citation selection|provenance)\b/i.test(
                  input.question,
                )
                ? ["retrieval_provenance", "project_chat_grounding"]
                : /\b(?:data model|stor\w*|persist\w*|version\w*|correct\w*|retir\w*|supersed\w*|stale facts?|knowledge lifecycle)\b/i.test(
                    input.question,
                  )
                  ? ["domain_data", "knowledge_review_experience", "repository_knowledge_lifecycle"]
                  : /\b(?:test(?:ing)? strategy|automated tests?|test coverage|regression|evaluation suite)\b/i.test(input.question)
                    ? ["tests_operations"]
                    : /\b(?:github|oauth|repository ingestion|repo ingestion|code exploration)\b/i.test(input.question)
                      ? ["ingestion_integrations", "repository_knowledge_lifecycle"]
                      : /\b(?:workspace|review experience|review ui|user-facing|frontend)\b/i.test(input.question)
                        ? ["knowledge_review_experience", "retrieval_provenance", "product_and_artifact_generation"]
                        : /\b(?:security|secure|secrets?|credentials?|threat|trust boundary|posture)\b/i.test(input.question)
                          ? ["ai_runtime", "ingestion_integrations"]
                          : /\b(?:authentication|authorization|permissions?|access control|oauth)\b/i.test(input.question)
                            ? ["ingestion_integrations", "ai_runtime"]
                            : /\b(?:chat layer|supporting evidence|evidence is missing|missing evidence|insufficient evidence|cannot answer|can't answer)\b/i.test(
                                input.question,
                              )
                              ? ["project_chat_grounding", "retrieval_provenance"]
                              : []
      )
    : [];
  const projectWideOverviewPriorityKeys =
    profile.kind === "overview" &&
    /\b(?:workbase|this project|the project|whole project|project-wide)\b/i.test(
      input.question,
    )
      ? [
          "product_outcomes",
          "repository_intelligence",
          "grounded_project_agent",
          "durable_ai_platform",
          "trusted_knowledge_lifecycle",
          "engineering_foundation",
        ]
      : [];
  const facetPriorityKeys = preserveExplicitTechnicalFacets
    ? explicitFacetPriorityKeys(input.question, eligibleThemes)
    : [];
  const assessmentPriorityKeys =
    profile.kind === "assessment" &&
    /\bdesign trade[- ]?offs?\b/i.test(input.question)
      ? [
          "product_outcomes",
          "repository_intelligence",
          "durable_ai_platform",
        ]
      : profile.kind === "assessment" &&
          /\b(?:limitations?.{0,30}risks?|risks?.{0,30}limitations?)\b/i.test(
            input.question,
          )
        ? [
            "repository_intelligence",
            "durable_ai_platform",
            "grounded_project_agent",
          ]
        : [];
  const productValueDifficultyPriorityKeys =
    profile.kind === "accomplishment" &&
    /\b(?:hardest|most difficult|most valuable)\b.{0,220}\b(?:end-to-end|user|product)\s+value\b/i.test(
      input.question,
    )
      ? [
          "product_outcomes",
          "repository_intelligence",
          "grounded_project_agent",
          "durable_ai_platform",
          "trusted_knowledge_lifecycle",
        ]
      : [];
  // "Strongest accomplishments" is a reader-value question even when the
  // user does not spell out an audience. Raw retrieval scores can otherwise
  // let a richly documented internal subsystem (for example chat grounding)
  // outrank the product outcome it exists to support. Keep evidence ranking
  // inside each theme, but give the final synthesis a stable product-first
  // narrative: outcome, repository intelligence, grounded agent, execution,
  // then review lifecycle. Explicit facet requests above still win.
  const defaultAccomplishmentPriorityKeys =
    profile.kind === "accomplishment"
      ? [
          "product_outcomes",
          "repository_intelligence",
          "grounded_project_agent",
          "durable_ai_platform",
          "trusted_knowledge_lifecycle",
          "engineering_foundation",
        ]
      : [];
  const priorityKeys = comparisonPriorityKeys.length
    ? comparisonPriorityKeys
    : focusedPriorityKeys.length
      ? focusedPriorityKeys
      : facetPriorityKeys.length
        ? facetPriorityKeys
        : assessmentPriorityKeys.length
          ? assessmentPriorityKeys
          : productValueDifficultyPriorityKeys.length
            ? productValueDifficultyPriorityKeys
            : defaultAccomplishmentPriorityKeys.length
              ? defaultAccomplishmentPriorityKeys
            : projectWideOverviewPriorityKeys;
  const orderedEligibleThemes = priorityKeys.length
    ? [
        ...priorityKeys.flatMap((key) => {
          const theme = eligibleThemes.find((candidate) => candidate.key === key);
          return theme ? [theme] : [];
        }),
        ...eligibleThemes.filter((theme) => !priorityKeys.includes(theme.key)),
      ]
    : eligibleThemes;
  const selectableThemes = profile.kind === "comparison"
    ? comparisonPriorityKeys.flatMap((key) => {
        const theme = themes.find((candidate) => candidate.key === key);
        return theme ? [theme] : [];
      })
    : orderedEligibleThemes.length
      ? orderedEligibleThemes
      : profile.kind === "focused" && !profile.comprehensive
        ? []
        : themes.slice(0, 1);
  const availableCount = Math.min(profile.targetItemCount.maximum, selectableThemes.length);
  const requestedCount = Math.min(
    availableCount,
    Math.max(
      Math.min(profile.targetItemCount.minimum, availableCount),
      Math.min(profile.targetItemCount.preferred, availableCount),
    ),
  );
  const selectedThemes = selectableThemes.slice(0, requestedCount);
  const highPriorityMembers = themes.flatMap((theme) => theme.highPriorityMembers);
  const ownershipCitationIndexes = Array.from(new Set(
    rankedEntries
      .filter((entry) =>
        entry.entry.authority === "included_evidence" &&
        (entry.entry.ownershipAuthority ?? 0) >= 3
      )
      .flatMap((entry) => entry.entry.citationIndexes),
  ));
  return {
    profile,
    rankedEntries,
    themes,
    selectedThemes,
    omittedThemes: themes.filter((theme) => !selectedThemes.includes(theme)),
    highPriorityMembers,
    ownershipCitationIndexes,
    comparisonBindings,
  };
}

function exactSourceText(value: string) {
  return value
    .replace(/\[citation:\d+\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function uniqueValidCitationIndexes(indexes: number[]) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index) && index > 0)));
}

export function buildExactSourceEditorialFallbackBlocks(
  selection: ProjectAnswerEditorialSelection,
  options: { maxMembersPerTheme?: number; maxCitationsPerBlock?: number } = {},
): GroundedAnswerBlock[] {
  const defaultMemberLimit =
    selection.profile.kind === "comparison"
      ? 3
      : selection.profile.kind === "focused" && selection.selectedThemes.length > 1
      ? 1
      : 2;
  const maxMembers = Math.max(
    1,
    Math.min(3, options.maxMembersPerTheme ?? defaultMemberLimit),
  );
  const maxCitations = Math.max(
    1,
    Math.min(
      6,
      options.maxCitationsPerBlock ??
        (selection.profile.kind === "comparison" ? 6 : 4),
    ),
  );
  return selection.selectedThemes.flatMap((theme, themeIndex) => {
    const themeMemberLimit =
      theme.key === "product_and_artifact_generation" &&
      /\b(?:(?:artifact|highlight).{0,80}(?:fallback|insufficient|evidence gap)|approved highlights?.{0,60}insufficient)\b/i.test(
        selection.profile.focusTerms.join(" "),
      )
        ? Math.max(2, maxMembers)
        : maxMembers;
    const members: RankedEditorialEntry[] = [];
    const usedCitations = new Set<number>();
    const comparisonBinding = selection.comparisonBindings?.[themeIndex];
    const boundEntryIndexes = new Set(
      comparisonBinding?.themeKey === theme.key
        ? comparisonBinding.evidenceEntryIndexes
        : [],
    );
    const exactCandidates = boundEntryIndexes.size
      ? theme.members.filter((member) =>
          boundEntryIndexes.has(member.entryIndex)
        )
      : theme.representativeMembers;
    for (const candidate of exactCandidates) {
      if (members.length >= themeMemberLimit) break;
      const citationIndexes = uniqueValidCitationIndexes(candidate.entry.citationIndexes);
      if (!citationIndexes.length) continue;
      const combined = new Set([...usedCitations, ...citationIndexes]);
      if (combined.size > maxCitations) continue;
      members.push(candidate);
      for (const citationIndex of citationIndexes) usedCitations.add(citationIndex);
    }
    if (!members.length) return [];
    const bodyMarkdown = members.length === 1
      ? exactSourceText(members[0]!.entry.content)
      : members.map((member) => `- ${exactSourceText(member.entry.content)}`).join("\n");
    if (!bodyMarkdown) return [];
    return [{
      heading: theme.label,
      bodyMarkdown,
      citationIndexes: Array.from(usedCitations),
    }];
  });
}

const assessmentByTheme: Record<string, string> = {
  product_outcomes:
    "Through review, quarantine, and approval boundaries, this design enables a trustworthy route from durable knowledge to career output. Its limitation is that quality and coverage remain bounded by what the project has captured and approved; the same boundaries make that constraint visible instead of silently widening the evidence.",
  repository_intelligence:
    "By dividing semantic analysis into bounded work packages and auditing coverage, the design enables fresher reusable memory without unbounded analysis. Those packages can still leave a representative rather than exhaustive view; the audit mitigates that risk by surfacing the gap explicitly.",
  grounded_project_agent:
    "Using citation-aware retrieval and admitting reviewed memory rather than raw exploration enables traceable answers with fewer unsupported claims. The corresponding risk is dependence on relevant, current durable memory; fail-closed responses make missing support visible instead of filling it with a guess.",
  trusted_knowledge_lifecycle:
    "Through immutable successors and explicit lifecycle state, the design enables stale knowledge to be corrected without erasing its audit trail. The cost is more lifecycle and review complexity than mutable notes, partly offset by visible provenance and state in the workspace.",
  durable_ai_platform:
    "By persisting run state and enforcing resource limits, the platform enables observable long-running model work to cross review boundaries safely. Its operational trade-off is a larger orchestration surface and the possibility of returning a safe partial result when a hard limit is reached.",
  engineering_foundation:
    "By combining durable persistence with scenario-level tests, this foundation enables auditability and regression resistance. The trade-off is a broader schema and test surface that must evolve with the product.",
  product_and_artifact_generation:
    "By drafting from reviewed, non-sensitive Highlights and failing closed on evidence gaps, this pipeline enables trustworthy career output without letting unsupported source material leak into an artifact. Its usefulness remains bounded by what the evidence can safely establish.",
  repository_knowledge_lifecycle:
    "Through bounded analysis, synthesis, and reconciliation, this lifecycle enables fresher reusable memory without treating every file as equally valuable. The limitation is incomplete semantic coverage, which it preserves as an explicit gap instead of presenting the pass as exhaustive.",
  project_chat_grounding:
    "Using citation-aware retrieval and controlled research enables a traceable answer path from conversation to durable memory. Relevance and depth remain bounded by current memory and authorized research, so unsupported detail must end as a visible evidence gap.",
  knowledge_review_experience:
    "By recording edits as lifecycle transitions with provenance, the workspace enables reviewable correction without erasing history. The trade-off is additional state complexity, made more manageable by exposing that state directly to reviewers.",
  workflow_orchestration:
    "By persisting progress and approval state, this orchestration enables long-running work to pause at a human-review boundary and resume. The operational trade-off is a larger durable state-transition surface.",
  ai_runtime:
    "By enforcing tool, iteration, token, and abort controls, this runtime enables observable, resource-bounded model execution. The limitation is that reaching a hard budget may require a safe partial result.",
  retrieval_provenance:
    "By merging retrieval signals and re-grounding derivative claims, this layer enables traceable answers while containing raw exploration beneath reviewed memory. The trade-off is stricter evidence admission and ranking logic.",
  ingestion_integrations:
    "Through bounded import and code exploration, this integration enables current repository evidence without unbounded access. The limitation is that read, byte, and time budgets can leave a targeted gap.",
  domain_data:
    "By persisting knowledge, provenance, conversations, and runs as related records, this model enables a durable audit trail. The trade-off is a broader schema and migration surface that must evolve consistently.",
  tests_operations:
    "By testing user-visible scenarios alongside service contracts, this suite enables regression resistance across the agent lifecycle. The limitation is that scenario coverage still requires ongoing maintenance as behavior changes.",
};
const valueByTheme: Record<string, string> = {
  product_outcomes:
    "This keeps career output tied to reviewed, non-sensitive project knowledge instead of letting raw inputs flow directly into a public artifact.",
  repository_intelligence:
    "This keeps reusable memory current while preserving commit-pinned provenance and making incomplete coverage explicit.",
  grounded_project_agent:
    "This keeps answers traceable to durable memory and prevents explored-but-unused repository files from becoming peer sources.",
  trusted_knowledge_lifecycle:
    "This lets users correct stale knowledge without erasing its review history or silently leaving downstream content current.",
  durable_ai_platform:
    "This keeps long-running model work bounded, observable, and recoverable across workflow boundaries.",
  engineering_foundation:
    "This gives project knowledge, conversations, review state, and generated output a durable audit trail with regression coverage.",
  product_and_artifact_generation:
    "This keeps career output tied to reviewed, non-sensitive project knowledge rather than raw repository inputs.",
  repository_knowledge_lifecycle:
    "This keeps reusable memory current while preserving commit-pinned provenance and explicit coverage gaps.",
  project_chat_grounding:
    "This keeps multi-turn answers traceable and prevents explored-but-unused files from becoming peer sources.",
  knowledge_review_experience:
    "This lets users correct or retire stale knowledge without erasing review history.",
  workflow_orchestration:
    "This separates single-turn model limits from the durable human-review boundary, which can pause and resume the larger run.",
  ai_runtime:
    "This bounds each provider-neutral model tool loop with observable stop, usage, cost, abort, iteration, tool-call, and token controls.",
  retrieval_provenance:
    "This selects relevant reviewed memory while keeping its immutable provenance available for inspection.",
  ingestion_integrations:
    "This recovers decisive current code context without granting the chat agent unbounded repository access.",
  domain_data:
    "This gives project knowledge, conversations, review state, and generated output a durable audit trail.",
  tests_operations:
    "This checks user-visible chat, research, review, artifact, security, and recovery behavior across regressions.",
};

/**
 * Keeps the recovery path useful for analytical prompts without presenting
 * model-free conclusions as observed facts. The evidence text remains
 * verbatim; the additional sentence is explicitly labeled as an inference
 * from the cited design.
 */
export function addSourceBoundedEditorialAnalysis(
  blocks: GroundedAnswerBlock[],
  selection: ProjectAnswerEditorialSelection,
) {
  if (selection.profile.kind !== "assessment") return blocks;
  return blocks.map((block, index) => {
    const theme = selection.selectedThemes[index];
    const analysis = theme ? assessmentByTheme[theme.key] : null;
    if (!analysis) return block;
    return {
      ...block,
      heading: block.heading ? `${block.heading}: strength and trade-off` : "Supported strength and trade-off",
      bodyMarkdown: `${block.bodyMarkdown}\n\n**Assessment (inference from the cited design):** ${analysis}`,
    };
  });
}

export function addSourceBoundedEditorialContext(
  blocks: GroundedAnswerBlock[],
  selection: ProjectAnswerEditorialSelection,
) {
  if (selection.profile.kind === "assessment") {
    return addSourceBoundedEditorialAnalysis(blocks, selection);
  }
  if (selection.profile.kind === "comparison") {
    if (!hasGroundedProjectAnswerComparison(selection)) return [];
    const contract = selection.profile.comparisonContract;
    // Exact recovery may reorder and relabel cited source material, but it
    // must not append canned comparison claims after semantic verification.
    return blocks.map((block, index) => ({
      ...block,
      heading: contract?.subjects[index]?.heading ?? block.heading,
    }));
  }
  const contextualized = blocks.map((block, index) => {
    const theme = selection.selectedThemes[index];
    const value = theme ? valueByTheme[theme.key] : null;
    if (!value) return block;
    return {
      ...block,
      bodyMarkdown: `${block.bodyMarkdown}\n\n**Why it matters:** ${value}`,
    };
  });
  if (selection.profile.kind !== "focused" || !contextualized.length) {
    return contextualized;
  }
  const requested = selection.profile.focusTerms.join(" ");
  const sourceText = selection.selectedThemes
    .flatMap((theme) => theme.representativeMembers)
    .map((member) => `${member.entry.title} ${member.entry.content}`)
    .join(" ");
  const boundaries: string[] = [];
  if (/\b(?:retry|retrie|backoff)\b/i.test(requested) && !/\b(?:retry|retries|backoff)\b/i.test(sourceText)) {
    boundaries.push(
      "The cited memory establishes the bounded tool loop and pause/resume review boundary, but it does not establish an automatic retry or backoff policy.",
    );
  }
  if (/\bidempoten/i.test(requested) && !/\bidempoten/i.test(sourceText)) {
    boundaries.push("The cited memory does not establish the run's idempotency mechanism.");
  }
  const asksAboutRepositoryAuthorization =
    /\b(?:authentication|authorization|permission|oauth|access control)\b/i.test(requested);
  const establishesRepositoryAuthorizationPolicy =
    /\b(?:permission checks?|authorization policy|oauth scopes?|attached repositor(?:y|ies).{0,80}(?:authori[sz]|permit|limit|only)|user.{0,40}work item.{0,40}source)\b/i
      .test(sourceText);
  if (asksAboutRepositoryAuthorization && !establishesRepositoryAuthorizationPolicy) {
    boundaries.push(/\boauth\b/i.test(sourceText)
      ? "The cited memory confirms GitHub OAuth integration, but it does not establish the exact OAuth scopes or attached-repository permission checks."
      : "The cited memory establishes bounded GitHub ingestion and exploration, but it does not establish the OAuth mechanism, exact scopes, or attached-repository permission checks.");
  }
  const asksForProductionPerformance =
    /\b(?:p(?:50|90|95|99)|percentile|production (?:latency|throughput|traffic|request volume)|requests? per (?:second|minute)|rps|rpm)\b/i
      .test(requested);
  const sourceEstablishesProductionPerformance =
    /\b(?:p(?:50|90|95|99)|percentile|production (?:latency|throughput|traffic|request volume)|requests? per (?:second|minute)|rps|rpm)\b/i
      .test(sourceText) &&
    /\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?|requests?|rps|rpm|%|x)\b/i.test(sourceText);
  if (asksForProductionPerformance && !sourceEstablishesProductionPerformance) {
    boundaries.push(
      "The cited memory does not establish a measured production latency percentile, throughput, or request-volume metric.",
    );
  }
  if (!boundaries.length) return contextualized;
  const lastIndex = contextualized.length - 1;
  return contextualized.map((block, index) => index === lastIndex
    ? {
        ...block,
        bodyMarkdown: `${block.bodyMarkdown}\n\n> **Evidence boundary:** ${boundaries.join(" ")}`,
      }
    : block);
}

function audienceGuidance(audience: ProjectAnswerAudience) {
  switch (audience) {
    case "recruiter":
      return "Use plain career language, lead with user value, and keep implementation jargon subordinate.";
    case "hiring_manager":
      return "Emphasize ownership only when supported, engineering scope, difficult decisions, and delivered value.";
    case "executive":
      return "Lead with product outcomes, trust, and operational implications; minimize implementation vocabulary.";
    case "technical":
      return "Include decisive mechanisms, boundaries, and trade-offs without turning the answer into a file inventory.";
    default:
      return "Use clear project-level language appropriate for a technically curious reader.";
  }
}

export function buildProjectAnswerEditorialModelGuidance(
  profile: ProjectAnswerEditorialProfile,
) {
  const itemContract = profile.requestedItemCount
    ? `Return exactly ${profile.requestedItemCount} top-level item${profile.requestedItemCount === 1 ? "" : "s"}.`
    : `Return ${profile.targetItemCount.minimum}–${profile.targetItemCount.maximum} top-level items, normally ${profile.targetItemCount.preferred}.`;
  const selectionContract = profile.comprehensive
    ? "The user explicitly requested comprehensive coverage: organize every selected inventory theme, while still ordering by importance."
    : "The complete candidate catalog is an internal coverage map, not an output checklist. Select and consolidate only the strongest reader-relevant themes; omission of lower-priority detail is editorial judgment, not a coverage gap.";
  const analyticalContract = profile.kind === "assessment" || profile.kind === "comparison"
    ? "Separate observed implementation facts from analysis. A risk, limitation, comparison, or trade-off may be stated only when it follows directly from cited premises; frame it explicitly as an assessment (for example, “this creates a trade-off” or “this may limit”) rather than as an observed fact."
    : "";
  const comparisonContract = profile.kind === "comparison"
    ? "The serialized untrusted editorial plan contains the comparison contract. Preserve its two user-named sides, order, requested dimensions, and temporal roles exactly, but treat conversation anchors only as referent hints. Use current cited sources over older sources, and fail closed when either side or dimension lacks positive cited support."
    : "";
  return [
    "Act as Workbase's final editorial synthesizer after repository coverage and source validation are complete.",
    itemContract,
    selectionContract,
    `Answer mode: ${profile.kind}. Depth: ${profile.depth}. Format: ${profile.format}.`,
    audienceGuidance(profile.audience),
    "For each selected theme, state what was accomplished, the decisive mechanism or difficulty, and why it matters when the sources support those elements.",
    "Order themes by user relevance and significance, not schema order or subsystem name.",
    "Combine related capabilities into one coherent reader-oriented theme and avoid repeated claims.",
    "Do not surface filenames, schema fields, dimensions, error codes, or routine utilities unless the request explicitly focuses on that detail.",
    "Use only supplied source content and citation indexes. Do not invent ownership, impact, scale, reliability, production readiness, or completeness.",
    analyticalContract,
    comparisonContract,
    "Write one independently supported Markdown item per selected theme. Put [citation:N] markers in the item body using only the supplied citation indexes; never put citations in headings.",
  ].filter(Boolean).join(" ");
}

function blockText(block: GroundedAnswerBlock) {
  return `${block.heading ?? ""} ${block.bodyMarkdown}`.replace(/\s+/g, " ").trim();
}

function displayItemCount(
  profile: ProjectAnswerEditorialProfile,
  blocks: GroundedAnswerBlock[],
  rawAnswer: string,
) {
  if (profile.format === "table") {
    const tableLines = rawAnswer.split("\n").filter((line) => /^\s*\|.+\|\s*$/.test(line));
    const dataLines = tableLines.filter((line) => !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
    return Math.max(0, dataLines.length - 1);
  }
  if (profile.format === "bullets") {
    const bulletCount = rawAnswer.split("\n").filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length;
    return bulletCount || blocks.length;
  }
  return blocks.length;
}

function formatPass(
  profile: ProjectAnswerEditorialProfile,
  blocks: GroundedAnswerBlock[],
  rawAnswer: string,
) {
  if (profile.format === "table") {
    return /^\s*\|.+\|\s*$/m.test(rawAnswer) &&
      /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m.test(rawAnswer);
  }
  if (profile.format === "bullets") {
    return blocks.every((block) =>
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)/m.test(block.bodyMarkdown)
    ) || rawAnswer.split("\n").filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length >= blocks.length;
  }
  if (profile.format === "paragraphs") {
    return !/^\s*(?:[-*+]\s+|\d+[.)]\s+|\|.+\|)\s*$/m.test(rawAnswer);
  }
  return blocks.every((block) => Boolean(block.heading?.trim()));
}

function representedThemeKeys(
  blocks: GroundedAnswerBlock[],
  themes: ProjectAnswerEditorialTheme[],
) {
  return blocks.flatMap((block) => {
    const indexes = new Set(block.citationIndexes);
    return themes
      .filter((theme) => theme.members.some((member) =>
        member.entry.citationIndexes.some((index) => indexes.has(index))
      ))
      .map((theme) => theme.key);
  }).filter((key, index, values) => values.indexOf(key) === index);
}

function outOfOrderKeys(actual: string[], expected: string[]) {
  const expectedIndex = new Map(expected.map((key, index) => [key, index]));
  return actual.filter((key, index) => {
    const previous = actual[index - 1];
    return Boolean(
      previous &&
      (expectedIndex.get(key) ?? Number.MAX_SAFE_INTEGER) <
        (expectedIndex.get(previous) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function requiredDepthRatios(kind: ProjectAnswerEditorialKind) {
  switch (kind) {
    case "accomplishment":
      return { mechanism: 0.75, value: 0.75 };
    case "architecture":
      return { mechanism: 0.8, value: 0.4 };
    case "overview":
      return { mechanism: 0.5, value: 0.6 };
    case "assessment":
      return { mechanism: 0.35, value: 0.7 };
    case "comparison":
      return { mechanism: 0.4, value: 0.4 };
    case "focused":
      return { mechanism: 0.5, value: 0.25 };
  }
}

const comparisonDimensionStopWords = new Set([
  ...comparisonSubjectStopWords,
  "address",
  "become",
  "cover",
  "each",
  "explain",
  "how",
  "include",
  "output",
  "outputs",
  "should",
  "their",
  "when",
]);

function normalizedComparisonLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function comparisonContractPass(
  profile: ProjectAnswerEditorialProfile,
  selection: ProjectAnswerEditorialSelection,
  blocks: readonly GroundedAnswerBlock[],
) {
  const contract = profile.comparisonContract;
  if (profile.kind !== "comparison") return true;
  if (!contract || !hasGroundedProjectAnswerComparison(selection)) return false;
  if (blocks.length < contract.subjects.length) return false;
  const subjectChecks = contract.subjects.map((subject, index) => {
    const block = blocks[index];
    const binding = selection.comparisonBindings?.[index];
    const theme = selection.selectedThemes[index];
    if (!block) return false;
    if (!binding || !theme || binding.themeKey !== theme.key) return false;
    const heading = normalizedComparisonLabel(block.heading ?? "");
    const expectedHeading = normalizedComparisonLabel(subject.heading);
    const expectedLabel = normalizedComparisonLabel(subject.label);
    const preservesName = Boolean(heading) && (
      heading === expectedHeading ||
      heading === expectedLabel ||
      heading.includes(expectedHeading) ||
      expectedHeading.includes(heading)
    );
    if (!preservesName) return false;
    const blockText = `${block.heading ?? ""} ${block.bodyMarkdown}`;
    if (
      subject.temporalRole &&
      !new RegExp(`\\b${subject.temporalRole}\\b`, "i").test(blockText)
    ) {
      return false;
    }
    const boundMembers = theme.members.filter((member) =>
      binding.evidenceEntryIndexes.includes(member.entryIndex)
    );
    if (
      !boundMembers.length ||
      !binding.evidenceEntryIndexes.every((entryIndex) => {
        const member = boundMembers.find((candidate) =>
          candidate.entryIndex === entryIndex
        );
        return Boolean(
          member &&
          member.entry.citationIndexes.some((citationIndex) =>
            block.citationIndexes.includes(citationIndex)
          ),
        );
      })
    ) {
      return false;
    }
    const citedEvidence = boundMembers
      .filter((member) => member.entry.citationIndexes.some((citationIndex) =>
        block.citationIndexes.includes(citationIndex)
      ))
      .map(comparisonMemberText)
      .join(" ");
    if (!citedEvidence) return false;
    if (
      boundMembers.every((member) =>
        comparisonSubjectMemberScore(subject, member) <= 0
      )
    ) {
      return false;
    }
    return contract.requestedDimensions.every((dimension) =>
      comparisonDimensionSupported(dimension, citedEvidence) &&
      comparisonDimensionSupported(dimension, blockText)
    );
  });
  return subjectChecks.every(Boolean);
}

export function auditProjectAnswerEditorialQuality(input: {
  profile: ProjectAnswerEditorialProfile;
  selection: ProjectAnswerEditorialSelection;
  blocks: GroundedAnswerBlock[];
  rawAnswer?: string;
}): ProjectAnswerEditorialQualityAudit {
  const rawAnswer = input.rawAnswer ??
    input.blocks.map((block) => `${block.heading ? `### ${block.heading}\n` : ""}${block.bodyMarkdown}`).join("\n\n");
  const actualItemCount = displayItemCount(input.profile, input.blocks, rawAnswer);
  const count = input.profile.targetItemCount;
  const itemCount = actualItemCount >= count.minimum && actualItemCount <= count.maximum;
  const represented = representedThemeKeys(input.blocks, input.selection.selectedThemes);
  const expectedPriority = input.selection.selectedThemes.map((theme) => theme.key);
  const requiredPriorityCount = Math.min(3, expectedPriority.length);
  const missingPriorityThemeKeys = expectedPriority
    .slice(0, requiredPriorityCount)
    .filter((key) => !represented.includes(key));
  const outOfOrderThemeKeys = outOfOrderKeys(
    represented.filter((key) => expectedPriority.includes(key)),
    expectedPriority,
  );
  const texts = input.blocks.map(blockText);
  const bodyTexts = input.blocks.map((block) => block.bodyMarkdown.replace(/\s+/g, " ").trim());
  const mechanismBlockCount = texts.filter((text) => mechanismPattern.test(text)).length;
  const valueBlockCount = texts.filter((text) =>
    valuePattern.test(text) ||
    (input.profile.kind === "assessment" && assessmentPattern.test(text)) ||
    (input.profile.kind === "comparison" && comparisonPattern.test(text))
  ).length;
  const depthRatios = requiredDepthRatios(input.profile.kind);
  const mechanism = input.blocks.length > 0 &&
    mechanismBlockCount / input.blocks.length >= depthRatios.mechanism;
  const value = input.blocks.length > 0 &&
    valueBlockCount / input.blocks.length >= depthRatios.value;
  const comparisonContract = comparisonContractPass(
    input.profile,
    input.selection,
    input.blocks,
  );
  const analysis = input.profile.kind === "assessment"
    ? assessmentPattern.test(rawAnswer)
    : input.profile.kind === "comparison"
      ? comparisonPattern.test(rawAnswer) || comparisonContract
      : true;
  const depth = mechanism && value;
  const redundantBlockPairs: Array<[number, number]> = [];
  for (let left = 0; left < texts.length; left += 1) {
    for (let right = left + 1; right < texts.length; right += 1) {
      if (
        Math.max(
          lexicalSimilarity(bodyTexts[left]!, bodyTexts[right]!),
          lexicalSimilarity(texts[left]!, texts[right]!),
        ) >= editorialRedundancyThreshold
      ) {
        redundantBlockPairs.push([left + 1, right + 1]);
      }
    }
  }
  for (const [blockIndex, block] of input.blocks.entries()) {
    const listItems = block.bodyMarkdown
      .split(/\n+/)
      .flatMap((line) =>
        /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
          ? [line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim()]
          : []
      )
      .filter((line) => line.length >= 24);
    let redundantWithinBlock = false;
    for (let left = 0; left < listItems.length && !redundantWithinBlock; left += 1) {
      for (let right = left + 1; right < listItems.length; right += 1) {
        if (lexicalSimilarity(listItems[left]!, listItems[right]!) >= editorialRedundancyThreshold) {
          redundantWithinBlock = true;
          break;
        }
      }
    }
    if (redundantWithinBlock) redundantBlockPairs.push([blockIndex + 1, blockIndex + 1]);
  }
  const lowLevelDetailBlocks = texts.flatMap((text, index) =>
    lowLevelDetailPattern.test(text) ? [index + 1] : []
  );
  const lowLevelDetail = input.profile.kind === "focused" || lowLevelDetailBlocks.length === 0;
  const genericVerificationErrorFree = !genericVerificationErrorPattern.test(rawAnswer);
  const checks = {
    format: formatPass(input.profile, input.blocks, rawAnswer),
    itemCount,
    prioritization: missingPriorityThemeKeys.length === 0 && outOfOrderThemeKeys.length === 0,
    depth,
    mechanism,
    value,
    analysis,
    nonredundant: redundantBlockPairs.length === 0,
    lowLevelDetail,
    genericVerificationErrorFree,
    comparisonContract,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    actualItemCount,
    expectedItemCount: count,
    representedThemeKeys: represented,
    missingPriorityThemeKeys,
    outOfOrderThemeKeys,
    mechanismBlockCount,
    valueBlockCount,
    lowLevelDetailBlocks,
    redundantBlockPairs,
  };
}
