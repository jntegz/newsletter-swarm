-- At most WEBHOOK_ENDPOINT_MAX_CONCURRENT deliveries in flight to one webhook endpoint at a time
-- (security review S04-P3-TR-tenant-outbound-lanes). A delivery takes a lease before it calls the
-- endpoint and gives it back after; one that finds every lease taken waits a few seconds without
-- using an attempt. A lease ends by itself after WEBHOOK_LEASE_MS, so a worker that died can't
-- keep a place. Leases go with their endpoint.
CREATE TABLE webhook_endpoint_leases (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX webhook_endpoint_leases_by_endpoint ON webhook_endpoint_leases (endpoint_id, expires_at);
