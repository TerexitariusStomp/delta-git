import { exports as workerExports } from "cloudflare:workers";
import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import { buildPack, zero40 } from "./git-pack";
import { buildTreePayload } from "./packed-repo";
import { lookupPushAuth } from "./repoSeed";

export const PUSH_URL_BASE = "https://example.com";

/**
 * Push one commit `<parentOid> → <ref>` carrying a README with `text`,
 * through the real HTTP path. Returns the response and the commit oid.
 */
export async function pushCommit(args: {
  owner: string;
  repo: string;
  ref: string;
  parentOid: string;
  /** Expected old oid for the command — `zero40` when creating a ref. */
  oldOid?: string;
  text: string;
}): Promise<{ response: Response; commitOid: string }> {
  const author = "You <you@example.com> 0 +0000";
  const blobPayload = new TextEncoder().encode(args.text);
  const blob = await encodeGitObject("blob", blobPayload);
  const treePayload = buildTreePayload([{ mode: "100644", name: "README.md", oid: blob.oid }]);
  const tree = await encodeGitObject("tree", treePayload);
  const commitPayload = new TextEncoder().encode(
    `tree ${tree.oid}\n` +
      `parent ${args.parentOid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `${args.text}\n`
  );
  const commit = await encodeGitObject("commit", commitPayload);
  const pack = await buildPack([
    { type: "blob", payload: blobPayload },
    { type: "tree", payload: treePayload },
    { type: "commit", payload: commitPayload },
  ]);
  const response = await workerExports.default.fetch(
    `${PUSH_URL_BASE}/${args.owner}/${args.repo}/git-receive-pack`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        Authorization: lookupPushAuth(args.owner, args.repo),
      },
      body: concatChunks([
        pktLine(
          `${args.oldOid ?? args.parentOid} ${commit.oid} ${args.ref}\0 report-status ofs-delta agent=test\n`
        ),
        flushPkt(),
        pack,
      ]),
    } as RequestInit
  );
  return { response, commitOid: commit.oid };
}

export { zero40 };
