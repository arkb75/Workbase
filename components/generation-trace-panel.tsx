import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import type { JsonValue } from "@/src/domain/types";
import { formatDateTime, titleCase } from "@/src/lib/utils";

type TraceValue = JsonValue | null | unknown;

function prettyJson(value: TraceValue) {
  if (value === null || typeof value === "undefined") {
    return "Not recorded";
  }

  return JSON.stringify(value, null, 2);
}

function toneForStatus(status: string) {
  if (status === "success") {
    return "success" as const;
  }

  if (status === "provider_error") {
    return "danger" as const;
  }

  return "warning" as const;
}

export function GenerationTracePanel({
  traces,
  title = "Generation traces",
  description = "Internal debugging detail for model-backed generation runs.",
}: {
  traces: Array<{
    id: string;
    kind: string;
    status: string;
    provider: string;
    modelId: string;
    inputSummary: unknown;
    rawOutput: string | null;
    parsedOutput: unknown;
    validationErrors: unknown;
    resultRefs: unknown;
    tokenUsage: unknown;
    createdAt: Date | string;
  }>;
  title?: string;
  description?: string;
}) {
  return (
    <details className="group">
      <summary className="list-none cursor-pointer">
        <Card className="border-dashed border-black/10 shadow-none transition group-open:border-[color:var(--accent)]">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{title}</CardTitle>
              <Badge>{traces.length} runs</Badge>
            </div>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
        </Card>
      </summary>

      <div className="mt-4 grid gap-4">
        {traces.length ? (
          traces.map((trace) => (
            <Card key={trace.id} className="shadow-none">
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{titleCase(trace.kind)}</Badge>
                  <Badge tone={toneForStatus(trace.status)}>
                    {titleCase(trace.status)}
                  </Badge>
                  <Badge>{trace.provider}</Badge>
                  <Badge>{trace.modelId}</Badge>
                </div>
                <CardDescription>{formatDateTime(trace.createdAt)}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <KeyValue label="Input summary" value={<TraceBlock value={trace.inputSummary} />} />
                  <KeyValue label="Token usage" value={<TraceBlock value={trace.tokenUsage} />} />
                  <KeyValue label="Validation errors" value={<TraceBlock value={trace.validationErrors} />} />
                  <KeyValue label="Result refs" value={<TraceBlock value={trace.resultRefs} />} />
                </div>
                <KeyValue
                  label="Parsed output"
                  value={<TraceBlock value={trace.parsedOutput} />}
                />
                <KeyValue
                  label="Raw output"
                  value={
                    <pre className="max-h-96 overflow-auto rounded-[20px] bg-[color:var(--panel-muted)] p-4 text-xs leading-6 text-[color:var(--ink-strong)]">
                      {trace.rawOutput ?? "Not recorded"}
                    </pre>
                  }
                />
              </CardContent>
            </Card>
          ))
        ) : (
          <Card className="shadow-none">
            <CardContent className="py-6">
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No generation traces have been recorded yet.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </details>
  );
}

function TraceBlock({ value }: { value: TraceValue }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-[20px] bg-[color:var(--panel-muted)] p-4 text-xs leading-6 text-[color:var(--ink-strong)]">
      {prettyJson(value)}
    </pre>
  );
}
