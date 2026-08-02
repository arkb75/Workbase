import {
  calculateApplicationModelMetrics,
  type ApplicationGenerationRun,
  type ApplicationModelEvent,
} from "@/src/evals/project-chat-application-metrics";

export interface LegacyProjectChatTelemetryInput {
  provider: string;
  modelId: string;
  events: ApplicationModelEvent[];
  dossierModelUsage: unknown;
  generationRuns: ApplicationGenerationRun[];
  storedResult: unknown;
  expectedModelIdsByProfile?: Readonly<Record<string, string>>;
}

export function buildLegacyProjectChatModelTelemetry(
  input: LegacyProjectChatTelemetryInput,
) {
  const metrics = calculateApplicationModelMetrics(input);
  const invokedProfiles = Object.values(
    metrics.modelAttribution.profiles,
  ).filter((profile) => profile.providerAttempts > 0);
  const openRouter = input.provider.toLowerCase() === "openrouter";
  const cleanZeroCallResult =
    metrics.modelCalls === 0 &&
    metrics.totalTokens === 0 &&
    metrics.estimatedCostUsd === 0 &&
    metrics.usageComplete &&
    metrics.modelAttribution.providerAttempts === 0 &&
    metrics.modelAttribution.failedProviderAttempts === 0 &&
    metrics.modelAttribution.failedModelIds.length === 0 &&
    metrics.modelAttribution.requestIds.length === 0 &&
    metrics.modelAttribution.routedProviders.length === 0 &&
    !metrics.modelAttribution.fallbackUsed &&
    metrics.modelAttribution.authoritativeAttributionComplete &&
    invokedProfiles.length === 0;
  const authoritativeAttributionComplete =
    !openRouter ||
    cleanZeroCallResult ||
    (
      metrics.modelCalls > 0 &&
      metrics.usageComplete &&
      metrics.modelAttribution.providers.includes("openrouter") &&
      metrics.modelAttribution.actualModelIds.length > 0 &&
      metrics.modelAttribution.routedProviders.length > 0 &&
      metrics.modelAttribution.requestIds.length > 0 &&
      metrics.modelAttribution.authoritativeAttributionComplete &&
      invokedProfiles.length > 0 &&
      invokedProfiles.every(
        (profile) =>
          profile.usageComplete &&
          profile.authoritativeAttributionComplete,
      )
    );
  const noFallbackAttempts =
    !openRouter ||
    (
      !metrics.modelAttribution.fallbackUsed &&
      metrics.modelAttribution.failedProviderAttempts === 0 &&
      metrics.modelAttribution.failedModelIds.length === 0
    );
  const profileRoutingMatches =
    !openRouter ||
    cleanZeroCallResult ||
    (
      invokedProfiles.length > 0 &&
      invokedProfiles.every(
        (profile) => profile.configuredRoutingMatched,
      )
    );

  return {
    metrics,
    acceptance: {
      authoritativeAttributionComplete,
      noFallbackAttempts,
      profileRoutingMatches,
    },
  };
}
