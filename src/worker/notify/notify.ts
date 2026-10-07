/**
 * Notification delivery — writes the in-app inbox row (`notifications`
 * table) and, when the recipient has a `gprofile:` email and egress is
 * configured, relays it through `sendEmail`. Email is best-effort and
 * never blocks the row write; callers wrap this in `waitUntil` where the
 * response path shouldn't wait on the mail API.
 */
import { insertNotification } from "@/worker/db/d1/dal/modules";
import type { NewNotificationRow } from "@/worker/db/d1/schema";
import type { Db } from "@/worker/db/d1/client";
import { createLogger } from "@/worker/common/logger";
import { emailConfigured, sendEmail } from "./email";

type ProfileRecord = { email?: string; display_name?: string };

// User contact fields live in the `gprofile:{userId}` KV record — the same
// store the /api/v1/user profile endpoints read and write.
async function profileEmail(env: Env, userId: string): Promise<string | null> {
  const profile = await env.ROUTES.get(`gprofile:${userId}`, "json")
    .then((v) => v as ProfileRecord | null)
    .catch(() => null);
  const email = profile?.email?.trim();
  return email && email.includes("@") ? email : null;
}

export async function deliverNotification(
  env: Env,
  db: Db,
  row: NewNotificationRow,
  fetcher?: typeof fetch
): Promise<void> {
  await insertNotification(db, row);
  const to = await profileEmail(env, row.userId);
  if (!to || !emailConfigured(env)) return;
  const origin = (env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  const link = row.link ? `${origin}${row.link.startsWith("/") ? "" : "/"}${row.link}` : "";
  const text = `${row.title}\n\n${row.body ?? ""}${link ? `\n\n${link}` : ""}`.trim();
  const html = `<p><strong>${escapeHtml(row.title)}</strong></p>${
    row.body ? `<p>${escapeHtml(row.body)}</p>` : ""
  }${link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : ""}`;
  const ok = await sendEmail(env, { to, subject: row.title, text, html }, fetcher);
  if (!ok) {
    createLogger(env.LOG_LEVEL, { service: "Notify" }).debug("notify:email-skipped", {
      kind: row.kind,
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
