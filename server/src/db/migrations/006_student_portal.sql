-- Phase 3: pre-authorized student access portal.
--
-- A roster row (`students`) gains a link to the sign-in account that its owner
-- created for themselves, plus a `is_claimed` flag so the portal can tell an
-- unclaimed invite ("create your password") from a live account ("sign in").
--
-- Additive and non-breaking: both columns are nullable/defaulted, existing rows
-- keep working, and no application query is required to change.

ALTER TABLE students ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE students ADD COLUMN is_claimed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_students_email_lookup ON students(tenant_id, email);
