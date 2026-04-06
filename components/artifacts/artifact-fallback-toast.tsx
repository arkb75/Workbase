"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useToast } from "@/components/ui/toast";

export function ArtifactFallbackToast({
  fallbackWillBeAttempted,
}: {
  fallbackWillBeAttempted: boolean;
}) {
  const { pending } = useFormStatus();
  const { pushToast } = useToast();
  const hasAnnouncedRef = useRef(false);

  useEffect(() => {
    if (!pending) {
      hasAnnouncedRef.current = false;
      return;
    }

    if (!fallbackWillBeAttempted || hasAnnouncedRef.current) {
      return;
    }

    pushToast({
      tone: "warning",
      title: "Starting fallback highlight generation",
      description:
        "No approved highlights are available for this request, so Workbase is generating request-specific fallback highlights from the underlying evidence.",
      durationMs: 5200,
    });
    hasAnnouncedRef.current = true;
  }, [fallbackWillBeAttempted, pending, pushToast]);

  return null;
}
