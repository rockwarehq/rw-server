-- Bucket integrity: rules the app already follows, now kept by the database.
--
--   - One PLANT bucket per site (partial unique index; Prisma cannot
--     express it, so it lives here — see iam.prisma).
--   - A bucket has a workcenter exactly when it is a WORKCENTER bucket.
--   - Bucket names follow their site/workcenter. Renames did not update
--     them; heal any drift once (the services keep them in step from now).
--
-- ADMIN-only-on-plant-buckets stays an app rule (checkBuckets in the
-- members service): a CHECK cannot see the bucket's kind from BucketAccess.

CREATE UNIQUE INDEX "Bucket_one_plant_per_site" ON "Bucket"("siteId") WHERE "kind" = 'PLANT';

ALTER TABLE "Bucket"
  ADD CONSTRAINT "Bucket_kind_workcenter_check"
  CHECK (("kind" = 'WORKCENTER') = ("workcenterId" IS NOT NULL));

UPDATE "Bucket" b SET "name" = s."name", "updatedAt" = now()
FROM "Site" s
WHERE b."kind" = 'PLANT' AND b."siteId" = s."id" AND b."name" <> s."name";

UPDATE "Bucket" b SET "name" = w."name", "updatedAt" = now()
FROM "Workcenter" w
WHERE b."kind" = 'WORKCENTER' AND b."workcenterId" = w."id" AND b."name" <> w."name";
