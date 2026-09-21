CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  service TEXT NOT NULL CHECK(service IN ('wms', 'wcs', 'wmts')),
  protocol TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at DESC);
