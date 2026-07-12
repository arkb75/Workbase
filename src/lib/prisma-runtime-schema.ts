type RuntimeField = { name?: unknown; kind?: unknown };
type RuntimeModel = { fields?: unknown };

function sortedSignature(entries: Array<[string, string[]]>) {
  return entries
    .map(([model, fields]) => [model, [...fields].sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, fields]) => `${model}:${fields.join(",")}`)
    .join("|");
}

export function generatedPrismaSchemaSignature(namespace: Record<string, unknown>) {
  const entries = Object.entries(namespace).flatMap(([key, value]) => {
    if (!key.endsWith("ScalarFieldEnum") || !value || typeof value !== "object" || Array.isArray(value)) return [];
    const model = key.slice(0, -"ScalarFieldEnum".length);
    const fields = Object.values(value).filter((field): field is string => typeof field === "string");
    return fields.length ? [[model, fields] as [string, string[]]] : [];
  });
  return entries.length ? sortedSignature(entries) : null;
}

export function prismaClientRuntimeSchemaSignature(client: unknown) {
  if (!client || typeof client !== "object") return null;
  const runtime = (client as { _runtimeDataModel?: { models?: Record<string, RuntimeModel> } })._runtimeDataModel;
  if (!runtime?.models) return null;
  const entries = Object.entries(runtime.models).flatMap(([model, definition]) => {
    if (!Array.isArray(definition.fields)) return [];
    const fields = definition.fields
      .filter((field): field is RuntimeField => Boolean(field && typeof field === "object" && !Array.isArray(field)))
      .filter((field) => field.kind !== "object")
      .flatMap((field) => typeof field.name === "string" ? [field.name] : []);
    return fields.length ? [[model, fields] as [string, string[]]] : [];
  });
  return entries.length ? sortedSignature(entries) : null;
}
