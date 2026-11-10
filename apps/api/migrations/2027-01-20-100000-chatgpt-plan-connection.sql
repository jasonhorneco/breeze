-- The plan connection is keyless in Breeze. Its OAuth profile belongs to the
-- private subscription worker and is never saved to the registry.
ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_kind_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_kind_chk
  CHECK (kind IN ('anthropic_byok', 'catalog', 'openai_compatible', 'chatgpt_plan'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_chatgpt_plan_keyless_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_chatgpt_plan_keyless_chk
  CHECK (kind <> 'chatgpt_plan' OR api_key_encrypted IS NULL);

ALTER TABLE public.ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_billing_source_chk;
ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_billing_source_chk
  CHECK (billing_source IN ('platform', 'partner_key', 'chatgpt_plan'));

ALTER TABLE public.ai_cost_usage DROP CONSTRAINT IF EXISTS ai_cost_usage_billing_source_chk;
ALTER TABLE public.ai_cost_usage ADD CONSTRAINT ai_cost_usage_billing_source_chk
  CHECK (billing_source IN ('platform', 'partner_key', 'chatgpt_plan'));

ALTER TABLE public.ai_budget_reservations DROP CONSTRAINT IF EXISTS ai_budget_reservations_billing_source_check;
ALTER TABLE public.ai_budget_reservations ADD CONSTRAINT ai_budget_reservations_billing_source_check
  CHECK (billing_source IN ('platform', 'partner_key', 'chatgpt_plan'));

ALTER TABLE public.ai_budget_alert_events DROP CONSTRAINT IF EXISTS ai_budget_alert_events_source_chk;
ALTER TABLE public.ai_budget_alert_events ADD CONSTRAINT ai_budget_alert_events_source_chk
  CHECK (billing_source IN ('platform', 'partner_key', 'chatgpt_plan'));

ALTER TABLE public.ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_funding_source_chk;
ALTER TABLE public.ai_agent_runs ADD CONSTRAINT ai_agent_runs_funding_source_chk
  CHECK (funding_source IS NULL OR funding_source IN ('platform', 'partner_key', 'chatgpt_plan'));

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_shape_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_shape_chk CHECK (
  funding_source IN ('platform', 'partner_key', 'chatgpt_plan')
  AND (thinking_mode_sent IS NULL OR thinking_mode_sent IN ('adaptive', 'budget', 'none', 'unknown'))
  AND input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
  AND (rate_snapshot IS NULL) = (cost_cents IS NULL)
  AND (cost_cents IS NULL OR cost_cents >= 0)
  AND jsonb_typeof(options_sent) = 'object'
  AND (ledger_mode = 'shadow' OR legacy_cost_cents IS NULL)
  AND (funding_source <> 'chatgpt_plan' OR (NOT chargeable AND cost_cents IS NOT DISTINCT FROM 0))
);
