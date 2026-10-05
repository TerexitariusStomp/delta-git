import type { FileIconName } from "@/shared/web";
import {
  DatabaseIcon,
  FileIcon as OctoFileIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileMediaIcon,
  FileSymlinkFileIcon,
  FileDirectoryIcon,
  FileBinaryIcon,
  TerminalIcon,
  type Icon,
} from "@primer/octicons-react";

type FileIconProps = {
  name: FileIconName;
  className?: string;
};

const iconByName: Record<FileIconName, Icon> = {
  code: FileCodeIcon,
  database: DatabaseIcon,
  diff: FileDiffIcon,
  file: FileBinaryIcon,
  folder: FileDirectoryIcon,
  image: FileMediaIcon,
  spreadsheet: FileBinaryIcon,
  symlink: FileSymlinkFileIcon,
  terminal: TerminalIcon,
  text: OctoFileIcon,
};

export function FileIcon({ name, className }: FileIconProps) {
  const Icon = iconByName[name];
  return (
    <span className={className} aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}
