---
name: catherine-frontend-conventions
description: Non-obvious frontend rules for CATHERINE (three-layer feature, billing hook pattern, component tiers, design tokens)
metadata:
  type: reference
---

CATHERINE frontend hard rules (full detail in `Frontend/Claude.md`):

- **Three-layer feature architecture:** `<feature>.api.js` (HTTP only, via `httpClient` — never raw Axios), `<feature>.hook.js` (state/logic/toasts), `<Feature>.view.jsx` (pure render, never imports the api file).
- **Billing hook pattern (mandatory):** call the hook in ONE line with NO destructuring at view level; pass the whole object as `hook={hook}` to first-level sub-components. Never build prop bundles. Cascade `hook=` only one level deep — wizard children (StepVerify/StepComplete) get individual props.
- **Three-tier component sharing (rule of three):** tier 1 `features/<f>/components/` (one feature), tier 2 `features/<f>/shared/` (2+ components same feature), tier 3 `src/components/shared/` (2+ features, identical flow). Canonical tier-3 = `ExcelUploadStepper/` (`ExcelStepDropzone`, `makeUploadSteps`, `sortAndIndexRows`, `rowTintClass`, `ExcludeRestoreButton`) — never re-implement per feature.
- **Component-first:** never raw `<input>`/HTML when an Aumovio component exists (`Input`, `Select`, `Toggle`, `Table`, `Modal`, etc. — full map in §1 of Frontend/Claude.md).
- **Design tokens (60/30/10):** primary orange-400 `#FF4208`, secondary purple-400 `#4827AF`, semantic success/danger/warn/blue. Dark mode via `data-theme="dark"` + `dark:` prefix; every light class needs a dark counterpart (`dark:bg-[#1a1030]`).
- **Contrast-safe accent tokens:** on a surface, don't use raw `text-orange-400`; use `text-(--accent-icon)` (icons, ≥3:1) / `text-(--accent-foreground)` (text, ≥4.5:1), computed per palette by `applyPaletteVars()`. Accent *backgrounds/borders* stay raw. Semantic colours never shift with palette.
- **Animations:** named constants/classes from `src/assets/styles/pre-set-styles.jsx` + `index.css`. Never hardcode `transition: all 300ms` or raw cubic-bezier. `animate-fade-in-*` already set `opacity:0` — don't add `opacity-0`. `ANIMATE_SHAKE` for invalid submit + reset on `onAnimationEnd`. `staggerDelay(i)` for lists.
- **Security:** JWT in HTTP-only cookies only (never localStorage/state); `HttpClient` auto-injects `x-csrf-token` on mutations; no `dangerouslySetInnerHTML` w/o DOMPurify; validate `href` to `^(https?:\/\/|\/)`; `cancelled` flag in async `useEffect`.
- **Data fetching:** `useRequest` (module-scope dedupe + staleTime) preferred; raw `useEffect` fetchers need `initFiredRef` guard (React 19 Strict Mode double-fire). No Redux/Zustand. Lazy-load views only. Wrap views in `ErrorBoundary`.
- **Naming:** `PascalCase.view.jsx`, `camelCase.hook.js`, `camelCase.api.js`, SCREAMING_SNAKE CSS constants. Roles in `App.jsx` `ROLES`; `ProtectedRoute role={[...]} check={fn}`.

See [[catherine-template-overview]], [[catherine-backend-conventions]].
