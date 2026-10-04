// Plan entitlements — quota enforcement (P1) + Always-On billing (P5)
export interface Plan {
  name: string;
  price_micro: number;      // monthly debit, micro-USDC
  lane_max: number;         // highest lane allowed
  sites_max: number;
  storage_mb: number;
  manifests_keep: number;   // retention: versions to keep
  always_on: boolean;       // container never sleeps (Lane 3)
  git_semantics: boolean;   // delta-git integration entitlement
}

export const PLANS: Record<string, Plan> = {
  creator:   { name: "Creator",   price_micro: 0,        lane_max: 1, sites_max: 1,  storage_mb: 200,   manifests_keep: 3,  always_on: false, git_semantics: false },
  micro:     { name: "Micro",     price_micro: 5_000_000, lane_max: 1, sites_max: 3,  storage_mb: 1024,  manifests_keep: 10, always_on: false, git_semantics: true },
  starter:   { name: "Starter",   price_micro: 9_000_000, lane_max: 2, sites_max: 5,  storage_mb: 4096,  manifests_keep: 20, always_on: false, git_semantics: true },
  pro:       { name: "Pro",       price_micro: 19_000_000, lane_max: 3, sites_max: 10, storage_mb: 20480, manifests_keep: 50, always_on: false, git_semantics: true },
  business:  { name: "Business",  price_micro: 49_000_000, lane_max: 3, sites_max: 25, storage_mb: 102400,manifests_keep: 100, always_on: true,  git_semantics: true },
  always_on: { name: "Always-On", price_micro: 19_000_000, lane_max: 3, sites_max: 5,  storage_mb: 20480, manifests_keep: 50, always_on: true,  git_semantics: true },
  enterprise:{ name: "Enterprise",price_micro: 499_000_000,lane_max: 3, sites_max: 250,storage_mb: 1048576,manifests_keep: 500, always_on: true, git_semantics: true },
  agency:    { name: "Agency",    price_micro: 199_000_000, lane_max: 3, sites_max: 25, storage_mb: 256000,manifests_keep: 100, always_on: false, git_semantics: true },
};

export function planFor(row: { plan?: string } | null | undefined): Plan {
  return PLANS[row?.plan ?? "creator"] ?? PLANS.creator;
}
