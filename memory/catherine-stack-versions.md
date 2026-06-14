---
name: catherine-stack-versions
description: Key dependency versions and build toolchain for the CATHERINE template
metadata:
  type: reference
---

CATHERINE template stack (verify in package.json before relying on a specific minor):

**Backend** (`Backend/package.json`, CommonJS, `main: server.js`):
- express ^5.2.1, oracledb ^6.10.0 (Thick mode), node-cache ^5.1.2 (rate-limit + cache stores), csrf-csrf ^4.0.3, helmet ^8.1.0, jsonwebtoken ^9, nanoid ^5 (ESM — needs `nanoidLoader.js` for PKG).
- Password hashing: both argon2 ^0.44 and bcryptjs ^3 present; `PASSWORD_HASH_MODE` env (`bcrypt` prod, `plain` dev only).
- Excel/PDF: exceljs, pdfkit, archiver. Email: nodemailer.
- Tests: mocha ^11 + chai ^6 + sinon ^21 + supertest ^7. Suites under `test/server/**` split unit/integration/security/performance/reliability/chaos.
- Build: **pkg** → standalone Windows `.exe`, target `node18-win-x64`, `npm run build` → `dist/`.

**Frontend** (`Frontend/package.json`, ESM, Vite):
- react ^19.2, react-dom ^19.2, **vite ^8**, tailwindcss ^4.2 (`@tailwindcss/vite`).
- **React Compiler is enabled** — `babel-plugin-react-compiler` ^1 via `@rolldown/plugin-babel`.
- Routing react-router ^7. Charts: apexcharts ^5 + react-apexcharts. Icons: FontAwesome ^7 + Heroicons + react-icons. Upload: react-dropzone ^15 + exceljs. JWT: jose ^6, js-cookie.

See [[catherine-template-overview]].
