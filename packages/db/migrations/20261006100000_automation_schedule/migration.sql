-- Clock-triggered automations ("time.daily") keep when they fire: { time: "HH:MM", days: [0-6] }
-- in the site's timezone. Null for event-triggered automations.
ALTER TABLE "Automation" ADD COLUMN "schedule" JSONB;
