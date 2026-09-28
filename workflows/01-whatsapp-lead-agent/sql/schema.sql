-- Workflow 1: leads, their messages, and the editable business facts.
-- Idempotent: scripts/bootstrap.sh runs it on every start.

CREATE TABLE IF NOT EXISTS leads (
    id               bigserial   PRIMARY KEY,
    conversation_id  uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    source           text        NOT NULL CHECK (source IN ('whatsapp', 'form')),
    contact          text        NOT NULL,   -- normalised: +<digits> for phones, lowercase for emails
    contact_name     text,
    first_message    text        NOT NULL,
    status           text        NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'replied', 'no_reply', 'needs_human', 'spam', 'followed_up', 'template_needed', 'followup_manual')),
    -- qualification (LLM output after validation)
    intent           text        CHECK (intent IN ('buy', 'pricing', 'support', 'spam', 'other')),
    budget_signal    text,
    urgency          text        CHECK (urgency IN ('now', 'this_month', 'later', 'unknown')),
    fit_score        integer     CHECK (fit_score BETWEEN 0 AND 100),
    missing_info     jsonb,
    reason           text,
    schema_valid     boolean,
    llm_attempts     integer     NOT NULL DEFAULT 0,
    guard_flags      jsonb,                  -- why a draft reply was replaced, if it was
    reply_sent       text,
    -- timeline
    received_at      timestamptz NOT NULL,
    last_inbound_at  timestamptz NOT NULL,
    last_outbound_at timestamptz,
    followed_up_at   timestamptz,            -- set BEFORE sending, so a follow-up can never go twice
    followup_status  text,
    -- CRM
    crm_person_id    text,
    crm_deal_id      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_contact_recent_idx ON leads (contact, last_inbound_at DESC);
CREATE INDEX IF NOT EXISTS leads_followup_idx ON leads (status, last_outbound_at) WHERE followed_up_at IS NULL;

CREATE TABLE IF NOT EXISTS lead_messages (
    id          bigserial   PRIMARY KEY,
    lead_id     bigint      NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
    direction   text        NOT NULL CHECK (direction IN ('in', 'out')),
    channel     text        NOT NULL CHECK (channel IN ('whatsapp', 'form')),
    external_id text        UNIQUE,          -- WhatsApp message id (wamid.…); Meta retries deliveries for up to 7 days
    body        text        NOT NULL,
    delivered   boolean,                     -- outbound only: did the channel accept it
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_messages_lead_idx ON lead_messages (lead_id, created_at);

-- One row: the contents of workflows/01-whatsapp-lead-agent/business-facts.json.
CREATE TABLE IF NOT EXISTS business_facts (
    id         integer     PRIMARY KEY CHECK (id = 1),
    data       jsonb       NOT NULL,
    loaded_at  timestamptz NOT NULL DEFAULT now()
);

-- Store one inbound message and decide which lead it belongs to, atomically.
--   * duplicate  : same WhatsApp message id seen before (Meta retries)  -> nothing stored
--   * attached   : same contact wrote within p_dedupe_minutes           -> message joins that lead
--   * new        : otherwise                                            -> new lead + message
-- The advisory lock serialises messages from the SAME contact, so three WhatsApp messages sent a
-- second apart can't each create a lead. PL/pgSQL takes a fresh snapshot per statement, so the
-- second caller, once it gets the lock, sees the lead the first caller just committed.
CREATE OR REPLACE FUNCTION lead_ingest(
    p_contact text, p_source text, p_name text, p_message text,
    p_external_id text, p_received_at timestamptz, p_dedupe_minutes integer)
RETURNS TABLE (lead_id bigint, conversation_id uuid, outcome text, facts jsonb)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
    v_id   bigint;
    v_conv uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_contact));

    IF p_external_id IS NOT NULL THEN
        SELECT m.lead_id INTO v_id FROM lead_messages m WHERE m.external_id = p_external_id;
        IF v_id IS NOT NULL THEN
            RETURN QUERY SELECT l.id, l.conversation_id, 'duplicate'::text, NULL::jsonb FROM leads l WHERE l.id = v_id;
            RETURN;
        END IF;
    END IF;

    SELECT l.id, l.conversation_id INTO v_id, v_conv
      FROM leads l
     WHERE l.contact = p_contact
       AND l.last_inbound_at > p_received_at - make_interval(mins => p_dedupe_minutes)
     ORDER BY l.last_inbound_at DESC
     LIMIT 1;

    IF v_id IS NULL THEN
        INSERT INTO leads (source, contact, contact_name, first_message, received_at, last_inbound_at)
        VALUES (p_source, p_contact, p_name, p_message, p_received_at, p_received_at)
        RETURNING leads.id, leads.conversation_id INTO v_id, v_conv;
        INSERT INTO lead_messages (lead_id, direction, channel, external_id, body, created_at)
        VALUES (v_id, 'in', p_source, p_external_id, p_message, p_received_at);
        RETURN QUERY SELECT v_id, v_conv, 'new'::text, (SELECT b.data FROM business_facts b WHERE b.id = 1);
    ELSE
        UPDATE leads SET last_inbound_at = greatest(last_inbound_at, p_received_at), updated_at = now() WHERE id = v_id;
        INSERT INTO lead_messages (lead_id, direction, channel, external_id, body, created_at)
        VALUES (v_id, 'in', p_source, p_external_id, p_message, p_received_at);
        RETURN QUERY SELECT v_id, v_conv, 'attached'::text, NULL::jsonb;
    END IF;
END $$;
