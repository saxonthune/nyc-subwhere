# Scaffold the nyc-subwhere monorepo

## Motivation

The project is docs-only so far. Establish the pnpm-workspace monorepo the architecture docs
describe (doc02.01, doc02.03, doc02.04): a `@nyc-subwhere/contract` shared-types spine imported
by a Vite/MapLibre/Three front-end (`@nyc-subwhere/web`) and a unified Cloudflare Worker
(`@nyc-subwhere/worker`) that serves the static assets and an `/api` route. This task lays down
files and folders only — a coherent, well-formed tree — not a running or installed app.

## Do NOT

- Do NOT run `pnpm install`, generate a lockfile, or create `node_modules`. Files and folders
  only. No network installs.
- Do NOT invent the full renderer contract vocabulary. `RenderSnapshot` is a **placeholder**
  with a comment pointing to doc01.01 (glossary) and doc02.04 (backend contract) — naming the
  real shape is the human's call, not the agent's (see doc01.02 development ethos).
- Do NOT add React, SolidJS, a router, Turborepo, or Nx. pnpm workspaces + vanilla TS only.
- Do NOT scaffold an about page/second HTML entry — that choice is still open (doc02.03).
- Do NOT touch `.rhidoc/`, `LICENSE`, or `.todo-tasks/`. Leave `README.md` as-is.
- Do NOT use bare package names — every package is scoped `@nyc-subwhere/*`.
- Do NOT leave any Cargo/Rust content in `.gitignore`.

## Plan

### 1. Root workspace files

- `package.json` — private root. `"packageManager": "pnpm@10.28.1"`, `"type": "module"`,
  `"private": true`, a `"name": "nyc-subwhere"`, and placeholder scripts (`"format"`,
  `"lint"`, `"typecheck"`, `"build"`) that fan out over the workspace (e.g.
  `pnpm -r run build`, `biome check .`). No dependencies installed — just declared devDeps for
  `@biomejs/biome` and `typescript` at their current stable ranges.
- `pnpm-workspace.yaml` — `packages: ["packages/*"]`.
- `biome.json` — current Biome schema; enable formatter and linter with sensible defaults
  (2-space indent, recommended lint rules). Strict JSON (no comments — it is parsed by the
  verification gate).
- `tsconfig.base.json` — strict mode on, `"target": "ES2022"`, `"module": "ESNext"`,
  `"moduleResolution": "bundler"`, `"strict": true`, `"noEmit": true`, `"skipLibCheck": true`.
  Package tsconfigs extend this.

### 2. Replace `.gitignore` with GitHub's canonical Node template

Overwrite the current Rust `.gitignore` using GitHub's official Node template rather than
hand-writing one:

```bash
gh api gitignore/templates/Node --jq '.source' > .gitignore
```

Then append a short project-specific block the base template lacks (Cloudflare + build output):

```
# Cloudflare Wrangler
.wrangler/
# Build output
dist/
```

If `gh` is unavailable or unauthenticated at run time, fall back to hand-writing a standard
Node `.gitignore` (`node_modules/`, `dist/`, `.wrangler/`, `*.log`, `.env`, `.env.*`,
`coverage/`, `.DS_Store`). Either way: no Cargo/Rust lines remain.

### 3. `packages/contract` — the shared spine

- `package.json` — `"name": "@nyc-subwhere/contract"`, `"type": "module"`,
  `"exports"`/`"main"`/`"types"` pointing at `src/index.ts`. No build step needed (consumed as
  TS source via the workspace).
- `tsconfig.json` — extends `../../tsconfig.base.json`.
- `src/index.ts` — a **placeholder** `export interface RenderSnapshot {}` (empty body) with a
  comment: the real shape is defined with the front-end; see doc01.01 and doc02.04. Optionally a
  `// TODO`-free note — state it as present-tense intent, not a deferral.

### 4. `packages/web` — Vite + MapLibre + Three front-end

- `package.json` — `"name": "@nyc-subwhere/web"`, `"type": "module"`. Dependencies:
  `maplibre-gl`, `three`, and `"@nyc-subwhere/contract": "workspace:*"`. devDeps: `vite`,
  `typescript`, `@types/three`. Scripts: `dev` (`vite`), `build` (`vite build`), `typecheck`
  (`tsc --noEmit`).
