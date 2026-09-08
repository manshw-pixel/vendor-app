/**
 * Public configuration. Both values below are meant to be in the bundle.
 *
 * The anon key grants the `anon` Postgres role and nothing more; what any signed-in
 * user may read or write is decided by the RLS policies in
 * supabase/migrations/0002_rls.sql, per vendor and per role.
 *
 * The service_role key must NEVER appear here or anywhere else under web/. It carries
 * bypassrls, so a copy in a browser bundle is a full database compromise.
 */
export const SUPABASE_URL = "https://cnnqidkmcxkgwxnulvig.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubnFpZGttY3hrZ3d4bnVsdmlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MzgxOTUsImV4cCI6MjEwNDQxNDE5NX0.tSZv1HuVpDFzdcXiio_EIZPt-8cY6m8qJCPmc5oclOo";

/** Exactly the values app_users.role permits (0001_schema.sql check constraint). */
export const ROLES = ["admin", "recorder", "biller"] as const;
export type Role = (typeof ROLES)[number];
