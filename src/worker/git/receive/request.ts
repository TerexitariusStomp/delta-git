import type { ReceiveCommand } from "@/worker/git/operations/validation";

export type ReceiveNegotiatedCapabilities = {
  reportStatus: boolean;
  sideBand64k: boolean;
  quiet: boolean;
  atomic: boolean;
  ofsDelta: boolean;
  pushOption: boolean;
  agent?: string;
};

export type ParsedReceiveRequest = {
  commands: ReceiveCommand[];
  capabilities: ReceiveNegotiatedCapabilities;
  /**
   * `push-option` strings the client sent after its command list — opaque to
   * the protocol layer; recorded on the `push.received` op-log entry and
   * fanned out on `push` webhook payloads for downstream consumers.
   */
  options: string[];
};

export type ReceiveCommandList = ReceiveCommand[];

function parseCapabilities(firstLine: string): ReceiveNegotiatedCapabilities {
  const nulIndex = firstLine.indexOf("\0");
  const capabilityText = nulIndex >= 0 ? firstLine.slice(nulIndex + 1).trim() : "";
  const tokens = capabilityText.length > 0 ? capabilityText.split(/\s+/) : [];

  let agent: string | undefined;
  for (const token of tokens) {
    if (token.startsWith("agent=")) {
      agent = token;
      break;
    }
  }

  return {
    reportStatus: tokens.includes("report-status"),
    sideBand64k: tokens.includes("side-band-64k"),
    quiet: tokens.includes("quiet"),
    atomic: tokens.includes("atomic"),
    ofsDelta: tokens.includes("ofs-delta"),
    pushOption: tokens.includes("push-option"),
    agent,
  };
}

const COMMAND_LINE_SHAPE = /^[0-9a-fA-F]{40}\s+[0-9a-fA-F]{40}\s+\S/;

export function parseReceiveRequest(lines: string[]): ParsedReceiveRequest {
  const commands: ReceiveCommand[] = [];
  const options: string[] = [];
  const capabilities = parseCapabilities(lines[0] || "");

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index] || "";
    if (index === 0) {
      const nulIndex = line.indexOf("\0");
      if (nulIndex >= 0) {
        line = line.slice(0, nulIndex);
      }
    }

    const trimmed = line.trim();
    // Option lines carry arbitrary text; they only arrive when push-option
    // was negotiated and are distinguished from commands by shape — a ref
    // name can itself contain spaces but never the <oid> <oid> prefix.
    if (!COMMAND_LINE_SHAPE.test(trimmed)) {
      if (capabilities.pushOption && trimmed.length > 0) options.push(trimmed);
      continue;
    }

    const parts = trimmed.split(/\s+/);
    commands.push({
      oldOid: parts[0] || "",
      newOid: parts[1] || "",
      ref: parts.slice(2).join(" "),
    });
  }

  return { commands, capabilities, options };
}
