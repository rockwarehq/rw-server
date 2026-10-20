-- Andon rules can ask matching stations to pulse on the boards.
ALTER TABLE "SiteAndonRule" ADD COLUMN "pulse" BOOLEAN NOT NULL DEFAULT false;
