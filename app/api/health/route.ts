import { NextResponse } from "next/server";
import { runtimeReadinessService } from "@/src/services/runtime-readiness-service";

export async function GET() {
  const readiness = await runtimeReadinessService.check();
  if (readiness.ready) {
    return NextResponse.json({
      status: "ok",
      product: "Workbase",
      database: "ready",
      schema: "repository-knowledge-v6",
    });
  }
  return NextResponse.json(
    {
      status: "not_ready",
      product: "Workbase",
      reason: readiness.reason,
      recovery: readiness.recovery,
      retryable: readiness.retryable,
    },
    { status: 503 },
  );
}
