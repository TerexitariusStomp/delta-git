#!/usr/bin/env -S npx tsx
// dgit — the delta-git client CLI.
//
//   dgit intents <owner>/<repo>          list merge intents
//   dgit run <owner>/<repo> <intent>     attempt a merge
//   dgit dryrun <owner>/<repo> <oid>     predict conflicts
//   dgit secrets set <owner>/<repo> NAME  write a repo secret (stdin value)
//   dgit watch <dir>                     auto-commit + push on file changes
//
// Auth: DG_PAT env var (Basic PAT) or --did/--key for agent signatures.
// Server: DG_HOST env or --host (default https://delta-git.workers.dev).

import { Command } from "commander";
import { watch } from "chokidar";
import { execFileSync } from "node:child_process";

const program = new Command();

function host(): string {
  return (program.opts().host ?? process.env.DG_HOST ?? "http://localhost:8787").replace(/\/$/, "");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.DG_PAT) {
    const user = process.env.DG_USER ?? "agent";
    h.Authorization = `Basic ${Buffer.from(`${user}:${process.env.DG_PAT}`).toString("base64")}`;
  }
  return h;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${host()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`error ${res.status}:`, body);
    process.exit(1);
  }
  return body;
}

program.name("dgit").description("delta-git client").option("--host <url>", "delta-git host");

program.command("intents <repo>").action(async (repo: string) => {
  const [owner, name] = repo.split("/");
  const data = (await api(`/api/${owner}/${name}/dg/intents`)) as { intents: unknown[] };
  console.log(JSON.stringify(data.intents, null, 2));
});

program.command("run <repo> <intent>").action(async (repo: string, intent: string) => {
  const [owner, name] = repo.split("/");
  const res = await api(`/api/${owner}/${name}/dg/intents/${intent}/run`, {
    method: "POST",
    body: "{}",
  });
  console.log(JSON.stringify(res, null, 2));
});

program
  .command("dryrun <repo> <oid>")
  .option("--ref <ref>", "target ref", "main")
  .action(async (repo: string, oid: string, opts: { ref: string }) => {
    const [owner, name] = repo.split("/");
    const res = await api(`/api/${owner}/${name}/dg/merge/dryrun`, {
      method: "POST",
      body: JSON.stringify({ ref: opts.ref, delta_oid: oid }),
    });
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("secrets")
  .command("set <repo> <name>")
  .action(async (repo: string, name: string) => {
    const [owner, repoName] = repo.split("/");
    const value = execFileSync("cat", [], { input: process.stdin.fd as never })
      .toString()
      .trim();
    const res = await api(`/api/${owner}/${repoName}/dg/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    console.log(JSON.stringify(res));
  });

program
  .command("watch <dir>")
  .description("auto-commit + push on file changes (GH-Desktop-style sync)")
  .option("--debounce <ms>", "debounce window", "2000")
  .action(async (dir: string, opts: { debounce: string }) => {
    const debounceMs = Number(opts.debounce);
    let timer: NodeJS.Timeout | undefined;
    const commit = () => {
      try {
        execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "inherit" });
        execFileSync(
          "git",
          ["-C", dir, "commit", "-m", "dgit watch sync", "--allow-empty-message"],
          {
            stdio: "inherit",
          }
        );
        execFileSync("git", ["-C", dir, "push"], { stdio: "inherit" });
      } catch (error) {
        console.error("watch push failed:", String(error));
      }
    };
    watch(dir, { ignoreInitial: true, ignored: /(^|[/\\])\.git([/\\]|$)/ }).on("all", () => {
      clearTimeout(timer);
      timer = setTimeout(commit, debounceMs);
    });
    console.log(`watching ${dir} — edits auto-commit + push`);
  });

program
  .command("events <repo>")
  .description("tail the repo firehose")
  .action(async (repo: string) => {
    const [owner, name] = repo.split("/");
    const res = await fetch(`${host()}/api/${owner}/${name}/dg/events`, {
      headers: headers(),
    });
    if (!res.body) {
      console.error("no stream");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value));
    }
  });

program.parse();
