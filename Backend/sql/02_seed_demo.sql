--------------------------------------------------------------------------------
-- 02_seed_demo.sql — Optional sample audit data for the observability dashboard
--------------------------------------------------------------------------------
-- Generates ~200 synthetic T_AUDIT_LOGS rows spread across the last 7 days with a
-- realistic mix of 2xx / 3xx / 4xx / 5xx status classes, varied endpoints,
-- methods, response times, users, and client IPs. This lets the Logging &
-- Observability page render meaningful charts when running against a real Oracle
-- DB (DEMO_MODE=false). Re-run safe — it only INSERTs; truncate first if you want
-- a clean set:  TRUNCATE TABLE T_AUDIT_LOGS;
--
-- Demo user/admin ACCOUNTS are seeded separately (Argon2id):  npm run db:seed:template
--------------------------------------------------------------------------------

SET DEFINE OFF;

INSERT INTO T_AUDIT_LOGS
  (REQUEST_ID, USER_ID, USERNAME, METHOD, ENDPOINT, PARAMS,
   STATUS_CODE, STATUS_CATEGORY, RESPONSE_TIME_MS, CLIENT_IP, SERVER_IP, CREATED_AT)
SELECT
  'req_' || SUBSTR(RAWTOHEX(SYS_GUID()), 1, 16)              AS REQUEST_ID,
  uid                                                        AS USER_ID,
  CASE WHEN uid = 0 THEN NULL ELSE 'demo_user' || uid END    AS USERNAME,
  mth                                                        AS METHOD,
  ep                                                         AS ENDPOINT,
  NULL                                                       AS PARAMS,
  sc                                                         AS STATUS_CODE,
  TO_CHAR(FLOOR(sc / 100)) || 'xx'                           AS STATUS_CATEGORY,
  -- 5xx responses skew slower to make the latency chart interesting
  rt + CASE WHEN sc >= 500 THEN 280 ELSE 0 END              AS RESPONSE_TIME_MS,
  '192.168.1.' || TO_CHAR(MOD(n, 254) + 1)                  AS CLIENT_IP,
  '10.0.0.10'                                                AS SERVER_IP,
  SYSTIMESTAMP - NUMTODSINTERVAL(DBMS_RANDOM.VALUE(0, 7 * 24 * 60), 'MINUTE') AS CREATED_AT
FROM (
  SELECT
    LEVEL AS n,
    CASE MOD(LEVEL, 6) WHEN 0 THEN 0 ELSE MOD(LEVEL, 6) END AS uid,
    CASE MOD(LEVEL, 4)
      WHEN 0 THEN 'GET' WHEN 1 THEN 'POST' WHEN 2 THEN 'PUT' ELSE 'DELETE'
    END AS mth,
    CASE MOD(LEVEL, 7)
      WHEN 0 THEN '/api/v1/auth/login'
      WHEN 1 THEN '/api/v1/health'
      WHEN 2 THEN '/api/v1/metrics'
      WHEN 3 THEN '/api/v1/admin-management/admins'
      WHEN 4 THEN '/api/v1/changelog'
      WHEN 5 THEN '/api/v1/clients'
      ELSE '/api/v1/audit-logs'
    END AS ep,
    CASE
      WHEN MOD(LEVEL, 100) < 80 THEN CASE MOD(LEVEL, 2) WHEN 0 THEN 200 ELSE 201 END
      WHEN MOD(LEVEL, 100) < 88 THEN CASE MOD(LEVEL, 2) WHEN 0 THEN 302 ELSE 304 END
      WHEN MOD(LEVEL, 100) < 97 THEN CASE MOD(LEVEL, 4) WHEN 0 THEN 400 WHEN 1 THEN 401 WHEN 2 THEN 403 ELSE 404 END
      ELSE CASE MOD(LEVEL, 2) WHEN 0 THEN 500 ELSE 503 END
    END AS sc,
    ROUND(DBMS_RANDOM.VALUE(8, 350)) AS rt
  FROM dual
  CONNECT BY LEVEL <= 200
);

COMMIT;

--------------------------------------------------------------------------------
-- Sanity check (uncomment to verify the status-class spread):
--   SELECT STATUS_CATEGORY, COUNT(*) FROM T_AUDIT_LOGS GROUP BY STATUS_CATEGORY ORDER BY 1;
--------------------------------------------------------------------------------
