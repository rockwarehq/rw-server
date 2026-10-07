-- Agent message history is replayed to the model verbatim. jsonb re-sorts
-- object keys, and tool_use inputs are rendered into the prompt, so replayed
-- history stopped matching the prompt cache. json keeps the bytes as written.
-- Rows written before this keep their re-sorted keys; new rows are exact.
ALTER TABLE "AgentMessage" ALTER COLUMN "content" SET DATA TYPE JSON USING "content"::json;
