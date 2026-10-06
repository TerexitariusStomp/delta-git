import { decodePktLines } from "@/worker/git/core";

export type FetchArgs = {
  wants: string[];
  haves: string[];
  done: boolean;
  /** `deepen <n>` — truncate history at depth n from the want tips. */
  deepen?: number;
  /** `deepen-not <rev>` tips — history reachable from these is excluded. */
  deepenNot: string[];
  /**
   * `shallow <oid>` — commits the client already marks as shallow boundary.
   * They act as additional stop points (the client has them) and are echoed
   * in shallow-info unless the server sends them with parents.
   */
  clientShallows: string[];
  /** `filter <spec>` — partial-clone object filter (see fetch/filter.ts). */
  filter?: string;
};

/**
 * Parses Git fetch protocol v2 arguments from request body.
 * Extracts wants, haves, done, and the shallow/filter feature arguments.
 *
 * `deepen-since` and `deepen-relative` are deliberately not advertised in the
 * capability list, so conforming clients never send them; they are ignored
 * here (a non-conforming client gets a superset pack, which stays valid).
 *
 * @param body - Raw request body in pkt-line format
 * @returns Object containing wants, haves, done, and shallow/filter args
 */
export function parseFetchArgs(body: Uint8Array): FetchArgs {
  const items = decodePktLines(body);
  const wantSet = new Set<string>();
  const haves: string[] = [];
  const deepenNot: string[] = [];
  const clientShallows: string[] = [];
  let done = false;
  let deepen: number | undefined;
  let filter: string | undefined;

  for (const item of items) {
    if (item.type === "line" && item.text) {
      const text = item.text.trimEnd();
      if (text.startsWith("want ")) {
        const oid = text.slice(5);
        if (oid.length >= 40) wantSet.add(oid.substring(0, 40));
      } else if (text.startsWith("have ")) {
        const oid = text.slice(5);
        if (oid.length >= 40) haves.push(oid.substring(0, 40));
      } else if (text.startsWith("deepen ")) {
        const depth = Number(text.slice(7));
        if (Number.isSafeInteger(depth) && depth > 0) deepen = depth;
      } else if (text.startsWith("deepen-not ")) {
        const rev = text.slice(11).trim();
        if (rev) deepenNot.push(rev);
      } else if (text.startsWith("shallow ")) {
        const oid = text.slice(8);
        if (oid.length >= 40) clientShallows.push(oid.substring(0, 40).toLowerCase());
      } else if (text.startsWith("filter ")) {
        filter = text.slice(7).trim();
      } else if (text === "done") {
        done = true;
      }
    }
  }

  const wants = Array.from(wantSet);
  return { wants, haves, done, deepen, deepenNot, clientShallows, filter };
}
