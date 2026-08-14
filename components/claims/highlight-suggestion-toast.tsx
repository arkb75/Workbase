"use client";

import { useEffect } from "react";
import { useToast } from "@/components/ui/toast";

export function HighlightSuggestionToast({
  workItemId,
  suggestionCount,
}: {
  workItemId: string;
  suggestionCount: number;
}) {
  const { pushToast } = useToast();

  useEffect(() => {
    if (!suggestionCount) {
      return;
    }

    pushToast({
      title: "Suggested highlight updates ready",
      description:
        suggestionCount === 1
          ? "One approved highlight has a proposed update from the latest import."
          : `${suggestionCount} approved highlights have proposed updates from the latest import.`,
      tone: "info",
      durationMs: 9000,
      action: {
        label: "View suggestions",
        href: `/work-items/${workItemId}?tab=highlights#suggested-updates`,
      },
    });
  }, [pushToast, suggestionCount, workItemId]);

  return null;
}
