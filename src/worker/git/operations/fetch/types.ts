import type { CacheContext } from "@/worker/cache";
import type { IdxView } from "@/worker/git/object-store/types";

export type OrderedPackSnapshotEntry = {
  packKey: string;
  packBytes: number;
  idx: IdxView;
};

export type OrderedPackSnapshot = {
  packs: OrderedPackSnapshotEntry[];
};

export type ServeUploadPackPlan = {
  type: "Serve";
  repoId: string;
  snapshot: OrderedPackSnapshot;
  neededOids: string[];
  ackOids: string[];
  /**
   * shallow-info section contents — present only when the request carried
   * shallow arguments (deepen/deepen-not/shallow).
   */
  shallowInfo?: { shallow: string[]; unshallow: string[] };
  signal?: AbortSignal;
  cacheCtx?: CacheContext;
};

export type UploadPackPlan =
  | ServeUploadPackPlan
  | {
      type: "RepositoryNotReady";
    };
