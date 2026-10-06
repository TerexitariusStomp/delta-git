/// <reference lib="dom" />

import { useState } from "react";
import { Fingerprint, KeyRound } from "lucide-react";

import { hydrateIsland } from "@/client/hydrate";
import { Button, ErrorBanner, Input } from "@/client/components/ui";

// DID sign-in island — two paths behind one input:
//   handle (alice.bsky.social) → /signin → client-side Bluesky OAuth (browser
//     custody: tokens never transit the worker)
//   did:* (did:plc:/did:key:) → /auth/did/challenge → paste-signed verify
//
// The manual challenge path stays for device keys and agents; humans get the
// OAuth redirect they expect. The server never sees a private key.

type Challenge = {
  did: string;
  nonce: string;
  payload: string;
  iat: number;
  exp: number;
};

type Step = "identify" | "sign";

export type DidSignInIslandProps = Record<string, never>;

export function DidSignInIsland(_props: DidSignInIslandProps) {
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const continueWithAtproto = async () => {
    const id = identifier.trim();
    // Handles (and an empty box — Bluesky asks there) go through the
    // client-side OAuth flow on /signin; DIDs sign a challenge, since
    // did:key/device keys aren't OAuth accounts.
    if (!id.startsWith("did:")) {
      const qs = id ? `?handle=${encodeURIComponent(id)}` : "";
      window.location.assign(`/signin${qs}`);
      return;
    }
    await fetchChallenge();
  };

  const fetchChallenge = async () => {
    setError(null);
    setBusy(true);
    try {
      const id = identifier.trim();
      const qs = id.startsWith("did:")
        ? `did=${encodeURIComponent(id)}`
        : `handle=${encodeURIComponent(id)}`;
      const res = await fetch(`/auth/did/challenge?${qs}`);
      const body = (await res.json()) as Challenge & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not issue a sign-in challenge.");
        return;
      }
      setChallenge(body);
      setStep("sign");
    } catch {
      setError("Network error issuing the challenge.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/auth/did/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          did: challenge.did,
          nonce: challenge.nonce,
          sig: signature.trim(),
          iat: challenge.iat,
          exp: challenge.exp,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Signature verification failed.");
        return;
      }
      window.location.assign("/auth/account");
    } catch {
      setError("Network error during verification.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "identify") {
    return (
      <div className="flex flex-col items-stretch gap-4">
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Handle or DID</span>
          <Input
            value={identifier}
            onChange={(e) => setIdentifier(e.currentTarget.value)}
            placeholder="alice.bsky.social or did:plc:…"
            autoComplete="username"
          />
        </label>
        <Button variant="primary" onClick={continueWithAtproto} disabled={busy}>
          <Fingerprint className="h-4 w-4" aria-hidden="true" />
          {busy
            ? "Issuing challenge…"
            : identifier.trim().startsWith("did:")
              ? "Continue with challenge"
              : "Continue with Bluesky"}
        </Button>
        <button
          type="button"
          className="cursor-pointer self-center text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:text-zinc-400 dark:decoration-zinc-700 dark:hover:text-zinc-200"
          onClick={fetchChallenge}
          disabled={busy || !identifier.trim()}
        >
          Sign with an atproto key instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">
          Sign this payload with your atproto key ({challenge?.did.slice(0, 32)}…):
        </span>
        <pre className="m-0 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50/60 p-2 font-mono text-xs break-all whitespace-pre-wrap text-zinc-600 dark:border-zinc-800/60 dark:bg-zinc-950/40 dark:text-zinc-400">
          {challenge?.payload}
        </pre>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Signature (base64url)</span>
        <Input
          value={signature}
          onChange={(e) => setSignature(e.currentTarget.value)}
          placeholder="Paste the signature over the payload above"
        />
      </label>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={verify}
          disabled={busy || !signature.trim()}
          className="flex-1"
        >
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {busy ? "Verifying…" : "Verify & sign in"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setStep("identify");
            setChallenge(null);
            setSignature("");
            setError(null);
          }}
        >
          Back
        </Button>
      </div>
    </div>
  );
}

export function initDidSignInIsland() {
  hydrateIsland("did-signin", DidSignInIsland);
}
