import type { ClaimResearchService } from "@/src/services/types";
import { highlightGenerationService } from "@/src/services/highlight-generation-service";

export const claimResearchService: ClaimResearchService = {
  async generate(input) {
    const result = await highlightGenerationService.generate({
      workItem: input.workItem,
      evidenceItems: input.evidenceItems,
      existingHighlights: input.existingHighlights ?? [],
    });

    return {
      highlights: result.highlights,
      generationRunIds: result.generationRunIds,
    };
  },
};
