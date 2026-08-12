-- AlterEnum
-- Adds "setting_change" for the settings service (MILESTONES.md #78,
-- SCHEMA.md §17.2, §17.8): the audit event a settings write appends. `ALTER
-- TYPE ... ADD VALUE` cannot run inside the same transaction as the rest of
-- a migration in older Postgres, so it is its own statement.
ALTER TYPE "EventType" ADD VALUE 'setting_change';
