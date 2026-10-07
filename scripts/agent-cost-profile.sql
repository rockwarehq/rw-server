-- Agent cost profile: where model spend goes, from the runtime's own log.
-- Read-only. Every model call commits a step.finished event with its usage;
-- this rolls those up per prompt (input) and traffic class.
--
--   psql "$DATABASE_URL" -v days=14 -f scripts/agent-cost-profile.sql
--
-- Rates are USD per million tokens for claude-opus-5, from
-- https://platform.claude.com/docs/en/about-claude/pricing (2026-10-07).
-- Override with -v when they change. Cache writes are priced at the 5-minute
-- rate; 1-hour writes cost more (10.00) and are not split out in the log.

\set ON_ERROR_STOP on
\if :{?days}
\else
  \set days 14
\endif
\if :{?rate_input}
\else
  \set rate_input 5.00
\endif
\if :{?rate_cache_write}
\else
  \set rate_cache_write 6.25
\endif
\if :{?rate_cache_read}
\else
  \set rate_cache_read 0.50
\endif
\if :{?rate_output}
\else
  \set rate_output 25.00
\endif

-- Each model call, tied to the prompt (input.consumed) it served.
CREATE TEMP VIEW agent_steps AS
SELECT
  e."sessionId" AS session_id,
  s.trigger::text AS trigger,
  s."agentKey" AS agent_key,
  e.seq,
  e."createdAt" AS at,
  i.seq AS input_seq,
  i."createdAt" AS input_at,
  COALESCE((e.payload -> 'usage' ->> 'inputTokens')::bigint, 0) AS input_tokens,
  COALESCE((e.payload -> 'usage' ->> 'cacheCreationInputTokens')::bigint, 0) AS cache_write_tokens,
  COALESCE((e.payload -> 'usage' ->> 'cacheReadInputTokens')::bigint, 0) AS cache_read_tokens,
  COALESCE((e.payload -> 'usage' ->> 'outputTokens')::bigint, 0) AS output_tokens,
  e.payload -> 'cacheMiss' AS cache_miss
FROM "AgentEvent" e
JOIN "AgentSession" s ON s.id = e."sessionId"
LEFT JOIN LATERAL (
  SELECT seq, "createdAt"
  FROM "AgentEvent" ic
  WHERE ic."sessionId" = e."sessionId" AND ic.type LIKE 'input.consumed.%' AND ic.seq < e.seq
  ORDER BY ic.seq DESC
  LIMIT 1
) i ON true
WHERE e.type LIKE 'step.finished.%'
  AND e."createdAt" > now() - make_interval(days => :days);

CREATE TEMP VIEW agent_step_cost AS
SELECT *,
  input_tokens * :rate_input / 1e6 AS usd_input,
  cache_write_tokens * :rate_cache_write / 1e6 AS usd_cache_write,
  cache_read_tokens * :rate_cache_read / 1e6 AS usd_cache_read,
  output_tokens * :rate_output / 1e6 AS usd_output,
  (input_tokens * :rate_input + cache_write_tokens * :rate_cache_write
    + cache_read_tokens * :rate_cache_read + output_tokens * :rate_output) / 1e6 AS usd
FROM agent_steps;

-- One row per prompt: what answering it cost.
CREATE TEMP VIEW agent_prompts AS
SELECT
  session_id, input_seq, min(input_at) AS input_at, trigger, agent_key,
  count(*) AS steps,
  sum(input_tokens) AS input_tokens,
  sum(cache_write_tokens) AS cache_write_tokens,
  sum(cache_read_tokens) AS cache_read_tokens,
  sum(output_tokens) AS output_tokens,
  sum(usd) AS usd,
  sum(usd_output) AS usd_output,
  sum(usd_cache_write) AS usd_cache_write,
  sum(usd_cache_read) AS usd_cache_read,
  sum(usd_input) AS usd_input
FROM agent_step_cost
GROUP BY session_id, input_seq, trigger, agent_key;

\echo '== 1. Cost per prompt, by traffic class and agent =='
SELECT trigger, agent_key,
  count(*) AS prompts,
  round(avg(steps), 1) AS avg_steps,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY usd)::numeric, 3) AS p50_usd,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY usd)::numeric, 3) AS p90_usd,
  round(max(usd)::numeric, 3) AS max_usd,
  round(sum(usd)::numeric, 2) AS total_usd
FROM agent_prompts
GROUP BY trigger, agent_key
ORDER BY total_usd DESC;

