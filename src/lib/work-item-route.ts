import { notFound } from "next/navigation";

export function isMissingPrismaRecordError(cause: unknown): cause is Error & { code: "P2025" } {
  return cause instanceof Error
    && "code" in cause
    && (cause as Error & { code?: unknown }).code === "P2025";
}

/**
 * Converts the expected "work item is absent or not owned by this user" data
 * outcome into the App Router's not-found boundary. Other database and
 * application failures remain exceptions so they are not mislabeled as 404s.
 */
export async function loadWorkItemRouteData<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    if (isMissingPrismaRecordError(cause)) {
      notFound();
    }
    throw cause;
  }
}
