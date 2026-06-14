// All data access goes through src/lib/db. Query helpers are added here from
// M2 (Master Profile CRUD) onward; for now this re-exports the client factory.
export { getDb } from "./client";
