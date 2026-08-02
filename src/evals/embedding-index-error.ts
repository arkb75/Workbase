import { OpenRouterEmbeddingRequestError } from "@/src/services/embedding-runtime";

const sensitiveProviderDiagnostic =
  /https?:\/\/|openrouter\.ai|sk-or-|(?:api[_ -]?key|key|workspace)(?:[_:=/-]|$)/i;

/** Returns a bounded message that is safe to write to evaluator stderr. */
export function embeddingIndexEvaluationErrorMessage(error: unknown) {
  if (error instanceof OpenRouterEmbeddingRequestError) {
    return error.message;
  }
  if (!(error instanceof Error)) {
    return "Embedding index evaluation failed without a safe diagnostic.";
  }
  const message = error.message.trim();
  if (!message || sensitiveProviderDiagnostic.test(message)) {
    return "Embedding index evaluation failed without exposing provider diagnostics.";
  }
  return message.slice(0, 1_000);
}
