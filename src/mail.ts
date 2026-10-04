// P2: transactional email via CF Email Service (send_email binding, Workers Paid)
import type { Env } from "./env";

export async function sendMail(env: Env, to: string, subject: string, text: string) {
  if (!env.MAIL) return { skipped: true }; // free tier: no outbound mail
  await env.MAIL.send({ from: "no-reply@wp-cloud.dev", to, subject, text } as any);
  return { sent: true };
}
