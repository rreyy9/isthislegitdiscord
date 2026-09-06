-- Better Auth only sets account.issuer for providers that have one (OIDC,
-- SSO). Credential accounts have none, and better-auth 1.7.3 stopped sending
-- the field rather than sending an empty string -- which made every
-- registration fail on a NOT NULL that was never right in the first place.
--
-- Safe to re-run: dropping NOT NULL on an already-nullable column succeeds.
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
