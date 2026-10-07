import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { newPrefixedId } from "@/worker/common/ids";
import { createDb } from "@/worker/db/d1/client";
import { insertUserIfNew, listNotificationsForUser } from "@/worker/db/d1/dal";
import { emailConfigured, sendEmail } from "@/worker/notify/email";
import { deliverNotification } from "@/worker/notify/notify";

import { readAppD1Migrations } from "./util/d1Migrations";

beforeAll(async () => {
  await applyD1Migrations(env.DB, readAppD1Migrations());
});

// An env with egress pointed at a stub provider — the fetcher is injected so
// no real network happens. `Object.assign` keeps the result assignable to
// `Env` despite the literal-typed wrangler vars ("" for EMAIL_API_URL).
const mailEnv: Env = Object.assign({}, env, {
  EMAIL_API_URL: "https://mail.test",
  EMAIL_API_KEY: "test-mail-key",
  PUBLIC_ORIGIN: "https://dg.test",
});

async function seedUser(id: string, email?: string) {
  const db = createDb(env.DB);
  await insertUserIfNew(db, { id, tesseraSub: `sub-${id}`, createdAt: Date.now() });
  if (email) {
    await env.ROUTES.put(`gprofile:${id}`, JSON.stringify({ email }));
  }
  return db;
}

function notifRow(userId: string) {
  return {
    id: newPrefixedId("ntf"),
    userId,
    kind: "push",
    title: "repo: push to main",
    body: "someone pushed 1 ref update(s)",
    link: "/space/repo",
    createdAt: Date.now(),
    readAt: null,
  };
}

describe("notification email egress", () => {
  it("reports unconfigured when EMAIL_API_URL is empty", () => {
    expect(emailConfigured(env)).toBe(false);
    expect(emailConfigured(mailEnv)).toBe(true);
  });

  it("posts a Resend-shaped body with Bearer auth", async () => {
    let captured: { url: string; auth: string; body: Record<string, unknown> } | null = null;
    const stub: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      captured = {
        url: req.url,
        auth: req.headers.get("authorization") ?? "",
        body: (await req.json()) as Record<string, unknown>,
      };
      return new Response("{}", { status: 200 });
    };
    const ok = await sendEmail(
      mailEnv,
      { to: "dev@example.com", subject: "hi", text: "body text" },
      stub
    );
    expect(ok).toBe(true);
    expect(captured!.url).toBe("https://mail.test/emails");
    expect(captured!.auth).toBe("Bearer test-mail-key");
    expect(captured!.body.to).toBe("dev@example.com");
    expect(captured!.body.from).toBe(env.EMAIL_FROM);
    expect(captured!.body.text).toBe("body text");
  });

  it("writes the inbox row and skips email when egress is unconfigured", async () => {
    const db = await seedUser("usr-mail-off", "dev@example.com");
    await deliverNotification(env, db, notifRow("usr-mail-off"));
    const rows = await listNotificationsForUser(db, "usr-mail-off");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("repo: push to main");
  });

  it("writes the row and relays email when the profile has an address", async () => {
    const db = await seedUser("usr-mail-on", "dev@example.com");
    let sent = 0;
    const stub: typeof fetch = async () => {
      sent++;
      return new Response("{}", { status: 200 });
    };
    await deliverNotification(mailEnv, db, notifRow("usr-mail-on"), stub);
    expect(sent).toBe(1);
    const rows = await listNotificationsForUser(db, "usr-mail-on");
    expect(rows).toHaveLength(1);
  });

  it("keeps the row when the mail API fails", async () => {
    const db = await seedUser("usr-mail-500", "dev@example.com");
    const failing: typeof fetch = async () => new Response("boom", { status: 500 });
    await deliverNotification(mailEnv, db, notifRow("usr-mail-500"), failing);
    const rows = await listNotificationsForUser(db, "usr-mail-500");
    expect(rows).toHaveLength(1);
  });

  it("keeps the row when the mail API throws", async () => {
    const db = await seedUser("usr-mail-throw", "dev@example.com");
    const throwing: typeof fetch = async () => {
      throw new Error("network down");
    };
    await deliverNotification(mailEnv, db, notifRow("usr-mail-throw"), throwing);
    const rows = await listNotificationsForUser(db, "usr-mail-throw");
    expect(rows).toHaveLength(1);
  });

  it("skips email silently when the user has no profile address", async () => {
    const db = await seedUser("usr-mail-none");
    let sent = 0;
    const stub: typeof fetch = async () => {
      sent++;
      return new Response("{}", { status: 200 });
    };
    await deliverNotification(mailEnv, db, notifRow("usr-mail-none"), stub);
    expect(sent).toBe(0);
    const rows = await listNotificationsForUser(db, "usr-mail-none");
    expect(rows).toHaveLength(1);
  });
});
