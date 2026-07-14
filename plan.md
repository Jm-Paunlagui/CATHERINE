# Plan: CATHERINE Backend Backport — Resilience + Email + Audit Fallback

## TL;DR
Backport MEAL's resilience infrastructure (RetryPolicy, BatchGuard, EmailProtectionService, SharedTransporter) to the CATHERINE template as centralized, dynamic, MEAL-free utilities. Add a text-file fallback for audit logging when T_AUDIT_LOGS_DEV is unavailable, controlled by `AUDIT_LOG_STORAGE=db|file|auto` env var.

---

## Phase 1: Resilience Utilities (no dependencies, can start immediately)

### Step 1.1 — Create `src/utils/resilience/` directory
- Copy `RetryPolicy.js` from MEAL → CATHERINE
- Copy `BatchGuard.js` from MEAL → CATHERINE
- Copy `index.js` barrel from MEAL → CATHERINE
- **Cleanup**: Remove MEAL-specific JSDoc references (e.g. "subsidy / RFID" in comments). Keep all ORA/NJS/SMTP classification tables — they're generic Oracle + nodemailer patterns.
- `concurrency.js` already identical — no action needed.

### Step 1.2 — Create `src/constants/messages/resilience.messages.js`
- Copy from MEAL, strip any MEAL-specific message templates
- Keep: ATTEMPT_START, ATTEMPT_OK, ATTEMPT_FAIL, BACKOFF, IDEMPOTENT_RESOLVE, RETRYING, RETRY_EXHAUSTED, BATCH_START, BATCH_DONE, BATCH_ABORTED, PHASE, EMAIL_ATTEMPT_OK, EMAIL_DELIVERY_SUMMARY, EMAIL_RETRYING, EMAIL_FALLBACK, EMAIL_FAILED, EMAIL_BUDGET_EXHAUSTED
- Register in `src/constants/messages/index.js` barrel

---

## Phase 2: Email Infrastructure (*depends on Phase 1*)

### Step 2.1 — Create `src/services/email/` directory
- Create `SharedTransporter.js` from MEAL version
  - **Change**: `noreply@meal.internal` → `noreply@app.internal` (or env-only, no hardcoded fallback domain)
- Create `EmailProtectionService.js` from MEAL version
  - Already generic — two-tier (primary + fallback) with configurable `buildMailOptions` and `resolveRecipients`
  - Remove MEAL-specific JSDoc examples (QR stub, billing references)
  - Keep the full architecture: RetryPolicy integration, STATUS constants, extractSmtpErrorCode, effectiveCap

### Step 2.2 — Update `.env.example`
- Add under SMTP section:
  - `EMAIL_RETRY_ATTEMPTS=3`
  - `EMAIL_FALLBACK_RETRY_ATTEMPTS=3`
  - `EMAIL_RETRY_BASE_DELAY_MS=500`

---

## Phase 3: Audit Log Text-File Fallback (*parallel with Phase 2*)

### Step 3.1 — Create `src/models/audit.log.file.model.js`
- New model that writes audit records as JSON lines to `logs/Main/YYYY/MM/DD/audit.log`
- Uses the same logger.js file-writing pattern (ensureDirectoryExists, write queue)
- Methods mirror AuditLogModel: `insert(record)`, `insertBatch(records)`
- Read methods (findPaginated, aggregate, etc.) return empty/stub results with a note that file-based storage doesn't support queries
- File rotation at 50MB (same as logger.js pattern)

### Step 3.2 — Update `src/models/audit.log.model.js`
- Add storage mode detection based on `AUDIT_LOG_STORAGE` env var:
  - `db` — always use Oracle (current behavior, throws if table missing)
  - `file` — always use text file fallback
  - `auto` — try Oracle on first write; if ORA error (ORA-00942 table not found, or connection error), permanently switch to file for process lifetime
- Internal `_storageMode` state: `"db"` | `"file"` | `"auto-pending"` | `"auto-file"`
- On auto-mode switch: silent (per user preference — no warning logged)
- Delegate to `AuditLogFileModel` when in file mode

### Step 3.3 — Create `logs/Main/.gitkeep`
- Ensure the Main directory exists in the repo structure
- Add `logs/Main/` to `.gitignore` (keep .gitkeep, ignore log files)