- `tsconfig.json` — extends base; include `src`.
- `vite.config.ts` — minimal Vite config (defineConfig, empty-ish).
- `index.html` — a full-viewport container element (`#map`) on a black background (inline CSS or
  a linked `src/style.css`), `<script type="module" src="/src/main.ts">`.
- `src/main.ts` — a **stub** that imports `maplibre-gl` and gets a reference to `#map`,
  with a comment marking where the MapLibre map + Three custom layer are initialized. It does not
  need to run or render (no install this task), but it must be plausible, type-correct source.
- `src/style.css` — black background, full-viewport `#map`.

### 5. `packages/worker` — unified Cloudflare Worker

- `package.json` — `"name": "@nyc-subwhere/worker"`, `"type": "module"`. devDeps: `wrangler`,
  `typescript`, `@cloudflare/workers-types`. Scripts: `dev` (`wrangler dev`), `deploy`
  (`wrangler deploy`), `typecheck` (`tsc --noEmit`).
- `wrangler.toml` — `name = "nyc-subwhere"`, `main = "src/index.ts"`, a recent
  `compatibility_date` (e.g. `2025-06-01`), and a Workers Static Assets block binding the
  built front-end: `[assets]` with `directory = "../web/dist"` and `binding = "ASSETS"`, so one
  Worker serves both the site and `/api` (see doc02.01, doc02.04). Add a short comment that
  `../web/dist` is produced by `@nyc-subwhere/web`'s build.
- `tsconfig.json` — extends base; `"types": ["@cloudflare/workers-types"]`.
- `src/index.ts` — a `fetch` handler stub: requests to `/api/health` return
  `Response.json({ ok: true })`; everything else delegates to `env.ASSETS.fetch(request)`. Type
  the `Env` with an `ASSETS: Fetcher` binding. A comment marks where the read-through cache
  logic (doc02.04) lands later.

## Files to Modify

- `package.json` — create (root workspace)
- `pnpm-workspace.yaml` — create
- `biome.json` — create
- `tsconfig.base.json` — create
- `.gitignore` — overwrite (Rust → Node)
- `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/src/index.ts` — create
- `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.ts`, `packages/web/src/style.css` — create
- `packages/worker/package.json`, `packages/worker/tsconfig.json`, `packages/worker/wrangler.toml`, `packages/worker/src/index.ts` — create

## Verification

```bash
set -e
# Root files present and well-formed
test -f package.json
test -f pnpm-workspace.yaml
test -f biome.json
test -f tsconfig.base.json
node -e "require('./package.json')"
node -e "require('./biome.json')"
# gitignore is Node, not Rust
grep -q "node_modules" .gitignore
grep -q "\.wrangler" .gitignore
! grep -qi "cargo" .gitignore
# Three scoped packages, each with a parseable package.json
for p in contract web worker; do
  test -f "packages/$p/package.json"
  test -f "packages/$p/tsconfig.json"
  node -e "const n=require('./packages/$p/package.json').name; if(n!=='@nyc-subwhere/$p'){throw new Error('bad name: '+n)}"
done
# Contract spine
test -f packages/contract/src/index.ts
grep -q "RenderSnapshot" packages/contract/src/index.ts
# Web entry points
test -f packages/web/vite.config.ts
test -f packages/web/index.html
test -f packages/web/src/main.ts
grep -q "workspace:\*" packages/web/package.json
# Worker unified: assets binding + api route
test -f packages/worker/wrangler.toml
test -f packages/worker/src/index.ts
grep -q "ASSETS" packages/worker/wrangler.toml
grep -q "/api/health" packages/worker/src/index.ts
echo "scaffold OK"
```

## Out of Scope

- `pnpm install`, lockfile, actually building or running anything.
- The real `RenderSnapshot` shape and the read-through cache logic (doc02.04).
- The about page / second HTML entry (doc02.03).
- CI, deploy pipelines, Protomaps/basemap source selection.

## Notes

- Toolchain confirmed present: Node 22, pnpm 10.28.1, wrangler 4.92 — but this task installs
  nothing; it only writes files whose declared versions target those tools.
- The `@nyc-subwhere/contract` package is the "one contract surface" from doc01.02 — both web and
  worker depend on it via `workspace:*`. Keep its export a placeholder so the human prices the
  real vocabulary.
