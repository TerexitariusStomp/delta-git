# vendored from Rooted — apps/socials-vite/src/lib/security/secrets-broker.ts

Same author (widespread, AGPL-3.0 in-house). Pure-logic secrets broker:
sealed write-only handles, durable grants, echo/planted canaries, egress
redaction, hash-chained audit. Verbatim copy; the key-custody worker
(`../key-custody.worker.ts`) instantiates it and resolves handles.

Update: re-copy from upstream; only npm deps are @noble/hashes + @noble/ciphers.
