-- Migration number: 0002 	 2026-02-17T07:15:00.000Z
ALTER TABLE education_logs ADD COLUMN processed INTEGER DEFAULT 0;
