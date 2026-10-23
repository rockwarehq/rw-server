-- Andon rules can ask matching stations to pulse on the boards.
ALTER TABLE "SiteAndonRule" ADD COLUMN "pulse" BOOLEAN NOT NULL DEFAULT false;

-- Downtime reasons can be offered as one-tap buttons when coding downtime.
ALTER TABLE "StatusReason" ADD COLUMN "quick" BOOLEAN NOT NULL DEFAULT false;
