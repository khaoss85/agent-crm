// @ts-check
// Pre-state generated module fixture: revision 1 source, no module.state.json.

export const gadgetMigrations = [
  {
    name: 'create_gadgets',
    sql:
      "CREATE TABLE IF NOT EXISTS gadgets (" + '\n' +
      "  id TEXT PRIMARY KEY," + '\n' +
      "  label TEXT NOT NULL," + '\n' +
      "  value_cents INTEGER NOT NULL," + '\n' +
      "  active INTEGER CHECK(active IN (0, 1))," + '\n' +
      "  created_at TEXT NOT NULL," + '\n' +
      "  updated_at TEXT NOT NULL" + '\n' +
      ") STRICT;",
  },
];

export const gadgetMigration = gadgetMigrations[0];
