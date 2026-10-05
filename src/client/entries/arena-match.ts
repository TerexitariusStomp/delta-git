import { initArenaPoll } from "@/client/islands/arena-poll";
import { onReady } from "../on-ready";

onReady(() => {
  initArenaPoll();
});
