# CATHERINE Frontend

The web client of **CATHERINE**, a generic full-stack template. It talks to the Express + Oracle API in [`../Backend`](../Backend) and ships the platform screens; project features plug in beside them.

Package: `catherine-frontend` `1.0.0-dev.46`, kept in lockstep with the backend.

## What's inside

| Area | Screens (routes) |
| --- | --- |
| **Public** | Home (`/home`), sign-in (`/auth`), logout (`/user/logout`) |
| **Reference** | Getting Started, Database Connection, Mira ORM, Money, CORS Setup, Version History, Help (`/about/*`) |
| **Signed in** | Dashboard (`/dashboard`), change password (`/auth/change-password`) |
| **System** (Super Admin) | Admin Management, Logging and Observability, Metrics, Data Integrity, Data Purge (`/system/*`) |
| **Support** | Dev Docs (Admin + Super Admin), Architecture and Runtime maps (Super Admin) (`/support/*`) |

A global Help Assistant (Ctrl+K) and a server-status banner are mounted on every page.

Roles: `SUPER_ADMIN`, `ADMIN`, `USER` (`ROLES` in `src/App.jsx`). The backend enforces every rule; the UI only hides what a role cannot use.

## Tech stack

- **React 19** (React Compiler) with **Vite**
- **Tailwind CSS v4** design tokens: 39 colour palettes in light and dark mode, with WCAG contrast computed per palette
- React Router 7, Axios (one `HttpClient` with CSRF and status-code handling), ApexCharts, ExcelJS, Mermaid, qrcode
- Vitest and Testing Library for unit, integration, security, performance, reliability and chaos tests; Playwright for browser contrast checks

## Getting started

Requirements: Node.js 24, and a running backend from [`../Backend`](../Backend).

```bash
npm install
cp .env.example .env    # points at http://localhost:2108/api/v1/ (Backend/.env.example PORT,
                        # plain http unless USE_HTTPS=true); edit if you changed PORT
npm run dev             # http://localhost:5173 (this machine only; add -- --host to test from another device)
```

Main settings in [`.env.example`](.env.example):

| Setting | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | API base URL, ending in `/api/v1/` |
| `VITE_APP_NAME` | Display name (navbar, sidebar, sign-in page, tab titles) |
| `VITE_LAYOUT_MODE`, `VITE_THEME` | Default layout (`sidebar` or top bar) and theme (`system`, `light`, `dark`) |
| `VITE_SESSION_TIMEOUT_MS`, `VITE_SESSION_WARNING_SECS` | Idle sign-out timing |
| `VITE_APP_VERSION`, `VITE_APP_STAGE` | Optional overrides; by default the version comes from `package.json` |
| `VITE_ENV` | `development` keeps the 440 / invalid-token pages from signing you out locally |
| `VITE_ALLOW_INSECURE_API` | Opt-in for a deliberate plain-HTTP production build (the build guard otherwise rejects `http://`) |

The API must list the UI's origin in its `CORS_ORIGINS`.

## Scripts

```bash
npm run dev            # dev server with hot reload
npm run build          # production build in dist/
npm run preview        # serve the production build locally
npm run lint           # ESLint
npm test               # full Vitest run
npm run test:coverage  # with coverage
npm run test:e2e       # Playwright contrast checks across palettes
```

Category runs: `test:unit`, `test:integration`, `test:security`, `test:performance`, `test:reliability`, `test:chaos`. Current baseline: 32 files / 555 tests green.

## Project layout

```
src/
  features/                auth, dashboard, home, personalize,
                           other/ (reference pages), systemadmin/, support/
  features/<area>/<feature>/
    <feature>.api.js       HTTP calls only
    <feature>.hook.js      state and business logic
    <Feature>.view.jsx     presentation
    components/            tabs, modals and shared pieces once a view grows
  components/              ui, forms, charts, layout, feedback, routing, shared
  middleware/              HttpClient, auth, CSRF
  contexts/ hooks/ constants/ utils/
  assets/styles/           Tailwind @theme tokens and the animation system
test/                      Vitest suites by category
e2e/                       Playwright specs
```

Every feature keeps the same three layers: the API file, the hook and the view. The view never calls the API directly.

## Documentation

- [`Claude.md`](Claude.md): component map, design tokens, contrast rules, feature workflow, security guidelines and the animation system
- Developer documentation is in [`../Backend/dev-docs/`](../Backend/dev-docs/), also shown on the in-app **Dev Docs** page
- Root [`docs/features/`](../docs/features/): per-feature platform docs

## License

[Apache-2.0](LICENSE)
