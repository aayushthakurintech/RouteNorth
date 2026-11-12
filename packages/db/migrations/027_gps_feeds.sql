-- Connecting GPS data a company already has (its provider's feed, its own Traccar server, a gateway) without
-- selling hardware: a per-company "gps" key lets that source push positions to RouteNorth, and devices it
-- sends are created for that company on first sight (source 'feed').

ALTER TABLE api_keys DROP CONSTRAINT api_keys_kind_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_kind_check CHECK (kind IN ('api','feed','inbound','gps'));

ALTER TABLE devices DROP CONSTRAINT devices_source_check;
ALTER TABLE devices ADD CONSTRAINT devices_source_check CHECK (source IN ('traccar','geotab','samsara','terminal','simulator','api','feed'));

-- Hardware ids (IMEIs) are unique across RouteNorth because the ingest service resolves them without knowing the
-- company. Ids from a company's own feed ("truck 12") only have to be unique inside that company.
ALTER TABLE devices DROP CONSTRAINT devices_source_external_id_key;
CREATE UNIQUE INDEX devices_source_external_id_key ON devices (source, external_id) WHERE source <> 'feed';
CREATE UNIQUE INDEX devices_feed_external_id_key ON devices (org_id, external_id) WHERE source = 'feed';
