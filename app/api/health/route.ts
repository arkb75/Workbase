import { NextResponse } from "next/server";
import { runtimeReadinessService } from "@/src/services/runtime-readiness-service";

export async function GET() {
  const [readiness, textRuntime] = await Promise.all([
    runtimeReadinessService.check(),
    Promise.resolve(runtimeReadinessService.checkTextRuntime()),
  ]);
  if (!textRuntime.ready) {
    return NextResponse.json(
      {
        status: "not_ready",
        product: "Workbase",
        reason: textRuntime.reason,
        recovery: textRuntime.recovery,
        retryable: textRuntime.retryable,
      },
      { status: 503 },
    );
  }
  if (readiness.ready) {
    return NextResponse.json({
      status: "ok",
      product: "Workbase",
      database: "ready",
      schema: "repository-knowledge-v6",
      llm: {
        provider: textRuntime.provider,
        profiles: textRuntime.profiles,
        zeroDataRetention: textRuntime.zeroDataRetention,
      },
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