\echo '== 2. Token mix: share of dollars by meter =='
SELECT trigger,
  round(sum(usd)::numeric, 2) AS total_usd,
  round(100 * sum(usd_output) / nullif(sum(usd), 0), 1) AS pct_output,
  round(100 * sum(usd_cache_write) / nullif(sum(usd), 0), 1) AS pct_cache_write,
  round(100 * sum(usd_cache_read) / nullif(sum(usd), 0), 1) AS pct_cache_read,
  round(100 * sum(usd_input) / nullif(sum(usd), 0), 1) AS pct_uncached_input,
  round(100.0 * sum(cache_read_tokens)
    / nullif(sum(cache_read_tokens + cache_write_tokens + input_tokens), 0), 1) AS cache_hit_pct
FROM agent_step_cost
GROUP BY trigger
ORDER BY total_usd DESC;

\echo '== 3a. Cache health: first step of a prompt vs later steps =='
-- Later steps reuse the in-memory history and should be mostly cache reads.
-- A first step that writes most of its input means the replayed history or
-- the cache lifetime missed (the jsonb key-order bug, or a long pause).
SELECT trigger,
  CASE WHEN rn = 1 THEN 'first step' ELSE 'later steps' END AS step,
  count(*) AS calls,
  round(avg(cache_read_tokens)) AS avg_cache_read,
  round(avg(cache_write_tokens)) AS avg_cache_write,
  round(avg(input_tokens)) AS avg_uncached,
  round(100.0 * sum(cache_read_tokens)
    / nullif(sum(cache_read_tokens + cache_write_tokens + input_tokens), 0), 1) AS hit_pct
FROM (
  SELECT *, row_number() OVER (PARTITION BY session_id, input_seq ORDER BY seq) AS rn
  FROM agent_step_cost
) t
GROUP BY trigger, step
ORDER BY trigger, step;

\echo '== 3b. History carry: later chat prompts, by gap since the previous prompt =='
SELECT
  CASE
    WHEN gap IS NULL THEN '0 first prompt'
    WHEN gap < interval '5 minutes' THEN '1 under 5 min'
    WHEN gap < interval '1 hour' THEN '2 5-60 min'
    ELSE '3 over 1 hour'
  END AS gap_bucket,
  count(*) AS prompts,
  round(avg(first_write)) AS avg_first_step_cache_write,
  round(avg(first_read)) AS avg_first_step_cache_read,
  round(avg(usd)::numeric, 3) AS avg_prompt_usd
FROM (
  SELECT p.*,
    p.input_at - lag(p.input_at) OVER (PARTITION BY p.session_id ORDER BY p.input_seq) AS gap,
    f.cache_write_tokens AS first_write,
    f.cache_read_tokens AS first_read
  FROM agent_prompts p
  JOIN LATERAL (
    SELECT cache_write_tokens, cache_read_tokens FROM agent_steps st
    WHERE st.session_id = p.session_id AND st.input_seq IS NOT DISTINCT FROM p.input_seq
    ORDER BY st.seq LIMIT 1
  ) f ON true
  WHERE p.trigger = 'CHAT'
) t
GROUP BY gap_bucket
ORDER BY gap_bucket;

\echo '== 4. Tool result weight (characters the model saw, capped at 60000) =='
SELECT e.payload ->> 'name' AS tool,
  count(*) AS calls,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY least(length(e.payload ->> 'output'), 60000))::numeric) AS p50_chars,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY least(length(e.payload ->> 'output'), 60000))::numeric) AS p90_chars,
  max(least(length(e.payload ->> 'output'), 60000)) AS max_chars,
  count(*) FILTER (WHERE (e.payload ->> 'truncated')::boolean) AS truncated
FROM "AgentEvent" e
WHERE e.type LIKE 'tool.completed.%'
  AND e."createdAt" > now() - make_interval(days => :days)
GROUP BY tool
ORDER BY sum(least(length(e.payload ->> 'output'), 60000)) DESC;

\echo '== 5. Cache misses the API diagnosed (AGENT_CACHE_DIAGNOSTICS=true) =='
SELECT trigger,
  cache_miss ->> 'type' AS reason,
  count(*) AS calls,
  sum(COALESCE((cache_miss ->> 'cache_missed_input_tokens')::bigint, 0)) AS missed_tokens
FROM agent_steps
WHERE cache_miss IS NOT NULL AND cache_miss <> 'null'::jsonb
GROUP BY trigger, reason
ORDER BY missed_tokens DESC;
