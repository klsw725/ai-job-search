# The repo is not copied in; compose.yaml bind-mounts it at /workspace.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256_AARCH64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee
ARG TYPST_SHA256_X86_64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
# On Linux, build with your own ids so the bind-mounted repo stays writable:
#   APP_UID=$(id -u) APP_GID=$(id -g) docker compose build
ARG APP_UID=1000
ARG APP_GID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils tini \
      python3 python3-venv \
      poppler-utils ripgrep \
      fonts-noto-cjk fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

RUN case "$(uname -m)" in \
      x86_64) target=x86_64-unknown-linux-musl; sum="$TYPST_SHA256_X86_64" ;; \
      aarch64) target=aarch64-unknown-linux-musl; sum="$TYPST_SHA256_AARCH64" ;; \
      *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${target}.tar.xz" \
 && echo "${sum}  /tmp/typst.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/typst.tar.xz -C /tmp \
 && install -m 0755 "/tmp/typst-${target}/typst" /usr/local/bin/typst \
 && rm -rf /tmp/typst.tar.xz "/tmp/typst-${target}"

# Python tools (verify_pdf.py, lint, salary) run as `python3`; the venv comes
# first on PATH so that name resolves to an interpreter with pypdf installed.
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir pypdf==7.0.0 PyYAML==6.0.3 openpyxl==3.1.5 et_xmlfile==2.0.0
ENV PATH="/opt/py/bin:${PATH}"

RUN git config --system --add safe.directory /workspace

RUN groupmod -o -g "$APP_GID" bun && usermod -o -u "$APP_UID" -g "$APP_GID" bun

WORKDIR /opt/web
COPY web/package.json web/bun.lock ./
RUN bun install --ignore-scripts --frozen-lockfile --production
COPY web/src ./src
COPY web/tsconfig.json ./
COPY --chmod=0755 web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /home/bun/.claude && chown -R bun:bun /home/bun /opt/web

ENV NODE_ENV=production \
    HOME=/home/bun \
    REPO_DIR=/workspace \
    HOST=0.0.0.0 \
    PORT=3000 \
    CLAUDE_CONFIG_DIR=/home/bun/.claude

EXPOSE 3000
ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/server/server.ts"]
