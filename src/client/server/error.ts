import { renderUiView } from "@/client/server/render";
import { escapeHtml } from "@/shared/web/format";
import { isHttpError } from "@/shared/web/http";

export async function handleError(
  env: Env,
  error: unknown,
  fallbackTitle: string,
  extra?: {
    owner?: string;
    repo?: string;
    refEnc?: string;
    path?: string;
  }
): Promise<Response> {
  const debug = String(env.LOG_LEVEL || "").toLowerCase() === "debug";
  const httpError = isHttpError(error) ? error : undefined;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const status = httpError?.status ?? (/not found/i.test(errorMessage) ? 404 : 500);

  try {
    const html = await renderUiView(env, "error", {
      title: fallbackTitle,
      message: errorMessage,
      owner: extra?.owner,
      repo: extra?.repo,
      refEnc: extra?.refEnc,
      path: extra?.path,
      stack: debug && error instanceof Error ? error.stack : undefined,
    });
    if (html) {
      return new Response(html, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  } catch {}

  return new Response(`<h2>Error</h2><pre>${escapeHtml(errorMessage)}</pre>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
