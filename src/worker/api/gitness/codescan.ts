import type { AppRouter } from "@/worker/routes/hono";

import { newPrefixedId } from "@/worker/common";
import { gErr, gNotFound, requireWriter, resolveGitnessRepo } from "./shared";
import {
  findAnalysisForAlert,
  listScanAnalyses,
  readScanAnalysis,
  writeScanAnalysis,
  writeScanAnalysisRecord,
  type ScanAlert,
  type ScanAnalysis,
} from "./stores";

// GitHub-shaped code-scanning surface: external scanners (trivy, semgrep,
// agent pipelines) upload SARIF 2.1.0; the repo Security tab and agents
// read analyses + alerts back. Storage is KV — analyses are small once
// flattened to alert rows, and dismissals need read-modify-write anyway.

const MAX_SARIF_BYTES = 2 * 1024 * 1024;
const MAX_ALERTS = 500;

// SARIF shapes we consume — results are flattened to ScanAlert at upload.
type SarifResult = {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: {
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }[];
};
type SarifDoc = {
  runs?: { tool?: { driver?: { name?: string } }; results?: SarifResult[] }[];
};

function alertView(a: ScanAlert) {
  return {
    number: a.number,
    rule_id: a.ruleId,
    severity: a.level,
    state: a.state,
    message: { text: a.message },
    location: { path: a.path, start_line: a.line },
    dismissed_at: a.dismissedAt ?? null,
  };
}

export function registerGitnessCodeScan(router: AppRouter) {
  // POST .../code-scanning/sarifs — accepts a raw SARIF object or the
  // GitHub base64-encoded string form.
  router.post("/api/v1/repos/:repo_ref{.+}/code-scanning/sarifs", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      commit_sha?: string;
      ref?: string;
      sarif?: unknown;
    } | null;
    if (!body?.sarif) return gErr(c, 422, "sarif required");

    let doc: SarifDoc;
    if (typeof body.sarif === "string") {
      let decoded: string;
      try {
        decoded = new TextDecoder().decode(
          Uint8Array.from(atob(body.sarif), (ch) => ch.charCodeAt(0))
        );
      } catch {
        return gErr(c, 422, "sarif string must be base64-encoded JSON");
      }
      if (decoded.length > MAX_SARIF_BYTES) return gErr(c, 413, "sarif too large");
      doc = JSON.parse(decoded) as SarifDoc;
    } else {
      doc = body.sarif as SarifDoc;
    }
    if (!Array.isArray(doc?.runs) || doc.runs.length === 0) {
      return gErr(c, 422, "sarif must contain at least one run");
    }

    const alerts: ScanAlert[] = [];
    let toolName = "unknown";
    for (const run of doc.runs) {
      if (run.tool?.driver?.name) toolName = run.tool.driver.name;
      for (const r of run.results ?? []) {
        if (alerts.length >= MAX_ALERTS) break;
        const loc = r.locations?.[0]?.physicalLocation;
        alerts.push({
          number: 0, // assigned by writeScanAnalysis
          ruleId: r.ruleId ?? "unknown",
          level: r.level ?? "warning",
          message: r.message?.text ?? "",
          path: loc?.artifactLocation?.uri ?? "",
          line: loc?.region?.startLine ?? 0,
          state: "open",
        });
      }
    }

    const analysis: ScanAnalysis = {
      id: newPrefixedId("scan"),
      commitSha: body.commit_sha ?? "",
      ref: body.ref ?? "",
      toolName,
      createdAt: Date.now(),
      alerts,
    };
    await writeScanAnalysis(c.env, access.route.doName, analysis);
    return c.json({ id: analysis.id, results_count: alerts.length }, 202);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/code-scanning/analyses", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const analyses = await listScanAnalyses(c.env, access.route.doName);
    return c.json(
      analyses.map((a) => ({
        id: a.id,
        ref: a.ref,
        commit_sha: a.commitSha,
        tool: { name: a.toolName },
        results_count: a.resultsCount,
        created_at: new Date(a.createdAt).toISOString(),
      }))
    );
  });

  // Alerts across all analyses — newest analysis wins per GitHub, but for
  // a v1 surface flat is fine (agents filter on state).
  router.get("/api/v1/repos/:repo_ref{.+}/code-scanning/alerts", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const wanted = c.req.query("state");
    const index = await listScanAnalyses(c.env, access.route.doName);
    const out: ReturnType<typeof alertView>[] = [];
    for (const meta of index) {
      const analysis = await readScanAnalysis(c.env, access.route.doName, meta.id);
      if (!analysis) continue;
      for (const a of analysis.alerts) {
        if (wanted && a.state !== wanted) continue;
        out.push({ ...alertView(a), analysis_id: analysis.id } as ReturnType<typeof alertView>);
      }
      if (out.length >= MAX_ALERTS) break;
    }
    return c.json(out);
  });

  // PATCH .../alerts/:number {state:"dismissed"|"open"} — GitHub shape.
  router.patch("/api/v1/repos/:repo_ref{.+}/code-scanning/alerts/:number", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return gNotFound(c, "alert");
    const body = (await c.req.json().catch(() => null)) as { state?: string } | null;
    if (body?.state !== "dismissed" && body?.state !== "open") {
      return gErr(c, 422, 'state must be "dismissed" or "open"');
    }
    const analysisId = await findAnalysisForAlert(c.env, access.route.doName, number);
    if (!analysisId) return gNotFound(c, "alert");
    const analysis = await readScanAnalysis(c.env, access.route.doName, analysisId);
    const alert = analysis?.alerts.find((a) => a.number === number);
    if (!analysis || !alert) return gNotFound(c, "alert");
    alert.state = body.state;
    alert.dismissedAt = body.state === "dismissed" ? Date.now() : undefined;
    await writeScanAnalysisRecord(c.env, access.route.doName, analysis);
    return c.json(alertView(alert));
  });
}
