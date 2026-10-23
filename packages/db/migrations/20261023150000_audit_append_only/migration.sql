-- The audit trail is append-only: no UPDATE, DELETE or TRUNCATE on "AuditLog",
-- whatever the application does (docs/architecture/audit.md). A maintenance
-- script that must rewrite rows sets `SET LOCAL rockware.audit_bypass = 'on'`
-- inside its own transaction; nothing in the application does.

CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  IF current_setting('rockware.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'The audit trail is append-only: % on "AuditLog" is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only_rows"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();
