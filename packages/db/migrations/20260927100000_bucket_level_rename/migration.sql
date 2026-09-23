-- "Tier" becomes "level": the plainer word for how much someone can do in
-- a bucket (VIEW, MANAGE, ADMIN). Only names change; values and rows stay.
-- Earlier migrations keep saying "tier" — that is history.

ALTER TYPE "BucketTier" RENAME TO "BucketLevel";
ALTER TABLE "BucketAccess" RENAME COLUMN "tier" TO "level";
