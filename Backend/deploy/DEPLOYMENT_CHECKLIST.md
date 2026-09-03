# CATHERINE — Deployment Checklist

**One page. Run top to bottom. Every line is a thing you can see the answer to.**

Companion to `DEPLOYMENT_RUNBOOK.md` (how to deploy) — this is *did the deploy
land correctly*. CATHERINE is a template; each item below is a template-level
guarantee. Add your own domain checks (schema, jobs, functional smoke) when you
build a product on top of it.

---

## A. Before you deploy

- [ ] **A1 — `.env` is present on the host and is the production one.**
      The backend reads `.env` and only `.env`. `server.js` and
      `src/config/database.js` both hardcode that name — nothing loads
      `.env.production`, which is a *reference copy* you deploy **as** `.env`.
      (Vite auto-loads `.env.production` for the frontend; Node does not. Same
      filename, different rule.) For a `pkg` build the file must sit **next to
      the .exe**, not in the working directory — a Windows service can start with
      cwd anywhere.

- [ ] **A2 — `NODE_ENV=production` in that `.env`.**
      ⚠ This gates more than error formatting. `src/config/bootGuard.js` runs its
      fail-closed suite most strictly when `NODE_ENV === "production"`; anything
      else downgrades placeholder secrets, `DEMO_MODE=true`, and a missing
      `CORS_ORIGINS` to warnings the process starts through. It also switches
      `ErrorHandlerMiddleware` to generic messages — without it, 500 responses
      can carry stack traces to the client (CWE-209).
      **The boot guard cannot protect you from the one setting that disables it.**

- [ ] **A3 — `DEMO_MODE=false`.** Demo mode serves everything from in-memory
      fixtures and opens no Oracle pool. A production deploy left in demo mode
      looks perfectly healthy while persisting nothing.

- [ ] **A4 — `PASSWORD_HASH_MODE` is the value you intend.**
      Do **not** change it as part of a deploy: it invalidates every stored
      credential and locks out every admin. If it needs to change, that is its
      own migration.

- [ ] **A5 — `npm audit --omit=dev` is clean**, or every remaining line appears
      in `audit-suppressions.md` with a reachability analysis.

- [ ] **A6 — (money only) base-currency config is intentional.** If you set
      `MONEY_BASE_CURRENCY`, confirm it is the code you mean and that
      `MONEY_BASE_CURRENCY_MIGRATION` is **unset/false** unless you are
      deliberately opening a new currency epoch. The boot-guard fails the start
      on an accidental in-place base change once ledger tables exist.

---

## B. After the process starts

- [ ] **B1 — the boot guard did not exit.** The process is listening, and no
      `process.exit(1)` violation lines appear in the log. In particular, no
      "money" violation (`MONEY_BASE_CURRENCY … not a registered ISO 4217 code`
      or `MONEY_BASE_CURRENCY changed in place …`).

- [ ] **B2 — the native preflight passed.** Look for
      "Native-module preflight: argon2 loaded successfully". A missing native
      addon here means the PKG dist was staged from a failed build.

- [ ] **B3 — security headers survive the reverse proxy.**

      ```bash
      curl -sI https://<host>/api/v1/health | grep -iE \
        "x-frame|x-content-type|strict-transport|referrer|permissions|content-security"
      ```

      The test suite asserts these against the Express app directly; only this
      check sees what a proxy in front of Node actually forwards.

- [ ] **B4 — an error response carries no stack trace.** Hit any 404 under
      `/api/v1/` and confirm the body is the generic
      `{ status, code, message, error }` shape. This is the observable proof that
      A2 took effect.

- [ ] **B5 — (money only) the read fence is active.** If you serve scaled
      `NUMBER` columns (money at scale 4, rates at scale 8), confirm amounts come
      back as strings, not rounded doubles. The driver `fetchTypeHandler`
      (`moneySafeFetchTypeHandler`) turns any `scale > 0` NUMBER into a STRING —
      a value arriving as a JS number is the defect to catch.

---

## C. Frontend smoke

- [ ] **C1 — the app loads over HTTPS and the API is reachable.** A blank app
      that "loads then fails whole" is the `VITE_API_BASE_URL` fallback pointing
      at the client's own machine — the production build guard should have caught
      this, but verify.
- [ ] **C2 — log in.** Exercises JWT + CSRF end to end.
- [ ] **C3 — the session-warning modal timing matches the token.**
      `VITE_SESSION_TIMEOUT_MS` must equal the backend `JWT_EXPIRES_IN`.
- [ ] **C4 — `/about/money` renders** (the money capability reference page), and
      any money figures display as `₱1,500.50`-style strings, never `$NaN`/`$∞`.

---

## D. Rollback triggers

Stop and roll back if any of these are true:

| Signal | Meaning |
| --- | --- |
| Boot guard exits with a violation | A required secret / config is missing or invalid |
| 500s carry stack traces | `NODE_ENV` is not `production` |
| App loads then fails every call | `VITE_API_BASE_URL` wrong (points at the client) |
| Money value arrives as a rounded number | The `fetchTypeHandler` read fence is not active |
| `MONEY_BASE_CURRENCY changed in place` at boot | An unintended base-currency change |

---

## Not covered here

CI/CD (deliberately not built — owner decision) and SBOM generation (no pipeline
to produce one; a manually-maintained SBOM that goes stale is worse than none).
Business-domain schema, scheduled jobs, and functional smoke are the copier's to
add when a product is built on the template.
