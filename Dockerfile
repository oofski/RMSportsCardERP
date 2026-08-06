# RM Operations — the web server.
#
# Two things about this image are load-bearing and easy to get wrong:
#
#   1. better-sqlite3 is a NATIVE module. It has to be compiled against the
#      exact Node version and architecture that will run it, which is why both
#      stages use the same base image and why the compile happens here rather
#      than shipping whatever was built on somebody's Mac.
#
#   2. The repo's `postinstall` runs `electron-builder install-app-deps`, which
#      rebuilds native modules against ELECTRON's ABI. That is correct for the
#      desktop app and fatal here — the server is plain Node and would refuse to
#      load the result. So install with --ignore-scripts and rebuild explicitly.
#
# The database does NOT live in this image. It lives on a mounted volume, and
# the server refuses to start in production if one is not mounted. See
# docs/WEB.md.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# node-gyp needs a toolchain. Only in this stage — none of it ships.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# electron is a devDependency and its ~100MB binary is downloaded by a
# postinstall script. The build needs the PACKAGE (electron-vite reads it to
# decide what to externalise); it never runs the binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile better-sqlite3 for THIS Node, on THIS architecture. If this step is
# skipped the server starts and then dies on the first query with a confusing
# "NODE_MODULE_VERSION" mismatch.
RUN npm rebuild better-sqlite3 --build-from-source

COPY . .

# The browser app, then the server that serves it.
RUN npm run build && npm run build:server

# Drop the build-only dependencies so the runtime stage copies a small tree.
# --ignore-scripts again: pruning must not re-trigger the Electron rebuild.
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV RMOPS_PORT=8080
ENV RMOPS_HOST=0.0.0.0
# The mount point. Overriding this without moving the mount is the one change
# that silently loses the database — the server checks and refuses, see
# assertDurableStorage() in src/server/index.ts.
ENV RMOPS_DATA_DIR=/data

# node_modules carries the compiled better-sqlite3 and pdfjs-dist, which stays a
# real runtime import rather than being bundled (bundled into CJS it loses the
# environment it expects and dies on a missing DOMMatrix mid-parse).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out/server ./out/server
COPY --from=build /app/out/renderer ./out/renderer
COPY --from=build /app/package.json ./package.json

# Runs as root deliberately: the volume is mounted root-owned, this is the only
# process in the VM, and an entrypoint that chowns and drops privileges is one
# more thing that can fail between a deploy and a warehouse that cannot work.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RMOPS_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "out/server/index.cjs"]
