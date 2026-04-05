const generationRunMetadataSymbol = Symbol.for("workbase.generation-run-metadata");

export interface GenerationRunMetadata {
  id: string;
  kind:
    | "claim_research"
    | "claim_verification"
    | "artifact_generation"
    | "evidence_clustering";
}

export function attachGenerationRunMetadata<T extends object>(
  value: T,
  metadata: GenerationRunMetadata,
) {
  Object.defineProperty(value, generationRunMetadataSymbol, {
    value: metadata,
    enumerable: false,
    configurable: false,
  });

  return value;
}

export function readGenerationRunMetadata(
  value: unknown,
): GenerationRunMetadata | null {
  if (!value || (typeof value !== "object" && !Array.isArray(value))) {
    return null;
  }

  const metadata = (value as Record<PropertyKey, unknown>)[generationRunMetadataSymbol];

  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  return metadata as GenerationRunMetadata;
}
