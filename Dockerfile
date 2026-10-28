# syntax=docker/dockerfile:1
#
# Two images, two roles:
#   client  the container-side helper and CLI, for an embedding image to COPY from
#   host    the broker, with gh, for running `gcb daemon`
#
# Local build:
#   docker build --target client -t code-vaults/gcb-client:dev .
#   docker build --target host   -t code-vaults/gcb-host:dev .

FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.json tsconfig.build.base.json tsconfig.build.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN corepack yarn install --immutable \
 && corepack yarn build \
 && mkdir -p /packs \
 && npm pack ./packages/cli ./packages/client ./packages/host --pack-destination /packs

FROM node:24-slim AS client
COPY --from=build /packs /packs
RUN npm install -g --omit=dev /packs/gcb-cli-*.tgz /packs/gcb-client-*.tgz \
 && rm -rf /packs /usr/local/lib/node_modules/gcb-*/lib/*.map /root/.npm /tmp/* \
 && npm cache clean --force
ENTRYPOINT ["gcb"]

# The broker runs gh itself, against the App's token; this must not rely on a host gh install.
FROM node:24-slim AS host-base
ARG APT_MIRROR=mirrors.aliyun.com
RUN --mount=type=cache,id=apt_cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt_lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
 && for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      if [ -f "$f" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$f"; fi; \
    done \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && gh --version

FROM host-base AS host
COPY --from=build /packs /packs
RUN npm install -g --omit=dev /packs/gcb-cli-*.tgz /packs/gcb-host-*.tgz \
 && rm -rf /packs /usr/local/lib/node_modules/gcb-*/lib/*.map /root/.npm /tmp/* \
 && npm cache clean --force
ENTRYPOINT ["gcb", "daemon"]
