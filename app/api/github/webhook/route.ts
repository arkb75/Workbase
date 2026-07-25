import { githubPushWebhookSchema } from "@/src/lib/github-schemas";
import { resolveGitHubWebhookSecret } from "@/src/lib/github-config";
import { githubWebhookService } from "@/src/services/github-webhook-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;
const deliveryIdPattern = /^[a-z0-9-]{1,128}$/i;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let secret: string;
  try {
    secret = resolveGitHubWebhookSecret();
  } catch {
    return Response.json(
      { ok: false, error: "webhook_not_configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  if (!githubWebhookService.verifySignature({
    secret,
    signature: request.headers.get("x-hub-signature-256"),
    payload: body,
  })) {
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event")?.trim().toLowerCase();
  if (event === "ping") {
    return Response.json({ ok: true, status: "ready" });
  }
  if (event !== "push") {
    return Response.json({ ok: true, status: "ignored_event" }, { status: 202 });
  }

  const deliveryId = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!deliveryIdPattern.test(deliveryId)) {
    return Response.json({ ok: false, error: "invalid_delivery_id" }, { status: 400 });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const parsed = githubPushWebhookSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid_push_payload" }, { status: 400 });
  }
  const payload = parsed.data;
  if (
    payload.deleted ||
    /^0+$/.test(payload.after) ||
    payload.ref !== `refs/heads/${payload.repository.default_branch}`
  ) {
    return Response.json(
      { ok: true, status: "ignored_non_default_branch" },
      { status: 202 },
    );
  }

  const result = await githubWebhookService.processPush({ deliveryId, payload });
  if (result.failed > 0 && result.queued + result.deduplicated === 0) {
    return Response.json(
      {
        ok: false,
        status: "refresh_queue_failed",
        attachedProjects: result.attachedProjects,
        failed: result.failed,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      ok: true,
      status: result.attachedProjects ? "accepted" : "unattached_repository",
      attachedProjects: result.attachedProjects,
      queued: result.queued,
      deduplicated: result.deduplicated,
      failed: result.failed,
    },
    { status: 202 },
  );
}
