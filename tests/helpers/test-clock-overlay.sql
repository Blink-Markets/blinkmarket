CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp() + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds', true), ''), '0')::double precision)
$$;
