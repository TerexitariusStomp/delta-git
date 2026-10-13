# delta-git forge sandbox — shared runtime for every platform job:
#   - CI pipeline executions (built-in `cloudflare` delegate)
#   - security scans (gitleaks / trivy / osv-scanner)
#   - SBOM generation (syft) + provenance
#   - certificate expiry probes (openssl)
#   - federation mirror pushes (ssh://, tangled knots, Radicle seeds)
#   - dev-environment workspaces (repo checkout + shell + preview)
#
# Base is the pinned `cloudflare/sandbox` image — keep this tag in lockstep
# with the `@cloudflare/sandbox` npm version so the worker-side SDK and the
# in-container control plane speak the same protocol.
FROM docker.io/cloudflare/sandbox:0.12.6

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    openssh-client openssl sshpass && \
    rm -f /etc/apt/apt.conf.d/docker-clean

# pnpm — repo workspaces and our own CI use it.
RUN npm i -g pnpm@9

# Pinned toolchain binaries. Each release tarball is verified against the
# checksum file published alongside it — no blind installs.
ARG GITLEAKS_VERSION=8.30.1
ARG TRIVY_VERSION=0.74.0
ARG SYFT_VERSION=1.38.0
ARG OSV_SCANNER_VERSION=2.2.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    \
    tmp="$(mktemp -d)"; cd "$tmp"; \
    \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    grep "linux_${arch}.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" | sha256sum -c -; \
    tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz" gitleaks; \
    mv gitleaks /usr/local/bin/; \
    \
    curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt"; \
    grep "Linux-${arch}.tar.gz" "trivy_${TRIVY_VERSION}_checksums.txt" | sha256sum -c -; \
    tar -xzf "trivy_${TRIVY_VERSION}_Linux-${arch}.tar.gz" trivy; \
    mv trivy /usr/local/bin/; \
    \
    curl -fsSLO "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_checksums.txt"; \
    grep "linux_${arch}.tar.gz" "syft_${SYFT_VERSION}_checksums.txt" | sha256sum -c -; \
    tar -xzf "syft_${SYFT_VERSION}_linux_${arch}.tar.gz" syft; \
    mv syft /usr/local/bin/; \
    \
    osv_arch="$( [ "$arch" = "amd64" ] && echo amd64 || echo arm64 )"; \
    curl -fsSLO "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${osv_arch}.zip"; \
    curl -fsSLO "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_SHA256SUMS"; \
    grep "osv-scanner_linux_${osv_arch}" osv-scanner_SHA256SUMS | sha256sum -c -; \
    unzip -o "osv-scanner_linux_${osv_arch}.zip" -d /usr/local/bin; \
    cd / && rm -rf "$tmp"; \
    \
    gitleaks version && trivy --version && syft --version && osv-scanner --version

# Radicle CLI for `rad` mirror pushes — official install script, version-pinned
# via the `RADICLE_VERSION` env it reads.
ARG RADICLE_VERSION=1.1.0
RUN curl -fsSL https://radicle.xyz/install | bash -s -- --yes --prefix=/usr/local && rad --version

# Playwright + Chromium pre-baked so CI E2E jobs don't pay the browser
# download on every run. Version tracks @playwright/test in the workspace.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm i -g playwright-core@1.55.0 && \
    npx -y playwright-core@1.55.0 install chromium --with-deps && \
    rm -rf /root/.npm

WORKDIR /workspace
