# Gateway State-Format Migration Boundary

Status date: 2026-11-28

Gateway state is a release-level contract. A change to persisted process-context
or quality records, the idempotency ledger, work-context state, or state-backup
semantics must not be shipped as an incidental code change. The current runtime
supports state format `1.0`; the migration boundary is implemented, but an
actual production state migration is not.

## Contract

Every release whose `stateFormatVersion` is later than the initial `1.0` format
must include a tracked `state-migration.json`. The file is listed in the release
manifest, covered by `SHA256SUMS`, and therefore authenticated by the detached
archive signature. A release with a missing or malformed migration contract is
rejected during packaging or verification.

```json
{
  "schemaVersion": "1.0",
  "kind": "rpi4-gateway-state-migration",
  "migrationId": "state-format-1-0-to-2-0",
  "fromVersion": "1.0",
  "toVersion": "2.0",
  "releaseId": "2.0.0-0123456789ab",
  "preflight": {
    "ruleId": "exact-source-format-and-verified-backup",
    "requiredStateFormatVersion": "1.0",
    "requireVerifiedBackup": true
  },
  "backup": {
    "required": true,
    "verification": "sha256-manifest",
    "offDeviceCopyRequired": true
  },
  "postMigrationValidation": {
    "ruleId": "state-format-file-integrity-and-backup-provenance",
    "checks": [
      "state-format-version",
      "state-file-integrity",
      "pre-migration-backup-provenance"
    ]
  },
  "rollback": {
    "procedureId": "restore-verified-pre-migration-backup",
    "codeOnly": false,
    "stateRestoreRequired": true,
    "verifiedBackupRequired": true
  }
}
```

The validator also requires the release manifest to declare
`rollback.mode: "state-restore-required"` for a migrated format. A release with
an unchanged `1.0` format declares `rollback.mode: "code-only"`. This makes the
rollback decision machine-readable instead of relying on an operator to infer it
from prose.

## Enforcement

- The source format is checked against the running Gateway format before any
  release switch. A mismatch reports the release version, runtime version, and
  migration ID.
- The current runtime rejects a synthetic `2.0` release even when its migration
  contract is complete. A future runtime may execute a contract only after its
  own migration implementation and hardware qualification exist.
- State backups declare their format and reject an unsupported source format.
  The synthetic v2 backup fixture cannot be restored by the v1 runtime.
- `release:rehearse` synthesizes a valid-looking v2 candidate from the supplied
  candidate archive, attempts installation, and requires rejection before the
  `current` link changes.
- The rehearsal creates and verifies a v1 pre-migration backup, proves the live
  accepted state did not change after the rejected v2 attempt, then restores the
  backup into an isolated directory and checks every file hash and mode.

The synthetic fixture is in
`test/fixtures/state-format-v2/`. It is test data only and must never be copied
to `/var/lib/rpi4-gateway`.

## Future Operator Procedure

The following sequence becomes applicable only when a release actually ships a
supported migration executor and passes its hardware gates.

1. Stop the Gateway service.
2. Create a state backup with the old release and run `state:verify`.
3. Copy the verified backup off the Raspberry Pi and record its SHA-256.
4. Verify the archive checksum, detached signature, signer identity, and trust
   policy before extraction.
5. Run `release:rehearse` against the previous and candidate archives plus a
   copy of the current state directory.
6. Confirm the migration contract's `fromVersion` equals the live state format
   and that preflight requires the verified backup.
7. Install the candidate only where the running release explicitly supports the
   target format. The current v1 runtime must refuse this step.
8. Run the contract's post-migration checks before accepting `/healthz` as
   sufficient evidence.
9. If post-migration validation fails, keep the service stopped, restore the
   verified pre-migration backup, then roll back the code. Do not start the old
   release against migrated state first.

Code rollback alone is sufficient only when the release manifest says
`rollback.mode: "code-only"`. Any other value requires a verified state restore
before the old release starts.

## Remaining Gates

This boundary proves format mismatch handling, contract completeness, package
binding, and offline backup/restore behavior. It does not prove a real state
migration. Physical power loss during migration, disk-full behavior, filesystem
durability, SD-card failure, and rollback timing on a Raspberry Pi remain L3
hardware gates. Simulated rehearsal output cannot close them.