### Step 3.4 — Update `.env.example`
- Add: `AUDIT_LOG_STORAGE=auto` with comment explaining db|file|auto modes

---

## Phase 4: Wiring & Integration (*depends on Phases 1-3*)

### Step 4.1 — No middleware changes needed
- AuditLogMiddleware already calls `AuditLogService.insertAsync()` which calls the model
- The model-level fallback is transparent to the middleware and service layers

### Step 4.2 — Update `server.js` graceful shutdown
- `AuditLogService.flushPending()` already called — works for both DB and file modes
- No changes needed if the model handles flushing to file internally

---

## Relevant Files

### New files to create:
- `D:\Web\CATHERINE\Backend\src\utils\resilience\RetryPolicy.js` — from MEAL, cleaned
- `D:\Web\CATHERINE\Backend\src\utils\resilience\BatchGuard.js` — from MEAL, cleaned
- `D:\Web\CATHERINE\Backend\src\utils\resilience\index.js` — barrel export
- `D:\Web\CATHERINE\Backend\src\services\email\SharedTransporter.js` — from MEAL, domain-neutral
- `D:\Web\CATHERINE\Backend\src\services\email\EmailProtectionService.js` — from MEAL, cleaned
- `D:\Web\CATHERINE\Backend\src\models\audit.log.file.model.js` — new text-file audit model
- `D:\Web\CATHERINE\Backend\src\constants\messages\resilience.messages.js` — from MEAL, stripped
- `D:\Web\CATHERINE\Backend\logs\Main\.gitkeep` — directory placeholder

### Files to modify:
- `D:\Web\CATHERINE\Backend\src\constants\messages\index.js` — add `resilience.messages` to barrel
- `D:\Web\CATHERINE\Backend\src\models\audit.log.model.js` — add storage mode routing (db/file/auto)
- `D:\Web\CATHERINE\Backend\.env.example` — add EMAIL_RETRY_*, AUDIT_LOG_STORAGE vars
- `D:\Web\CATHERINE\Backend\.gitignore` — add `logs/Main/` pattern (if not already covered)

### Files verified unchanged (no action):
- `D:\Web\CATHERINE\Backend\src\utils\concurrency.js` — already identical to MEAL

---

## Verification

1. **Unit test RetryPolicy** — run existing MEAL test patterns against CATHERINE's copy (classification tables, backoff formula, exhaustion behavior)
2. **Unit test BatchGuard** — verify succeeded/failed/pending segregation, FATAL_SESSION abort
3. **Unit test AuditLogModel storage routing**:
   - `AUDIT_LOG_STORAGE=db` → calls Oracle model methods
   - `AUDIT_LOG_STORAGE=file` → calls file model methods
   - `AUDIT_LOG_STORAGE=auto` → first call tries Oracle, simulated ORA-00942 → switches to file permanently
4. **Unit test AuditLogFileModel**:
   - Verify JSON lines format (one JSON object per line)
   - Verify directory structure: `logs/Main/YYYY/MM/DD/audit.log`
   - Verify file rotation at 50MB
5. **Integration test** — start server with `AUDIT_LOG_STORAGE=auto` and no T_AUDIT_LOGS_DEV table → confirm audit records appear in `logs/Main/YYYY/MM/DD/audit.log`
6. **Manual verification** — check that no MEAL-specific strings remain in any backported file (grep for "meal", "MEAL", "qr", "subsidy", "rfid", "billing", "consumption", "kiosk")
7. **Smoke test EmailProtectionService** — mock SMTP, verify DELIVERED/FALLBACK/FAILED status paths

---

## Decisions
- **Fallback is silent** — no warning logged when switching from DB to file in auto mode
- **JSON lines format** — one JSON object per line in audit fallback files, same fields as DB record
- **Permanent switch** — in auto mode, once DB fails, file mode persists for process lifetime (restart to retry DB)
- **Two-tier email** — EmailProtectionService keeps primary + fallback architecture, fully configurable by caller
- **No MEAL code** — all backported files stripped of MEAL domain references (QR, billing, subsidy, RFID, consumption, menu, kiosk)
- **concurrency.js** — verified identical, no changes needed
