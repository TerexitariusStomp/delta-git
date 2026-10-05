import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureArtifactsPushSubscription } from "@/worker/tasks/artifactsSubscriptions";

function envOf(overrides: Partial<Env>): Env {
  return {
    LOG_LEVEL: "warn",
    CF_ACCOUNT_ID: "acct-1",
    CF_API_TOKEN: "token-1",
    ...overrides,
  } as unknown as Env;
}

function ctxOf(pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  } as unknown as ExecutionContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const QUEUE_LIST_OK = {
  success: true,
  result: [{ queue_id: "q-1", queue_name: "dg-artifacts-events" }],
};

describe("ensureArtifactsPushSubscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops without CF credentials", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(
      ctxOf(pending),
      envOf({ CF_ACCOUNT_ID: "", CF_API_TOKEN: "" }),
      "dg-abc"
    );
    await Promise.all(pending);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops on the dev placeholder token", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(
      ctxOf(pending),
      envOf({ CF_API_TOKEN: "local-placeholder" }),
      "dg-abc"
    );
    await Promise.all(pending);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves the queue by name and creates a per-repo subscription", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/queues?")) return jsonResponse(QUEUE_LIST_OK);
        return jsonResponse({ success: true, result: { id: "sub-1" } });
      })
    );
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(ctxOf(pending), envOf({}), "dg-feedface1234");
    await Promise.all(pending);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/accounts/acct-1/queues?name=dg-artifacts-events");
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(calls[1]!.url).toContain("/accounts/acct-1/event_subscriptions/subscriptions");
    expect(body).toMatchObject({
      name: "dg-push-dg-feedface1234",
      enabled: true,
      source: { type: "artifacts.repo", namespace: "delta-git", repo_name: "dg-feedface1234" },
      events: ["pushed"],
      destination: { type: "queues.queue", queue_id: "q-1" },
    });
  });

  it("treats a duplicate-subscription error as already subscribed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/queues?")) return jsonResponse(QUEUE_LIST_OK);
        return jsonResponse(
          {
            success: false,
            errors: [
              {
                message: "We currently do not support multiple subscriptions on the same resource.",
              },
            ],
          },
          400
        );
      })
    );
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(ctxOf(pending), envOf({}), "dg-abc");
    // Must settle without throwing — the waitUntil catch is the safety net,
    // but a clean resolve avoids the warn path entirely.
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it("stops after a failed queue lookup", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/queues?")) return jsonResponse({ success: true, result: [] });
        return jsonResponse({ success: true, result: { id: "sub-1" } });
      })
    );
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(ctxOf(pending), envOf({}), "dg-abc");
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/queues?");
  });
});
