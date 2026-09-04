-- ============================================================================
--  03_alter_admins_notification_columns.sql
--  Additive migration for T_ADMINS_DEV — brings a pre-existing table up to the
--  column set declared in 01_schema.sql WITHOUT dropping it.
-- ============================================================================
--
--  WHEN YOU NEED THIS
--  ------------------
--  Only if your T_ADMINS_DEV was created before EMAIL and the four
--  CAN_RECEIVE_SRV_* opt-in flags were added to 01_schema.sql. The symptom is a
--  login failure with the admin lookup rejected at parse time:
--
--      ORA-00904: "CAN_RECEIVE_SRV_SYS": invalid identifier
--
--  Oracle reports only the FIRST invalid identifier it meets, so that single
--  error can hide several missing columns — here it hid five. Adding just the
--  named one produces the next ORA-00904 on the following request.
--
--  A fresh install does NOT need this file: 01_schema.sql already creates every
--  column below. Running it anyway is harmless (see IDEMPOTENT).
--
--  WHY NOT JUST RE-RUN 01_schema.sql
--  ---------------------------------
--  That script DROPs and recreates its tables, which destroys existing admin
--  accounts, audit history, and alert state. This migration only ADDs.
--
--  IDEMPOTENT
--  ----------
--  Every step checks USER_TAB_COLUMNS / USER_CONSTRAINTS first, so the script
--  is safe to run repeatedly and safe to run against an already-current table.
--
--  SIGNATURE SAFETY
--  ----------------
--  T_ADMINS_DEV.SYSSIGNATURE is an HMAC over { USERNAME, PASSWORD, ROLE,
--  IS_ACTIVE } only (see AdminModel's canonical signed-field set). None of the
--  columns added here are part of that projection, so existing signatures stay
--  valid and no row will read as TAMPERED after this migration. Do NOT widen
--  the signed set without re-signing every row.
--
--  HOW TO RUN
--  ----------
--    sqlplus  <user>/<password>@<host>:<port>/<service>  @03_alter_admins_notification_columns.sql
--  or open in SQL Developer and Run Script (F5).
-- ============================================================================

SET SERVEROUTPUT ON

DECLARE
    n PLS_INTEGER;

    -- Adds one column only when it is absent.
    PROCEDURE add_column_if_missing(p_col IN VARCHAR2, p_ddl IN VARCHAR2) IS
        c PLS_INTEGER;
    BEGIN
        SELECT COUNT(*) INTO c
          FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = 'T_ADMINS_DEV'
           AND COLUMN_NAME = p_col;

        IF c = 0 THEN
            EXECUTE IMMEDIATE 'ALTER TABLE T_ADMINS_DEV ADD (' || p_ddl || ')';
            DBMS_OUTPUT.PUT_LINE('  added   ' || p_col);
        ELSE
            DBMS_OUTPUT.PUT_LINE('  present ' || p_col || ' (skipped)');
        END IF;
    END;

    -- Adds one CHECK constraint only when it is absent.
    PROCEDURE add_check_if_missing(p_name IN VARCHAR2, p_cond IN VARCHAR2) IS
        c PLS_INTEGER;
    BEGIN
        SELECT COUNT(*) INTO c
          FROM USER_CONSTRAINTS
         WHERE TABLE_NAME = 'T_ADMINS_DEV'
           AND CONSTRAINT_NAME = p_name;

        IF c = 0 THEN
            EXECUTE IMMEDIATE
                'ALTER TABLE T_ADMINS_DEV ADD CONSTRAINT ' || p_name ||
                ' CHECK (' || p_cond || ')';
            DBMS_OUTPUT.PUT_LINE('  added   ' || p_name);
        ELSE
            DBMS_OUTPUT.PUT_LINE('  present ' || p_name || ' (skipped)');
        END IF;
    END;
BEGIN
    SELECT COUNT(*) INTO n
      FROM USER_TABLES
     WHERE TABLE_NAME = 'T_ADMINS_DEV';

    IF n = 0 THEN
        DBMS_OUTPUT.PUT_LINE(
            'T_ADMINS_DEV does not exist — run 01_schema.sql instead.');
        RETURN;
    END IF;

    DBMS_OUTPUT.PUT_LINE('Columns:');

    -- Server-notification delivery address. Nullable: an admin who receives no
    -- server notifications needs no address.
    add_column_if_missing('EMAIL', 'EMAIL VARCHAR2(255)');

    -- Per-admin, per-channel opt-in. DEFAULT 'N' — deny by default, so existing
    -- rows are opted OUT of every channel until an administrator opts them in.
    -- Adding a NOT NULL column WITH a default is a metadata-only operation on
    -- Oracle 11g and later; it does not rewrite existing rows.
    add_column_if_missing('CAN_RECEIVE_SRV_CRIT',
        'CAN_RECEIVE_SRV_CRIT CHAR(1) DEFAULT ''N'' NOT NULL');
    add_column_if_missing('CAN_RECEIVE_SRV_DEPS',
        'CAN_RECEIVE_SRV_DEPS CHAR(1) DEFAULT ''N'' NOT NULL');
    add_column_if_missing('CAN_RECEIVE_SRV_RED',
        'CAN_RECEIVE_SRV_RED  CHAR(1) DEFAULT ''N'' NOT NULL');
    add_column_if_missing('CAN_RECEIVE_SRV_SYS',
        'CAN_RECEIVE_SRV_SYS  CHAR(1) DEFAULT ''N'' NOT NULL');

    DBMS_OUTPUT.PUT_LINE('Constraints:');

    add_check_if_missing('CK_T_ADMINS_DEV_SRV_CRIT',
        'CAN_RECEIVE_SRV_CRIT IN (''Y'', ''N'')');
    add_check_if_missing('CK_T_ADMINS_DEV_SRV_DEPS',
        'CAN_RECEIVE_SRV_DEPS IN (''Y'', ''N'')');
    add_check_if_missing('CK_T_ADMINS_DEV_SRV_RED',
        'CAN_RECEIVE_SRV_RED  IN (''Y'', ''N'')');
    add_check_if_missing('CK_T_ADMINS_DEV_SRV_SYS',
        'CAN_RECEIVE_SRV_SYS  IN (''Y'', ''N'')');

    DBMS_OUTPUT.PUT_LINE('Done. T_ADMINS_DEV now matches 01_schema.sql.');
END;
/

-- Column comments (mirrors 01_schema.sql). COMMENT ON is idempotent by nature.
COMMENT ON COLUMN T_ADMINS_DEV.EMAIL
    IS 'Server-notification delivery address.';
COMMENT ON COLUMN T_ADMINS_DEV.CAN_RECEIVE_SRV_CRIT
    IS 'Opt-in: critical server notifications (Y/N).';
COMMENT ON COLUMN T_ADMINS_DEV.CAN_RECEIVE_SRV_DEPS
    IS 'Opt-in: dependency server notifications (Y/N).';
COMMENT ON COLUMN T_ADMINS_DEV.CAN_RECEIVE_SRV_RED
    IS 'Opt-in: RED-metrics server notifications (Y/N).';
COMMENT ON COLUMN T_ADMINS_DEV.CAN_RECEIVE_SRV_SYS
    IS 'Opt-in: system server notifications (Y/N).';

-- Verification — should list all 13 columns of the current contract.
SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT
  FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'T_ADMINS_DEV'
 ORDER BY COLUMN_ID;
