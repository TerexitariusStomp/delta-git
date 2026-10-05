import { initThemeToggle } from "@/client/islands/theme-toggle";
import { initCopyButton } from "@/client/islands/copy-button";
import { onReady } from "../on-ready";

onReady(() => {
  initThemeToggle();
  initCopyButton();
});
