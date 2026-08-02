import { OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE } from "@/src/lib/embedding-config";
import {
  OpenRouterEmbeddingRequestError,
  openRouterEmbeddingRequestErrorMessage,
} from "@/src/services/embedding-runtime";

const unsafeEvaluationDiagnostic =
  "Embedding index evaluation failed without exposing provider diagnostics.";
const maximumEvaluationDiagnosticLength = 1_000;

function bounded(message: string) {
  return message.slice(0, maximumEvaluationDiagnosticLength);
}

/** Returns a bounded message that is safe to write to evaluator stderr. */
export function embeddingIndexEvaluationErrorMessage(error: unknown) {
  try {
    if (error instanceof OpenRouterEmbeddingRequestError) {
      return bounded(openRouterEmbeddingRequestErrorMessage(error));
    }
    if (
      error instanceof Error &&
      error.message === OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE
    ) {
      return bounded(OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE);
    }
  } catch {
    // Error subclasses can expose throwing accessors. They are unknown input
    // too, so fall through to the same closed diagnostic.
  }
  // Unknown errors can originate inside fetch/body streams or third-party
  // clients. Pattern-based redaction is not sufficient for IDs, headers, or
  // provider wording, so only explicitly constructed diagnostics are emitted.
  return unsafeEvaluationDiagnostic;
}
