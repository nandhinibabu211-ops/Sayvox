-- Least-privilege roles (Story 2.1 AC 4). Run once per environment as an admin,
-- with the passwords taken from Secret Manager. Not part of the automatic migrations.
--
--   sayvox_migrator : owns the schema, runs migrations (CI deploy step only)
--   sayvox_app      : what the API connects as; data access only, no DDL

CREATE ROLE sayvox_migrator LOGIN;  -- set PASSWORD via ALTER ROLE after creation
CREATE ROLE sayvox_app LOGIN;

GRANT CONNECT ON DATABASE sayvox TO sayvox_migrator, sayvox_app;
GRANT USAGE, CREATE ON SCHEMA public TO sayvox_migrator;
GRANT USAGE ON SCHEMA public TO sayvox_app;

-- Tables created by the migrator are readable/writable by the app, never alterable.
ALTER DEFAULT PRIVILEGES FOR ROLE sayvox_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sayvox_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sayvox_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sayvox_app;
