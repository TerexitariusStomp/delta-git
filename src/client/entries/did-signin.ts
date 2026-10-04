import { initDidSignInIsland } from "@/client/islands/did-signin";
import { onReady } from "../on-ready";

onReady(() => {
  initDidSignInIsland();
});
