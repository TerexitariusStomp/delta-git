interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean }
  ): Record<string, unknown>;
}

declare module "*.css" {
  const value: string;
  export default value;
}

declare module "*.css?url" {
  const value: string;
  export default value;
}
