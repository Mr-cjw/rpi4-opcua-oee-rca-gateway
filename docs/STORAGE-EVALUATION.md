# Storage Evaluation: JSONL and SQLite WAL

Status date: 2026-11-27

## Scope

This evaluation decides whether SQLite WAL should replace the current bounded
JSONL event logs and separate idempotency ledger. The migration must preserve
existing JSONL replay, event sequence watermarks, quality idempotency, health
reporting, backup, and restore behavior.

The Gateway remains one process per station. Replacing JSONL must not introduce
a distributed database or a second source of truth.

## Options

| Option | Advantages | Costs and risks |
| --- | --- | --- |
| Current JSONL | Human-readable, append-only, simple rotation, existing replay and backup, configurable fsync durability | No indexes, no transactions across files, fsync reduces throughput and increases SD-card wear, replay cost grows with retained history |
| `node:sqlite` WAL | No third-party package, transactions, indexes, bounded SQL retention, crash-safe WAL | Requires a newer Node.js baseline, synchronous API can block the event loop, backup must include WAL state, database schema migrations become part of the release contract |
| `better-sqlite3` | Mature API and similar WAL behavior | Native addon build and ABI management on Raspberry Pi, larger deployment and upgrade surface |
| External time-series database | Strong query and retention capabilities | Adds another service to operate, back up, authenticate, and monitor; not proportionate for one station |

`node:sqlite` is the only SQLite candidate carried forward. It avoids a native
dependency, and its `DatabaseSync` API is acceptable at the Gateway's low event
rate. A future high-rate sampler would need a worker-thread boundary.

## Reproducible Benchmark

Run:

```bash
STORAGE_EVAL_RECORDS=2000 npm run storage:evaluate
```

The command compares sequential JSONL, JSONL with `fsync` per record, SQLite WAL
with `synchronous=NORMAL`, and SQLite WAL with `synchronous=FULL`. It parses
every record during the read phase and runs `PRAGMA integrity_check` for SQLite.

Development-host result on 2026-11-27 with Node.js 26.13.1 on Linux x64:

| Mode | Write rate | Read time | Footprint | Integrity |
| --- | ---: | ---: | ---: | --- |
| JSONL append | 34,463/s | 16.2 ms | 657,578 B | ok |
| JSONL append + fsync | 1,313/s | 8.9 ms | 657,578 B | ok |
| SQLite WAL `NORMAL` | 35,171/s | 8.6 ms | 827,392 B | ok |
| SQLite WAL `FULL` | 1,469/s | 8.8 ms | 827,392 B | ok |

These results are directional, not a Raspberry Pi acceptance result. They show
that SQLite WAL `FULL` costs roughly the same as an fsync-per-record JSONL path,
while adding indexes and transactional retention. Both durable modes remain far
above the default one-process-context-per-second rate plus intermittent NG
events.

SQLite `NORMAL` keeps the database consistent across power loss but can lose
recently committed transactions. It is not sufficient for an NG ingestion
request that has already returned success. Acknowledged quality events require
`FULL`, or an equivalent explicitly synced WAL policy.

The current JSONL path now has the equivalent policy: quality-event appends and
their parent directory are fsynced by default before a successful API response,
while process-context appends default to buffered writes and can opt into fsync
with `PROCESS_CONTEXT_LOG_FSYNC=true`. Work-context and idempotency-ledger state
files fsync their temporary file and parent directory around the atomic rename.

## Decision

SQLite WAL is a conditional go for the next storage backend. JSONL remains the
default in the current release.

The blocking work is not query performance. It is operational correctness:

- the project currently supports Node.js 20 while `node:sqlite` requires a newer
  runtime;
- backup and restore currently copy regular JSONL and ledger files, not a
  checkpointed SQLite database plus WAL state;
- an idempotent JSONL-to-SQLite importer and schema migration contract do not
  exist yet;
- power-loss, WAL-growth, checkpoint, and disk-budget behavior have not been
  tested on Raspberry Pi storage.

Do not dual-write JSONL and SQLite. Accepting a write in both stores creates two
durability authorities and an ambiguous recovery path. During migration, JSONL
is the import source, then SQLite becomes the only authoritative store.

## Adoption Gates

1. Move the supported runtime to a pinned Node.js release with the required
   `node:sqlite` behavior, and update CI across the supported LTS versions.
2. Benchmark sustained writes on the target Raspberry Pi with both SD-card and
   SSD deployments, including a multi-day disk-growth projection.
3. Implement a storage backend matching the existing append, read, flush, and
   health contract, including sequence gaps and fail-closed writes.
4. Build a one-shot, idempotent JSONL importer that preserves event IDs, source
   event IDs, sequence watermarks, timestamps, and metadata; record skipped
   corrupt records in an import manifest.
5. Extend backup, verification, and restore to checkpoint and copy a consistent
   SQLite snapshot, including WAL state when present.
6. Cover forced kill, sync failure, disk full, WAL growth, retention deletion,
   interrupted migration, and rollback to a verified pre-migration snapshot.
7. Document the schema version, upgrade path, retention query, and operator
   recovery procedure before changing the default.

Current legacy replay compatibility is exercised by
`test/fixtures/legacy-jsonl/` and `test/storage-migration.test.js`. Those
fixtures cover rotated JSONL, records without `sequence`, and idempotency-ledger
entries whose source event is no longer retained in the event log.

Multi-day behavior is exercised without waiting three real days by
`test/retention-budget.test.js`. It advances a virtual clock through 4,320
process-context samples and 432 quality events, then verifies in-memory
retention, idempotency expiry, replay, sequence continuity, and the
`(MAX_FILES + 1) x MAX_BYTES` per-stream disk bound. Physical 72-hour and
power-cut validation remain Raspberry Pi release gates.
