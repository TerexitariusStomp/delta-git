import { DownloadIcon, StackIcon } from "@primer/octicons-react";

export type Progress = {
  state: "receiving" | "compacting";
  startedAt?: number;
  expiresAt?: number;
} | null;

type ProgressBannerProps = {
  progress?: Progress;
};

const bannerStyle = (kind: "attention" | "accent") =>
  ({
    border: "1px solid var(--borderColor-muted)",
    backgroundColor: `var(--bgColor-${kind}-muted)`,
    color: `var(--fgColor-${kind})`,
  }) as const;

export function ProgressBanner({ progress }: ProgressBannerProps) {
  if (!progress) {
    return null;
  }

  if (progress.state === "receiving") {
    return (
      <div className="mb-6 rounded-md p-4 text-sm" style={bannerStyle("attention")}>
        <DownloadIcon size={16} aria-hidden="true" className="mr-2 inline align-[-2px]" />
        Receiving push...
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-md p-4 text-sm" style={bannerStyle("accent")}>
      <StackIcon size={16} aria-hidden="true" className="mr-2 inline align-[-2px]" />
      Compacting packs...
    </div>
  );
}
