# Synthetic State-Format v2 Fixture

These files are deliberately synthetic. They exercise the migration and backup
compatibility boundaries and must never be treated as production state.

- `state-migration.json` is a valid migration contract for a v1 to v2 change.
- `state-manifest.json` is a v2 state backup that the current v1 runtime rejects.
- `work-context.json` is the matching v2 state file used by the backup checksum.
