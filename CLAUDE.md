# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ecom OMS integrator** — an embedded Shopify admin app (order management + marketplace connectors). Built on the **Shopify App React Router template** (TypeScript). It is one of three apps in a product suite; see `docs/PROJECT_ARCHITECTURE.md` for the broader infrastructure (Hostinger domains, the shared Supabase database, the other two repos) and `docs/BUILD_RUNBOOK.md` for the end-to-end deploy/build sequence.

The repo is currently a **scaffold**: OAuth, session storage, embedded App Bridge shell, and webhook plumbing work, but the actual OMS/marketplace business logic (Supabase sync, dashboards, connectors) is not yet written. The build order for those features is `docs/BUILD_RUNBOOK.md` section 8.

## Commands

```bash
npm run dev          # shopify app dev — tunnels, injects env vars, opens an install link
npm run build        # react-router build
npm start            # serve the production build
npm run lint         # eslint
npm run typecheck    # react-router typegen && tsc --noEmit  (run after route/loader changes)
npm run deploy       # shopify app deploy — pushes shopify.app.toml config + registers webhooks
npm run setup        # prisma generate && prisma migrate deploy
npm run graphql-codegen   # regenerate Admin API types from GraphQL in app/**
```

There is no test runner configured. Verify with `npm run typecheck` and `npm run lint`.

`npm run dev` is the normal way to run — it must go through the Shopify CLI to get the API key/secret, tunnel URL, and scopes. Running Vite/react-router-serve directly will not authenticate.

## Architecture

- **`app/shopify.server.ts`** — the single source of the configured `shopifyApp` instance. Everything Shopify-related (`authenticate`, `unauthenticated`, `login`, `registerWebhooks`, `sessionStorage`) is exported from here. Import these, do not re-instantiate `shopifyApp`.
- **Routing** — file-system flat routes via `@react-router/fs-routes` (`app/routes.ts` → `flatRoutes()`). Route file naming is Remix-style flat convention: `app.tsx` is the embedded layout (auth + App Bridge `AppProvider`), `app._index.tsx` / `app.additional.tsx` are nested pages, `auth.$.tsx` is the OAuth catch-all, `webhooks.app.*.tsx` are webhook handlers.
- **Auth in loaders/actions** — every embedded route calls `await authenticate.admin(request)` and uses the returned `admin` client for GraphQL. Webhook routes call `authenticate.webhook(request)`.
- **Sessions** — stored in Prisma (`PrismaSessionStorage`). The only Prisma model is `Session`; SQLite (`prisma/dev.sqlite`) by default. `app/db.server.ts` exports a singleton client (guarded against hot-reload duplication in dev). The app's *business* data (orders, products, etc.) lives in the external Supabase Postgres, NOT in this Prisma DB — Prisma here is session storage only.
- **GraphQL codegen** — `.graphqlrc.ts` points the Admin API schema at inline queries in `app/**`; generated types land in `app/types/`. Run `graphql-codegen` after editing queries.

## Embedded-app constraints (these break the app if ignored)

- Use `Link`/`useSubmit` from `react-router` (or Polaris), never raw `<a>` or `react-router`'s `redirect` — use the `redirect` returned by `authenticate.admin`. The app runs in an iframe and loses session otherwise.
- UI uses **Polaris web components** (`<s-app-nav>`, `<s-link>`, etc.) via App Bridge, not the Polaris React component library.
- Declare webhooks in `shopify.app.toml` (`[[webhooks.subscriptions]]`) and run `npm run deploy`, rather than registering in an `afterAuth` hook. Mandatory GDPR webhooks (customers/data_request, customers/redact, shop/redact) are auto-registered by `shopify app deploy`.

## Distribution & API version (settled)

- **Distribution:** this app is **Custom distribution** (locked to one Plus org), which is `AppDistribution.SingleMerchant` in `app/shopify.server.ts` — not `AppStore` (public) or `ShopifyAdmin` (admin-created, no OAuth install flow). Keep it on `SingleMerchant` so the OAuth/login install flow stays intact.
- **Admin API version:** standardized on **`April26` / "2026-04"** across `app/shopify.server.ts` (`apiVersion` config + exported const), `.graphqlrc.ts` (codegen), and `shopify.app.toml` (`[webhooks] api_version`). Bump all three together if you change it.

## Other notes

- The runbook references scaffolding with the **Remix** template, but this repo is the **React Router** template. Follow the React Router APIs (`@shopify/shopify-app-react-router`) actually present in code.

## Secrets & environment

Never commit secrets. The app reads `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` (injected by `shopify app dev`), plus `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (service-role key is server-side only) once Supabase wiring is added. See `docs/BUILD_RUNBOOK.md` section 6.

## Tooling

The Shopify Dev MCP is configured (`.mcp.json`) — use it for Shopify API/schema questions. `extensions/` is an npm workspace for Shopify app extensions (currently empty).
