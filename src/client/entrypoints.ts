export const clientEntrypoints = {
  styles: "src/client/entries/styles.ts",
  shell: "src/client/entries/shell.ts",
  didSignin: "src/client/entries/did-signin.ts",
} as const;

export type ClientEntrypoint = (typeof clientEntrypoints)[keyof typeof clientEntrypoints];
