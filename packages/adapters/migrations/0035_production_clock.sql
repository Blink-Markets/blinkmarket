-- Session settings cannot alter the production clock used by sealed forecast views.
CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp()
$$;
