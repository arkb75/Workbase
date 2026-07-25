import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webhookServiceMock = vi.hoisted(() => ({
  verifySignature: vi.fn(),
  processPush: vi.fn(),
}));

vi.mock("@/src/services/github-webhook-service", () => ({
  githubWebhookService: webhookServiceMock,
}));

import { POST } from "@/app/api/github/webhook/route";

const secret = "w".repeat(32);
const payload = {
  ref: "refs/heads/main",
  after: "a".repeat(40),
  deleted: false,
  repository: {
    id: 123,
    full_name: "workbase/demo",
    default_branch: "main",
  },
};

function request(input?: {
  body?: string;
  event?: string;
  delivery?: string;
  signature?: string;
}) {
  const body = input?.body ?? JSON.stringify(payload);
  return new Request("https://workbase.example/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": input?.event ?? "push",
      "x-github-delivery": input?.delivery ?? "delivery-1",
      "x-hub-signature-256": input?.signature ??
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

describe("GitHub webhook route", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    webhookServiceMock.verifySignature.mockReturnValue(true);
    webhookServiceMock.processPush.mockResolvedValue({
      attachedProjects: 1,
      queued: 1,
      deduplicated: 0,
      failed: 0,
      results: [],
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("rejects a delivery before parsing when its signature is invalid", async () => {
    webhookServiceMock.verifySignature.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(webhookServiceMock.processPush).not.toHaveBeenCalled();
  });

  it("acknowledges signed pings without repository work", async () => {
    const response = await POST(request({ event: "ping", body: JSON.stringify({ zen: "ok" }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
    expect(webhookServiceMock.processPush).not.toHaveBeenCalled();
  });

  it("ignores non-default branches without sacrificing the default-branch freshness barrier", async () => {
    const response = await POST(request({
      body: JSON.stringify({ ...payload, ref: "refs/heads/feature/test" }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "ignored_non_default_branch",
    });
    expect(webhookServiceMock.processPush).not.toHaveBeenCalled();
  });

  it("accepts a default-branch push and queues attached projects", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      attachedProjects: 1,
      queued: 1,
    });
    expect(webhookServiceMock.processPush).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      payload: {
        ...payload,
        repository: { ...payload.repository, id: "123" },
      },
    });
  });

  it("asks GitHub for a retry when no attached refresh could be queued", async () => {
    webhookServiceMock.processPush.mockResolvedValue({
      attachedProjects: 1,
      queued: 0,
      deduplicated: 0,
      failed: 1,
      results: [],
    });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "refresh_queue_failed",
      failed: 1,
    });
  });
});
