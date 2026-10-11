-- ===========================================================================
-- TransitSync 009 — platform-owner two-factor authentication
--
-- The Level 200 Platform Super Administrator is the highest-privilege account
-- on the platform (college provisioning, tenant suspension, the global
-- maintenance switch). This migration adds the storage needed to protect that
-- one account with a second factor, without touching any campus role.
--
--   users.two_factor_method        — the factor the owner enrolled: 'TOTP' | 'EMAIL'
--   users.totp_secret              — base32 shared secret (authenticator app)
--   users.two_factor_enabled       — 1 once enrollment has been confirmed
--   users.two_factor_confirmed_at  — when the factor was proven
--   users.recovery_codes           — JSON array of {h, u}: sha-256 hash + used-at
--
-- Two transient tables back the sign-in second step:
--
--   login_challenges — a pending password-verified sign-in awaiting its code.
--                      Kept in the database (not a signed token) so it can be
--                      consumed exactly once and rate-limited per attempt.
--   email_otp_codes  — short-lived one-time codes delivered by email.
--
-- Every table cascades from `users`, so removing an account cleans up any
-- pending challenge material with it. Nullable columns only, so this is an
-- in-place ALTER that is safe to run unattended on a live database.
-- ===========================================================================

ALTER TABLE users ADD COLUMN two_factor_method TEXT;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN two_factor_confirmed_at TEXT;
ALTER TABLE users ADD COLUMN recovery_codes TEXT;

CREATE TABLE IF NOT EXISTS login_challenges (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  remember    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  user_agent  TEXT,
  device      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id);

CREATE TABLE IF NOT EXISTS email_otp_codes (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'LOGIN_2FA',
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_otp_user ON email_otp_codes(user_id);
