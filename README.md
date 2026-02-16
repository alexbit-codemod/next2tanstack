# Codemod Docs

Hey, if you're here it means you want to migrate from Next to TanStack. You might be thinking: why use this when you can just tell an AI agent to migrate everything? That can work too, but outputs can vary run to run. This codemod is deterministic: it does what it says, nothing less, nothing more.

Before running this codemod, create a separate git branch from your original project so you can safely roll back if needed.

I assumes you've already followed TanStack's official migration guide and installed/removed the necessary libraries: [Migrate from Next.js](https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js). It migrates the core routing and API surface, but a 1-to-1 migration isn't possible because the frameworks have different mental models.

Please don't be discouraged this codemod is designed to keep migration as smooth as possible. It adds TODOs only where manual follow-up is necessary because behavior is framework-specific and cannot be rewritten safely in a generic way.

## Default Behavior

By default, this codemod runs the full built-in migration set. You can opt out of any migration or run only a subset using `next-to-start.codemod.json`.

Default migration set:

- `next-image`
- `next-link`
- `next-server-functions`
- `manual-migration-todos`
- `next-use-client`
- `route-file-structure`
- `route-groups`
- `api-routes`

## What It Does NOT Change

- It does not fully migrate app-wide routing/runtime behavior in one shot.
- It does not automatically migrate all `next/navigation`, `next/cache`, and `next/headers` usage.
- It does not rewrite every UI pattern that uses `Link` semantics.
- It does not rewrite `next/og` (`ImageResponse`) or other framework-specific runtime APIs.
- It does not migrate styling/design-system code.

Some patterns are intentionally left for manual migration because they are context-sensitive:

- Files using `useLinkStatus` from `next/link`
- MDX component-map patterns (`useMDXComponents`, `MDXComponents`, `mdx/types`)

These are skipped to avoid generating invalid `Link` behavior.

## Manual Work You Still Need

- Review every codemod diff before applying.
- Manually migrate remaining `next/navigation` hooks/functions based on each file's runtime context.
- Manually migrate `next/cache` and `next/headers` call sites where needed.
- For skipped files (`useLinkStatus`, MDX component maps), migrate link behavior manually.
- Verify route behavior for dynamic segments, route groups, loaders, and pending/error boundaries.
- Run typecheck/tests and fix runtime-level differences (TanStack Start uses different conventions for loaders, actions, and caching).

## Notes

- Migration enable/disable behavior is controlled via `next-to-start.codemod.json` (or workflow params/env overrides where applicable).
- Confidence-first workflow:
  1. Start with a small migration set via `enabledMigrations` (or keep default full set if your codebase is small).
  2. Run in `--dry-run` and review the diff.
  3. Apply only the migrations you want, one by one if needed, and inspect each diff.
  4. Review and apply.
  5. Expand the migration set incrementally.
  6. Re-run in `--dry-run`, review diffs, then apply.

## Project Config File (Recommended)

Create `next-to-start.codemod.json` in your project root and the codemod will read it automatically.

```json
{
  "appDirectory": "app",
  "routesDirectory": "app",
  "disabledMigrations": ["next-image"]
}
```

Use this file to keep runs deterministic and avoid passing env vars every time. You can delete the file after migration if you want.

Supported config keys:

- `appDirectory`: where your Next app router entries live. Default: `"app"`.
- `routesDirectory`: where TanStack route files should be written.
- `enabledMigrations`: allow-list of migration IDs to run.
- `disabledMigrations`: deny-list of migration IDs to skip.
- `migrations`: per-ID boolean map (highest priority inside config).

## How To Run

Recommended path (most users):

1. Create `next-to-start.codemod.json` in your project root.
2. Run JSSG directly:

```sh
npx codemod jssg run ./scripts/codemod.ts --language tsx --allow-dirty -v
```

Why this is recommended:

- simpler command
- no workflow boilerplate required
- config file keeps behavior reproducible

### Workflow Run (Optional)

Use workflow mode only if you already use Codemod workflows or need to pass params from workflow orchestration.

Step 1: create a Codemod workflow file (using Codemod's official workflow format).
Step 2: add a JSSG step that runs `./scripts/codemod.ts` with language `tsx`.

Step 3: run workflow:

```sh
npx codemod workflow run --workflow ./workflow.ts --target ./ --param routesDirectory=app
```

Supported workflow params for this codemod (`options.params`):

- `routesDirectory`
- `routes_directory`

### Route Directory Resolution

When file-structure migration is enabled, route entry files are moved/renamed (`page.tsx` -> `index.tsx`, `layout.tsx` -> `_layout.tsx` or `__root.tsx`, etc.).

Resolution order for routes directory:

1. `next-to-start.codemod.json` `routesDirectory`
2. Workflow params (`options.params.routesDirectory` / `routes_directory`)
3. Env (`CODEMOD_ROUTES_DIRECTORY`, fallback `ROUTES_DIRECTORY`)
4. `vite.config.*` `tanstackStart({ router: { routesDirectory: '...' } })`
5. Default: `routes`

If your project expects routes to stay in `app` but none of the above are set, codemod defaults to `routes` and you may end up with both:

- existing `app/` support files (`_components`, `_ui`, docs, helpers)
- new `routes/` route-entry files

### Migration Toggles

Available migration IDs:

- `next-image`
- `next-link`
- `next-server-functions`
- `manual-migration-todos`
- `next-use-client`
- `route-file-structure`
- `route-groups`
- `api-routes`

Examples:

```json
{
  "enabledMigrations": ["next-link", "route-file-structure", "api-routes"]
}
```

```json
{
  "disabledMigrations": ["next-image", "manual-migration-todos"],
  "migrations": {
    "next-image": true
  }
}
```

Notes:

- `enabledMigrations` sets a baseline allow-list.
- `disabledMigrations` removes IDs from that list.
- `migrations` booleans are applied last and can force-enable/force-disable specific IDs.

## Project Description

This project is a deterministic codemod for Next.js -> TanStack migration. It is intentionally biased toward safe, incremental changes and leaves ambiguous or high-risk rewrites for manual follow-up.

source code: [Github](https://github.com/NerdBoi008/next2tanstack)

## Credits

- Official Codemod platform and team: [codemod.com](https://codemod.com/)
- Thanks to [X: @alex\_\_bit](https://x.com/alex__bit) for helping out on issues
