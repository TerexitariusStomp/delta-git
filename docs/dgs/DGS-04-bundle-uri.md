# DGS-04: Clone Bundles (`bundle-uri`)

**Status:** implemented · **License:** public domain (CC0-1.0)
**Implements:** protocol-v2 `bundle-uri` capability (git ≥ 2.44)

## Purpose

Clone acceleration: the client learns a precomputed bundle URL during the
v2 capability exchange, downloads it over plain GET, then negotiates only
objects newer than the bundle. On edge infra this offloads the expensive
full-clone pack walk to a cacheable artifact.

## Capability

The upload-pack advertisement lists `bundle-uri`. Clients opt in with
`clone.bundleURI=true` or `git clone --bundle-uri`.

## Command

```
POST /{owner}/{repo}/git-upload-pack
command=bundle-uri

→ pkt-lines:
bundle.version=3
bundle.mode=all
bundle.baseline.uri=https://{host}/{owner}/{repo}.git/bundle/{token}
bundle.baseline.creationToken={token}
bundle.baseline.location=https://{host}/{owner}/{repo}.git/bundle/{token}
```

`creationToken` is the HEAD oid — it changes exactly when the baseline
goes stale. An empty repo returns an empty bundle list (client falls back
to normal fetch).

## Download

```
GET /{owner}/{repo}.git/bundle/{token}
→ 200 application/x-git-bundle: GIT BUNDLE V3 + ref list + PACK
```

Stale tokens still serve a correct _current_ bundle — the client treats it
as a baseline and negotiates the delta, so drift is never an error.

## Auth

Identical gate to upload-pack: public repos serve anonymously, private
repos require the same PAT/OAuth credentials as a clone. Bundle URLs never
disclose private-repo existence (404/401 indistinguishable).
