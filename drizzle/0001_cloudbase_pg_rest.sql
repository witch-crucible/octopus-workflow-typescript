CREATE OR REPLACE FUNCTION public.capy_replace_octopus_snapshot(
  p_projects jsonb,
  p_requirements jsonb,
  p_snapshot_digest text,
  p_snapshot_source text,
  p_snapshot_scope text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  v_revision bigint;
BEGIN
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  IF jsonb_typeof(p_projects) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_requirements) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Snapshot tables must be JSON arrays';
  END IF;

  INSERT INTO public.capy_octopus_meta (key, value)
  VALUES ('snapshot_revision', '0')
  ON CONFLICT (key) DO NOTHING;

  SELECT value::bigint + 1
  INTO v_revision
  FROM public.capy_octopus_meta
  WHERE key = 'snapshot_revision'
  FOR UPDATE;

  DELETE FROM public.capy_requirements;
  DELETE FROM public.capy_projects;

  INSERT INTO public.capy_projects (
    project_id,
    name,
    description,
    state_json,
    updated_at
  )
  SELECT
    project_id,
    name,
    description,
    state_json,
    updated_at
  FROM jsonb_to_recordset(p_projects) AS project_rows(
    project_id text,
    name text,
    description text,
    state_json text,
    updated_at text
  );

  INSERT INTO public.capy_requirements (
    requirement_id,
    parent_project_id,
    requirement_name,
    state_json,
    updated_at
  )
  SELECT
    requirement_id,
    parent_project_id,
    requirement_name,
    state_json,
    updated_at
  FROM jsonb_to_recordset(p_requirements) AS requirement_rows(
    requirement_id text,
    parent_project_id text,
    requirement_name text,
    state_json text,
    updated_at text
  );

  INSERT INTO public.capy_octopus_meta (key, value)
  VALUES
    ('snapshot_revision', v_revision::text),
    ('snapshot_digest', p_snapshot_digest),
    ('snapshot_updated_at', now()::text),
    ('snapshot_source', p_snapshot_source),
    ('snapshot_scope', p_snapshot_scope)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN jsonb_build_object('snapshot_revision', v_revision);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.capy_replace_octopus_snapshot(jsonb, jsonb, text, text, text)
FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.capy_octopus_meta,
      public.capy_projects,
      public.capy_requirements
    TO service_role;
    GRANT EXECUTE ON FUNCTION
      public.capy_replace_octopus_snapshot(jsonb, jsonb, text, text, text)
    TO service_role;
  END IF;
END $$;
