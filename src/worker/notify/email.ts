/**
 * Outbound email egress for notifications.
 *
 * Deliberately transport-agnostic: posts a Resend-compatible JSON body to
 * `EMAIL_API_URL` (`POST {url}/emails` — {from,to,subject,text,html?}) with
 * `EMAIL_API_KEY` as a Bearer token. Any provider exposing that shape works
 * (Resend, a self-hosted relay, a Workers MailChannels/E-mail-Routing
 * front). When `EMAIL_API_URL` or the key is unset the adapter is a no-op
 * and returns false — in-app notification rows are unaffected.
 */
import { createLogger } from "@/worker/common/logger";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL_API_URL && env.EMAIL_API_KEY);
}

export async function sendEmail(
  env: Env,
  msg: EmailMessage,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  const log = createLogger(env.LOG_LEVEL, { service: "Email" });
  // `EMAIL_API_URL` is typed as the wrangler var literal ("" by default);
  // widen to `string` so the falsy guard narrows correctly.
  const url: string = env.EMAIL_API_URL;
  const key: string = env.EMAIL_API_KEY;
  if (!url || !key) {
    log.debug("email:disabled", { to: msg.to });
    return false;
  }
  const endpoint = `${url.replace(/\/$/, "")}/emails`;
  try {
    const res = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM ?? "delta-git <noreply@delta-git.workers.dev>",
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }),
    });
    if (!res.ok) {
      log.warn("email:send-failed", { status: res.status });
      return false;
    }
    log.info("email:sent", { status: res.status });
    return true;
  } catch (error) {
    log.warn("email:send-error", { error: String(error) });
    return false;
  }
}
