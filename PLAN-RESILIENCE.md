# drangler Phase 6: Resilience and Migration Safety

Design document. Nothing here is implemented. This is Phase 6 of `PLAN-MODIFY.md` and inherits its
conventions without restating them: the exit-code set (`0` ok, `1` could not run, `2` bad input,
`3` ran and found something), the `[D]` / `[W]` / `[S]` repo tags, the global flags in its section
7.1, the stdin/stdout contract in its 5.5, and its rule that a refused mechanism records the
surviving objective separately.

Every route name, table name, function name and file path below was read out of the two trees on
2026-09-08. Anything that could not be determined from the code says so.

---

## 0. Worker Items Already Landed

`drupflare/worker` carries a large uncommitted working set. Four of PLAN-MODIFY's work items are
already in it, which changes what Phase 6 can assume:

| item                                | state                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| W6 `x-cfw-account-plan`             | **done**; `CFW_HEADER_VERSION = '2'` at `worker/src/site-do.ts:520` |
| W16 `/updb` owner route             | **done**; handler at `worker/src/site-do.ts:9516`                   |
| W17 route moves into `OWNER_ROUTES` | **done**; `site.ts:232-269` carries all four plus `/updb`           |
| W19 `CF_VERSION_METADATA`           | **done**; `/health` returns `version: this.workerVersion()`         |
| W21-W23 `/modify`                   | **open**; no `/__modify` case exists in `site-do.ts`                |
| W7 `x-cfw-account-plan` in drangler | **open**; `KNOWN_HEADER_VERSION` is still `1` (`probe.ts:17`)       |

So the healing and update surfaces Phase 6 needs are reachable today. The revision surface is not,
and section D's half-applied-revision state is gated on W21-W23 landing.

---

## 1. Gaps Found

Same form as PLAN-MODIFY's section 1.2: each is a reading, not an opinion. Numbering continues from
G16.

**G17. `/export` is not diagnostic-gated, and `rules.ts` says it is.**
`src/migrate/rules.ts` `export-gated` is a **blocker** reading "`/export` sits in DIAGNOSTIC_ROUTES
in `worker/src/site.ts` and 404s unless `PW_DIAGNOSTICS=1`". It is in `OWNER_ROUTES`
(`worker/src/site.ts:233`). `src/commands/migrate.ts:249` already says the opposite in its 404
message: "the route is not diagnostic-gated any more". Two files in this repository contradict each
other, and the wrong one is the one a user reads before deciding whether they can leave.

**G18. Every `to-vps` rule ignores its survey.**
`export-gated`, `export-structure-only`, `export-files`, `hash-salt` and `dialect-out` all declare
`evaluate()` with no parameters and return a constant `Finding`. The off-boarding direction is
therefore five fixed paragraphs, not a measurement. `buildPlan()` still computes `unknowns` from
`REQUIRED_FIELDS`, so a `--to vps` plan reports nine unmeasured fields that no `to-vps` rule would
have read anyway.

**G19. `export-files` states something the worker's own storage contradicts.**
It is a **blocker** reading "the export carries no managed files ... user uploads live outside it".
`worker/src/db/file-store.ts` stores `public://` and `private://` in `cfw_file` and
`cfw_file_chunk`, in the same SQLite as the entity row. Neither table is in `REGENERABLE_TABLES`
(`worker/src/db/export-sql.ts:52`), so both are dumped with rows. The bytes come out. What does not
exist is anything that turns `cfw_file_chunk` rows back into a `sites/default/files/` tree, and that
is the real gap the finding should name.

**G20. `migrate export` does not use the resumable dump the worker already offers.**
`worker/src/site-do.ts:10112` reads `?cursor=`, `dumpChunk()` walks a `DumpCursor` and the route
answers 409 on a shape mismatch because "two different dumps are being spliced". `runExportCommand`
issues one unbounded `?body=1` request and holds the whole dump in memory. A dropped connection
part-way loses everything, and the mechanism that would not have is on the far side already.

**G21. `run.ts` prints a stack trace to a user.**
`src/run.ts:27` passes `e.stack ?? e.message` to `ctx.io.err()`. That is the default path for every
exception that is not a `DranglerError`, which is every bug.

**G22. `build --json` writes prose to stdout on the hydrate failure path.**
`src/workspace/build.ts:190-197` calls `ctx.io.out(...)` twice before throwing. The comment argues
there is "no object to protect", but the promise `--json` makes is that stdout parses, and on this
path it does not. It is the one failure a new user is most likely to hit.

**G23. A survey error is not a verdict.**
`runSurvey()` records a failed required step in `survey.errors[]` and continues, which is right.
Nothing downstream turns that into a refusal: `buildPlan()` reports `unknowns` for absent fields and
`renderPlan()` prints "these were absent from the survey, so no rule scored them". A source whose
`php -v` exited non-zero and a source that simply has no `nodes` count produce the same shape of
report.

**G24. Nothing in drangler reads the degradation headers.**
`worker/src/ops/degrade.ts` bands on rows-written and DO-requests fractions at `REDUCE_AT = 0.8` and
`READ_ONLY_AT = 0.95`, and every response off `normal` carries `x-cfw-degrade`,
`x-cfw-degrade-driver` and `x-cfw-degrade-at`. `src/health/probe.ts` collects every `x-cfw-*` header
into `cfw` but names none of these, so `health` prints them in the untyped `headers` block and no
verdict reads them. A site in `read-only` answers 503 to every non-GET and `classify()` calls that
`degraded` with no reason attached.

---

## 2. Section A: Docker Emulation Rig

### 2.1 What Exists

drangler already has `docker/compose.yml` with two digest-pinned services:

| service  | image                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| `db`     | `mariadb@sha256:a02fe89cb597d4375812b2eac90cf9d0775d4686daa7f7cc750ebbcad7525bbc` |
| `drupal` | `drupal@sha256:369ec2a0bb23e1d6b4a378fbe15e36b52def0bb145c1821b8b33e28c3ec1b490`  |

`docker/drupal/entrypoint.sh` installs `openssh-server` and drush at container start, plants
`SSH_PUBLIC_KEY`, installs Drupal, and touches `/opt/drangler-ready` for the healthcheck.
`tests/e2e/helpers/stack.ts` mints the keypair; `helpers/docker.ts` `dockerGate()` implements the
skip-locally / fail-under-`REQUIRE_DOCKER` asymmetry. The worker half is not Docker:
`helpers/worker.ts` boots `tests/e2e/fixture-worker/` under `wrangler dev --persist-to` on a scratch
directory it deletes.

### 2.2 What Phase 6 Needs On Top

Three things, and only one of them is a container.

**A broken-VPS arm.** Same image digest, second service, `profiles: ['broken']`, its own ports and
its own entrypoint. No new image and therefore no new digest to resolve. One container covers every
fault because the fault is selected by an environment variable:

```yaml
vps-broken:
  profiles: ['broken']
  image: drupal@sha256:369ec2a0bb23e1d6b4a378fbe15e36b52def0bb145c1821b8b33e28c3ec1b490
  depends_on:
    db:
      condition: service_healthy
  environment:
    DRUPAL_DB_HOST: db
    DRUPAL_DB_NAME: drupal
    DRUPAL_DB_USER: drupal
    DRUPAL_DB_PASSWORD: drupalpass
    SSH_USER: tester
    SSH_PUBLIC_KEY: ${DRANGLER_E2E_SSH_PUBKEY:-}
    DRANGLER_FAULT: ${DRANGLER_FAULT:-none}
  entrypoint: ['/bin/bash', '/opt/drangler/broken-entrypoint.sh']
  volumes:
    - ./drupal:/opt/drangler:ro
  healthcheck:
    test: ['CMD', 'test', '-f', '/opt/drangler-broken-ready']
    interval: 5s
    timeout: 5s
    retries: 180
  ports:
    - '127.0.0.1:8181:80'
    - '127.0.0.1:2223:22'
```

`docker/drupal/broken-entrypoint.sh` installs sshd exactly as the healthy one does, so the transport
always works and only the site is broken, then plants one fault:

| `DRANGLER_FAULT` | what it plants                                              | which detector it exercises |
| ---------------- | ----------------------------------------------------------- | --------------------------- |
| `db-unreachable` | rewrites `settings.php` with a database password that fails | `source.db-unreadable`      |
| `files-missing`  | `rm -rf sites/default/files`                                | `source.files-missing`      |
| `php-broken`     | plants a `php.ini` naming an extension that does not exist  | `source.php-dead`           |
| `drush-absent`   | removes the drush symlink and `vendor/bin/drush`            | `source.drush-absent`       |
| `bootstrap-fail` | truncates `settings.php` after the opening tag              | `source.bootstrap-fail`     |

**Every fault is planted in the container, never by patching drangler.** That is the rule
`tests/e2e/detector.spec.ts` already enforces for the converter, stated once more here because the
same temptation exists: making `runSurvey()` return an error is a test that the error branch
formats, not that the survey notices.

**The sshd stays healthy in every fault.** A container that refuses ssh tests `TransportError`,
which the unit lane already covers with a scripted exit 255. What it cannot test is a reachable host
whose Drupal is broken, which is what a support call looks like.

**A drupflare site drangler can heal against.** Two arms, and the split is what each one is worth:

- **The fixture worker**, extended. `tests/e2e/fixture-worker/src/worker.ts` already speaks
  `/serve`, `/export` with the owner tier and the `x-cfw-*` headers. It gains `/health`, `/updb`,
  `/replica` and the degradation headers, emitting the same envelopes the real object emits. This
  covers "drangler parses the envelope and reaches the right verdict" for every state in section D,
  including the ones that are hard to produce on a real site (quarantine at three strikes, a halted
  updb run, a withdrawn lane).
- **The real worker, once, behind its own gate.** One spec, `tests/e2e/heal-real.spec.ts`, gated on
  a new `REQUIRE_WORKER`. It clones and hydrates `drupflare/worker` the way
  `workspace-clone.spec.ts` already does, boots it under `wrangler dev --local`, claims the site,
  and asserts that the `/health` and `/updb` envelopes drangler parses are the ones the real object
  emits. It asserts shape rather than state, because reaching quarantine on a live site needs three
  consecutive critical findings and a spec should not manufacture those.

  This is the check that stops the fixture from becoming a second, drifting definition of the
  contract, which is exactly the failure `worker/tests/e2e/README.md` records for the tier
  vocabulary ("the first version of the assertion was guessed").

**No `docker/drangler.yml`.** A second compose file would mean a second project name, a second
network and a second `dockerGate()`. A profile on the existing file costs one `--profile broken`
argument in `helpers/stack.ts` and nothing else. `docker compose --profile broken up -d vps-broken`
is the whole delta.

### 2.3 Gates and Skips

Four gates now, each naming its own requirement:

| gate             | covers                                             | specs                             |
| ---------------- | -------------------------------------------------- | --------------------------------- |
| `REQUIRE_CLONE`  | the network and a readable `drupflare/worker`      | `workspace-clone.spec.ts`         |
| `REQUIRE_DOCKER` | a Docker daemon and the healthy stack              | survey, to-worker, to-vps, doctor |
| `REQUIRE_BROKEN` | the `broken` profile is up                         | `doctor-source.spec.ts`           |
| `REQUIRE_WORKER` | a hydrated `drupflare/worker` under `wrangler dev` | `heal-real.spec.ts`               |

`REQUIRE_BROKEN` is separate from `REQUIRE_DOCKER` because the profile is opt-in: a developer who
brought the stack up to run the converter should not have a second Drupal install start. Same
reasoning `helpers/docker.ts` already gives for gating on `REQUIRE_DOCKER` rather than on `CI`.

The skip helper is one function beside `dockerGate()`:

```ts
export async function profileGate(service: string, requireVar: string): Promise<boolean> {
  if (await dockerGate()) return true;
  if (await stackRunning(service)) return false;
  if (process.env[requireVar]) {
    throw new Error(
      `e2e: ${service} is not running, and ${requireVar} says this lane has it.\n` +
        `  docker compose --profile broken up -d --wait ${service}`
    );
  }
  return true;
}
```

**Both directions are verified, and the counts go in `tests/e2e/README.md`.**
`worker/tests/e2e/README.md` records this as a discipline rather than a nicety: "container up gives
`4 passed`, container stopped gives `4 skipped`". Phase 6 records the same pair for
`REQUIRE_BROKEN` and for `REQUIRE_WORKER`, measured rather than predicted, and the numbers are
counted at the time rather than quoted from this document.

`.github/workflows/e2e.yml` gains two jobs. The broken job reuses the `db` service and takes roughly
the same install time as the healthy one; the worker job is the expensive one because it hydrates.
Both stay nightly and dispatch, not push.

---

## 3. Section B: Migration Under Production Traffic

A migration that assumes a quiet source is a migration for a site nobody uses. What follows is what
breaks, then the mechanism, then what cannot be made safe.

### 3.1 What Breaks

| hazard                     | mechanism                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| content after the snapshot | `drush sql:dump` reads a point in time; every node, comment, user and file created after it is not in the dump                                                                                                                     |
| sessions                   | `sessions` rows minted on the source stay valid there. On the target they are signed against a different `hash_salt`, so they neither work nor fail visibly, and a visitor sees an intermittent logged-out state                   |
| sequence drift             | `sequences` is `AUTHORITATIVE` (`worker/src/ops/state-inventory.ts:168`). Copying rows without re-seeding it makes the first new node on the target collide with a row the delta pass brought over                                 |
| driver lane arithmetic     | the shipped `settings.php` carries `'lane'` and `'lanes'` (`worker/src/site-do.ts:1365`), so the driver mints ids from a residue class. A delta that inserts source-chosen ids has to state them rather than let the driver append |
| files mid-copy             | `rsync` is not atomic. A `file_managed` row whose bytes have not arrived is a broken image; a file with no row is dead weight                                                                                                      |
| cron during cutover        | the source's crontab keeps draining queues, importing feeds and indexing search while the dump is being converted, and every one of those is a write                                                                               |
| a config change mid-copy   | `config` is dumped as rows. An editor saving a view between the dump and the cutover loses it silently                                                                                                                             |

### 3.2 The Mechanism

**A read-only window with a delta pass that narrows it, not a delta pass that removes it.**

Phase 1, source serving normally:

1. `migrate survey --out survey.json`
2. `migrate eligibility --to workers` (section E) must reach `GO` or `GO WITH CHANGES`
3. `drush sql:dump` on the source
4. `secrets scan` on the dump and on `settings.php`
5. `migrate convert --from mysql --to sqlite`
6. `rsync` the files directory, first pass
7. `migrate install --db ... --repack` into the workspace
8. `deploy` to a name that is not yet the live hostname
9. `site claim`, then `health` and `status` against the new deployment

Phase 2, the window:

1. `drush state:set system.maintenance_mode 1` on the source, and stop its crontab
2. `rsync` the files directory, **second pass, before the database** - a file with no row is
   harmless and a row with no file is a 404
3. a second `drush sql:dump`, this time of the delta table set (below)
4. `migrate convert`, `migrate install --db`, `deploy`
5. wait for the pack replay: `GET /serve?edge=0` until `x-cfw-migrate` is absent
6. flip DNS
7. `drush state:set system.maintenance_mode 0` is **not** run; the source stays in maintenance mode
   as the rollback target

**The delta table set.** There is no global LSN in Drupal and no binlog on a shared host, so the
delta cannot be computed from a marker. It is the whole of the tables classified `AUTHORITATIVE` in
`worker/src/ops/state-inventory.ts`, minus the three that must never cross:

- `sessions` - dropped. Everyone logs in again. This is the documented cost.
- `semaphore` and `flood` - `REGENERABLE_TABLES` on the way out for the same reason they are
  regenerable on the way in.
- `watchdog` - `PRIMARY_ONLY_SIDE_EFFECT`; a log is not state.

`sequences` is copied **and then re-seeded** to above the highest id in the copied set. That is the
one arithmetic step in the whole procedure and it is the one that fails silently if skipped.
`worker/src/db/export-sql.ts` already reads integers through `hex()` for the same class of reason;
the re-seed is a separate statement, not a copied row.

### 3.3 What drangler Does and What Needs a Worker Route

| step                             | who                                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| compute the delta table set      | `[D]` from `state-inventory.ts`'s classification, invoked, not copied |
| drive both dumps and both rsyncs | `[D]`, through the existing `Transport`                               |
| convert and install              | `[D]`, unchanged                                                      |
| re-seed `sequences`              | `[D]`, a statement appended to the converted delta                    |
| apply the delta into a LIVE site | **nobody. Refused; see section 9**                                    |
| watch the pack replay            | `[D]` against `x-cfw-migrate`, no new route                           |
| print and check the checklist    | `[D]`                                                                 |

**No new worker route.** The delta lands in the workspace pack and reaches the site through a
deploy, exactly as the first pass does. The alternative is a route that applies arbitrary SQL to a
live object, which is `/restore` with a smaller blast radius and the same shape, and the asymmetry
between "you may take your data out" and "you may push SQL in" is the security property this project
has stated three times.

The cost of that decision, stated: the window includes a `wrangler deploy` and a chunked pack replay
rather than a single transaction. It is minutes, not seconds.

### 3.4 What Cannot Be Made Safe

- **Writes accepted by the source between the last dump read and maintenance mode.** There is no
  mechanism that catches them. The window exists to make the set empty.
- **A visitor mid-form at cutover.** Their `form_build_id` was minted against the source's
  `hash_salt` and the target mints its own, so the POST fails. Maintenance mode makes this a
  maintenance page instead of a silent token rejection, which is why the window starts with it.
- **Anything the source's cron was part way through.** A queue item claimed and not released is
  claimed on the source forever and absent from the target.

`drangler migrate cutover --checklist` prints these as steps a human confirms, and refuses to print
a "done" verdict for any of them. A checklist that ticks itself is a checklist nobody reads.

---

## 4. Section C: Mid-Migration Flakes

### 4.1 What Is Checkpointed

One file, `migration.json`, written beside the artifacts and named by `--checkpoint <file>`. It
defaults to `.drangler/migration.json` under the working directory and is created by
`migrate survey`, because that is the first command in the sequence.

```jsonc
{
  "version": 1,
  "fingerprint": "9f2c1ab4...",
  "direction": "to-worker",
  "startedAt": "2026-09-08T11:04:22Z",
  "phases": {
    "survey": { "state": "done", "artifact": "survey.json", "sha256": "..." },
    "export": {
      "state": "partial",
      "artifact": "worker.sql",
      "sha256": "...",
      "cursor": { "phase": "rows", "table": "node_field_data", "offset": 4200 }
    },
    "convert": { "state": "pending" },
    "install": { "state": "pending", "backupDir": null }
  }
}
```

`state` is `pending` / `partial` / `done` / `failed`. `sha256` is over the bytes on disk at the
moment the phase ended, so a resume can tell "the file I wrote" from "a file somebody edited".

### 4.2 The Fingerprint

**A resume must prove it is the same migration.** `surveyFingerprint(survey)` is sha256 over the
survey serialised with sorted keys, with `capturedAt` and `errors` removed - those move between runs
of the same survey against the same host and would make every fingerprint disagree.

`--resume` against a checkpoint whose fingerprint differs from the survey on disk exits `2` and
prints both, naming which field differs. It does not offer `--force`: two migrations spliced
together produce a database that looks whole and is not, which is the same failure
`worker/src/site-do.ts:10130` already refuses with a 409 for a spliced dump.

### 4.3 Per-Command Resumability

| command   | checkpointed     | what `--resume` does                                             | terminating observation                     |
| --------- | ---------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `survey`  | the survey JSON  | re-runs only the steps with neither a value nor a recorded error | every step has a value or an error          |
| `export`  | the `DumpCursor` | continues from the cursor through `/export?cursor=`              | the chunk that reports the dump is complete |
| `convert` | nothing          | re-runs; it is pure and the input is on disk                     | -                                           |
| `install` | the backup dir   | reports the existing backup and refuses to take a second over it | `applyCopy()` returns                       |
| `restore` | nothing          | re-runs; it verifies the whole set before the first write        | -                                           |

**`convert` is not checkpointed.** It reads a file and writes a file with no network
and no clock. Checkpointing a pure function costs a file to keep correct and buys a re-run that was
already cheap.

**`export` carries the whole mechanism**, and G20 is what makes it cheap: the worker's chunked dump
already exists and drangler does not use it. `--resume` sends the recorded cursor; a 409 from the
route means the site's data moved under the dump and the resume is refused rather than spliced.

### 4.4 Retries Terminate on an Observation

The house rule is that a retry loop needs a terminating observation, not just a bound. The worker
records what happens without one: `/user/password` renders, cannot be stored, is re-queued, and on
an idle object never converges - fixed by `noteStorable()` / `isUnstorable()` recording a verdict.

Applied here:

- **SSH.** `sshTransport()` retries a step at most three times, and only when `result.code === 255`
  with stderr matching a transport-level failure. The observation is "this step produced output".
  A step that fails three times with the same stderr is recorded in `survey.errors[]` and the survey
  continues, which is already `runSurvey()`'s behaviour for a single failure.
- **`export --resume`.** The observation is the cursor advancing. A chunk that comes back with the
  same cursor is not retried; it is a `export-stalled` error naming the table.
- **The pack replay wait in `site upgrade`.** The observation is `x-cfw-migrate` counting up. A
  chunk number that has not moved across `--stall-after` (default 120 s) exits `3` with the chunk
  and the state, rather than waiting out `--timeout` and reporting a timeout that says nothing.

Bounds still exist. They are the second condition, not the only one.

---

## 5. Section D: Shattered State, Both Sides

Two commands. `drangler doctor --source <ssh-target>` scores a VPS; `drangler doctor --site
<origin>` scores a drupflare deployment. `drangler heal` is the write half and is section F.

Both keep PLAN-MODIFY's rule that bare `doctor` is unchanged and looks at nothing on disk and
nothing on the network beyond `wrangler whoami`.

### 5.1 VPS Source States

Every one of these is detectable from commands `surveyPlan()` already issues. What is missing is a
verdict on them (G23), not a new connection.

| id                        | detected by                                                                                 | auto-repair |
| ------------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| `source.php-dead`         | `php -v` non-zero; a required step                                                          | no          |
| `source.drush-absent`     | `drush --version` non-zero; already `drush-absent` at warning severity                      | no          |
| `source.bootstrap-fail`   | `drush status --format=json` parses but carries no `drupal-version`                         | no          |
| `source.db-unreadable`    | `drush status` returns with no `db-driver`, or `drush sql:query "SELECT 1"` non-zero        | no          |
| `source.files-missing`    | `du -sk <root>/sites/default/files` non-zero, currently silent because the step is optional | no          |
| `source.files-unreadable` | `du` succeeds and the file count returns 0 on a site with `file_managed` rows               | no          |
| `source.root-wrong`       | `drush status` succeeds but its `root` differs from `--root`                                | no          |

**None of them is auto-repairable.** drangler is read-only against a VPS by construction
(`tests/migrate-survey.spec.ts` asserts no survey step matches a mutating verb). Repairing somebody's
production Drupal over ssh is a different product.

`doctor --source` renders them and exits `3`. `migrate plan` and `migrate eligibility` treat any
`source.*` finding as a blocker, which closes G23: a survey with `php -v` in `errors[]` currently
scores as "not measured" and reaches `GO`.

Two of these need a new survey step, and both are cheap and read-only:

- `drush sql:query "SELECT 1"` - separates "no driver reported" from "driver reported, database
  refuses".
- `drush sql:query "SELECT COUNT(*) FROM file_managed"` - the control that makes
  `source.files-unreadable` mean something. Zero files and zero rows is a site with no uploads;
  zero files and 4,000 rows is a missing volume.

### 5.2 drupflare Target States

Each row names the worker code that owns the state.

| id                           | owner                                                                | detected by                                                                       | verdict                                           |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `site.quarantined`           | `ops/repair.ts` `isQuarantined()`, `QUARANTINE_STRIKES = 3`          | `GET /health` `.quarantined`, `.repair.code`, `.repair.strikes`                   | repairable, `--yes`                               |
| `site.rollback-pending`      | `ops/repair.ts` `shouldRollback()`                                   | `GET /health` `.rollback.{rollback,reason}`                                       | **report only**                                   |
| `site.updb-halted`           | `ops/updb.ts` `updbStatus()`, phase `halted`; tripwire `updbHalted`  | `GET /updb` `.phase`                                                              | report; a halt holds the chain until a human acts |
| `site.updb-behind`           | `ops/updb.ts` `readRun()` / `UPDB_PHASES`                            | `GET /updb` phase `planning` or `running` with a stationary cursor                | repairable, `--yes`, one beat                     |
| `site.replay-stuck`          | `site-do.ts` `migrateChunks()`; tripwire `migrateIncomplete`         | `x-cfw-migrate` and `x-cfw-migrate-state` on `/serve?edge=0`                      | repairable, unattended                            |
| `site.page-store-empty`      | `ops/page-store.ts`; the `max_age = 0` history in `worker/CLAUDE.md` | N requests to one stable path never yield `x-cfw-cache: HIT`                      | **report only**                                   |
| `site.replica-fenced`        | `ops/replica.ts` `fenceAllows()`, `replica-admission.ts` stages      | `GET /replica` stage not `SERVING`, or applied generation behind                  | repairable when `WITHDRAWN`                       |
| `site.container-cid-stale`   | `scripts/fix-container-cid.ts`, `tests/node/container-cid.spec.ts`   | **local**: the workspace pack's `VERSIONS_HASH` against its `cache_container` row | report; fix is in the workspace                   |
| `site.revision-half-applied` | PLAN-MODIFY 5.2 `commit` `{rolledBack}`, `cfw_module_rev.active`     | `GET /modify?action=status` names an active rev whose blobs are incomplete        | repairable, `--yes` (needs W21-W23)               |
| `site.preview-pinned`        | `site-do.ts:4014, 4128, 4181, 4418, 9920` `git_previewof_*`          | `GET /git` reports `previewOf` non-null on a remote                               | repairable, `--yes`                               |
| `site.degraded`              | `ops/degrade.ts` `REDUCE_AT`, `READ_ONLY_AT`                         | `x-cfw-degrade`, `x-cfw-degrade-driver`, `x-cfw-degrade-at`                       | **report only**; clears at UTC midnight           |
| `site.fill-stalled`          | `site-do.ts` `queueDepth()`, `/armfill`                              | `x-cfw-queue-depth` above 0 across `--stall-after` with no generation move        | repairable, unattended                            |
| `site.unclaimed`             | `site-do.ts` `/__firstrun`                                           | `probeClaim()`, already implemented                                               | report; `site claim` is the fix                   |

Three of the report-only rows, with their reasons:

- **`site.rollback-pending`.** `shouldRollback()` refuses far more often than it agrees and every
  refusal names a mechanism. `heal` prints the decision and that mechanism and stops there.
- **`site.page-store-empty`.** The cause `worker/CLAUDE.md` records is
  `system.performance:cache.page.max_age` at 0 in the shipped pack, with `cache_config` holding its
  own shadow copy. Neither is reachable from an owner route, and both are in the workspace. A CLI
  that offered to fix this would be offering to fix a file it cannot see.
- **`site.container-cid-stale`.** Detectable only against a workspace, because the check compares
  `drupal-src`'s `DrupalInstalled::VERSIONS_HASH` against the `cache_container` cid in
  `assets/drupal/site.sqlite`. `doctor --site` says "not checked; needs --workspace" rather than
  passing it.

### 5.3 Report Shape

```text
$ drangler doctor --site https://mysite.example
site           https://mysite.example
reachable      yes
answered by    MISS
generation     41
worker version 8c31f0a2 (v37, 2026-09-07T22:10:04Z)
degraded       reduced (rows-written at 0.83 of 1.00)

findings
  error    site.quarantined       bridge.asyncify_called, 3 of 3 strikes, 48m
  warning  site.fill-stalled      queue depth 12, generation unchanged for 6m
  note     site.degraded          cron, queue, watchdog and image regeneration are off

not checked
  site.container-cid-stale   needs --workspace
  site.revision-half-applied /modify is not on this worker

next
  drangler heal https://mysite.example --release --yes
```

`not checked` is its own block for the reason `migrate plan` already separates `unknowns`: a check
that did not run and a check that passed are different facts, and collapsing them is what makes a
report a guess.

---

## 6. Section E: Bidirectional Eligibility

`drangler migrate eligibility` replaces the scoring half of `migrate plan`. `migrate plan` keeps the
ordered steps and calls into it; the two currently share one function and one exit code for two
different questions.

```text
drangler migrate eligibility
  --to <workers|vps|both>    default: both when both inputs are present
  --survey <file>            the VPS side
  --site <origin>            the drupflare side
  --token <token>            owner token, for the /export envelope
  --workspace <dir>          enables the checks that need the pack
  --json
```

### 6.1 VPS to drupflare

The existing `to-worker` rules already read the survey, so this direction mostly needs the
corrections G17-G19 name plus one new criterion set. Criteria, each with the field that backs it:

| criterion            | evidence                                              | verdict effect                              |
| -------------------- | ----------------------------------------------------- | ------------------------------------------- |
| database driver      | `survey.database.driver`                              | blocker outside the MySQL family and SQLite |
| PHP version          | `survey.php.version` against `TargetRuntime`          | warning when older                          |
| archive extensions   | `survey.php.extensions` for `zip` / `Phar`            | warning                                     |
| incompatible modules | `survey.modules` against `INCOMPATIBLE_MODULES`       | blocker                                     |
| service modules      | `survey.modules` against `SERVICE_MODULES`            | warning                                     |
| database size        | `survey.database.bytes` against the statement ceiling | warning                                     |
| file payload         | `survey.files.kb`, `survey.files.count`               | warning                                     |
| image transforms     | `survey.imageStyles` x `survey.files.count`           | warning                                     |
| regeneration ceiling | `survey.nodes` against `LIMITS.rendersPerDay*`        | see G13; needs a provenance                 |
| source health        | any `source.*` finding from section D                 | **blocker**                                 |
| outbound needs       | `survey.modules` against the park's capability list   | new; see below                              |
| authenticated share  | not measurable from a survey                          | **unknown, and says so**                    |

**Outbound needs** is the criterion PLAN-MODIFY's W4 opens. `drupal/redis` is `verified` on the
worker because the Zend park serves a blocking socket, and `search_api_solr`'s blocker was a
transitive `php-64bit` that `PHP_INT_SIZE = 8` now satisfies. What a survey can say is which enabled
modules need an outbound socket at all; what it cannot say is whether the site's Redis or Solr host
is reachable from Cloudflare's network. That is a `warning` with a named next step, not a pass.

**Authenticated share** cannot be measured here. `worker/scripts/measure/auth-share.ts` and
`plan-auth-census.ts` measure it from access logs, which a survey does not read. The criterion is
listed and reported as unknown rather than dropped, because it is the input to whether the edge-plan
tier will ever compile - and `worker/CLAUDE.md` records that a single-editor site never gets one.

### 6.2 drupflare to VPS

This direction has no measurement today (G18). Every criterion below is read from a real envelope.

| criterion               | evidence                                                              | verdict effect                            |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| the export is reachable | `GET /export?body=1` with the owner token: 200, 401 or 404            | blocker on 401 or 404                     |
| the dump is replayable  | the envelope's `replayable` and `maxStatementChars`                   | blocker when false                        |
| what leaves with rows   | the envelope's `tables` map                                           | note, listed                              |
| what leaves as schema   | the envelope's `structureOnly`                                        | note, listed                              |
| secrets in the dump     | whether `?secrets=1` was asked for; `SECRET_META_KEYS` names the four | warning either way                        |
| managed file bytes      | `cfw_file` and `cfw_file_chunk` row counts in the envelope's `tables` | **blocker**: nothing unpacks them         |
| drupflare-only tables   | the `cfw_*` set, from `state-inventory.ts` `LOCAL_TABLES`             | note; they are dropped                    |
| service substitutions   | `core.extension` in the dump lists `drupflare` and `cfw_do_sqlite`    | blocker until swapped                     |
| password hashing        | `$settings['drupflare.argon2']` in the deployed settings              | blocker when on and the VPS has no argon2 |
| hash salt               | the pack ships an empty `hash_salt`; the object mints one per site    | note; a VPS mints its own                 |
| PHP version on the VPS  | `survey.php.version` against the version the dump was written under   | warning when older                        |

**The substitution list is enumerated rather than summarised**, because a user has to change every
entry by hand. Each one is a class or a settings key read out of `drupflare/drupflare`:

| what the site runs on drupflare                        | what a VPS has to swap back                   |
| ------------------------------------------------------ | --------------------------------------------- |
| `Drupal\drupflare\Cache\CfwCacheBackendFactory`        | `cache.backend.database`                      |
| `Drupal\drupflare\Lock\CfwLockBackend`                 | `Drupal\Core\Lock\DatabaseLockBackend`        |
| `Drupal\drupflare\Logger\CfwLogger`                    | `dblog` or `syslog`                           |
| `Drupal\drupflare\Plugin\Mail\CfwMail`                 | `php_mail`, or the `smtp` module              |
| `Drupal\drupflare\Plugin\ImageToolkit\CfwImageToolkit` | `image.settings:toolkit` back to `gd`         |
| `Drupal\drupflare\Search\SolariumTransport`            | Solarium's own transport                      |
| `Drupal\drupflare\Config\MailInterfaceOverride`        | removed with the module                       |
| `Drupal\drupflare\Http\ParkFetchHandler`               | plain `Guzzle`                                |
| the `cfw_do_sqlite` driver block in `settings.php`     | a real `mysql` or `sqlite` `$databases` entry |
| `$settings['drupflare.argon2']`                        | removed; see the password row above           |
| `$settings['trusted_host_patterns']`                   | rewritten for the VPS hostname                |
| `$settings['hash_salt']` empty                         | a locally generated salt                      |
| `$settings['config_sync_directory']`                   | a real directory that survives a boot         |

`migrate eligibility --to vps --json` emits this as a `substitutions` array so a script can act on
it, and the text render prints it as the table above.

**The managed-file criterion is a blocker rather than a warning.** The bytes are in the dump and no
tool writes them back to a filesystem, so a user who acted on a warning would arrive at a VPS with
every upload missing. Section H adds `migrate files --from-dump`; until it lands the criterion stays
a blocker with that reason attached.

### 6.3 Verdicts

| verdict           | means                                                             | exit |
| ----------------- | ----------------------------------------------------------------- | ---- |
| `GO`              | no blocker, no warning, and every criterion reached a measurement | `0`  |
| `GO WITH CHANGES` | no blocker, at least one warning, every criterion measured        | `3`  |
| `NO`              | at least one blocker                                              | `3`  |
| no verdict        | a criterion could not be measured at all                          | `1`  |

The fourth row is why the exit set has four values. A criterion that
could not be measured is `1` (the check could not run), never a `GO` with a caveat. `--assume-worst`
turns every unmeasured criterion into a blocker and produces a `NO` with a reason - for a script
that must have a verdict.

`GO WITH CHANGES` and `NO` share exit `3`, which is correct under the closed set: both are "the
check ran and found something". The distinction lives in `.verdict` in the JSON, and `--require go`
makes a `GO WITH CHANGES` exit `3` where a bare run would have too. There is no fifth exit code.

**Evidence is carried, never summarised.** Every finding gains an `evidence` field naming the survey
field, the envelope key or the header it was read from. A verdict whose evidence a reader cannot
follow back to a byte is the class of claim this workspace has recorded being wrong about nine
times.

---

## 7. Section F: Safer Repairs

### 7.1 The Three Classes

Every repair falls into one of three classes and the class decides the gate.

- **Idempotent and costless.** Re-running it changes nothing that was not already going to change.
  Allowed under `--auto`, still needs `--yes`.
- **Costs a meter.** It spends rows written or DO requests. Needs `--yes` and respects
  `x-cfw-degrade`: a site in `reduced` or `read-only` refuses these with the driver named.
- **Changes what the site serves or what its schema is.** Needs `--yes` **and** an explicit snapshot
  decision: `--snapshot <dir>` takes an `/export` first, `--no-snapshot` states that it was
  declined. There is no default, because a default here is a decision made silently.

### 7.2 The Table

| repair                  | route                          | class    | precondition                                   | rollback                                                | blast radius                                          |
| ----------------------- | ------------------------------ | -------- | ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| clear quarantine        | `GET /health?clear=1`          | costless | `.quarantined` true                            | re-quarantines after 3 more strikes                     | one site; serves whatever the quarantine was stopping |
| resume pack replay      | `POST /migrate`                | costless | `x-cfw-migrate` present                        | none; the cursor only advances                          | none                                                  |
| re-arm a stalled fill   | `POST /armfill`                | meter    | `queueDepth() > 0`, no generation move         | none                                                    | rows written by the drain                             |
| purge one path          | `POST /invalidate`             | meter    | none                                           | none                                                    | one path re-renders                                   |
| bump the generation     | `POST /bump`                   | meter    | none                                           | none                                                    | **the whole site re-renders**                         |
| drive one updb beat     | `POST /updb?step=1`            | schema   | phase not `halted`                             | `updbRollback()` exists and is unreachable from a route | one site's schema; a beat can be a `hook_update_N`    |
| readmit a lane          | `POST /replica?action=readmit` | meter    | stage `WITHDRAWN`                              | none; it re-queues a copy                               | the primary's row budget for a full copy              |
| clear a preview pin     | `POST /git`                    | serves   | `previewOf` non-null                           | re-pin by re-previewing                                 | the poller and webhook resume replacing the tree      |
| activate a revision     | `POST /modify?action=activate` | serves   | the rev exists and its blobs are complete      | `modify rollback`                                       | what the site serves                                  |
| force a rollback        | -                              | -        | **refused**                                    | -                                                       | -                                                     |
| point-in-time recovery  | `/pitr`                        | -        | **refused**; diagnostic-only, 30 days, no undo | -                                                       | -                                                     |
| recycle the interpreter | -                              | -        | **refused**; must run between invocations      | -                                                       | -                                                     |

`bump` is the one meter-class repair whose blast radius is the whole site, so
`heal --bump --yes` prints the page count it will invalidate before it runs, read from
`/serve-stats` when reachable and from `x-cfw-generation` movement when it is not.

### 7.3 The Updb Beat

`POST /updb?step=1` "advances exactly ONE beat and re-arms nothing" (`worker/src/site-do.ts:9512`).
A beat can execute a `hook_update_N`, which writes schema. Three rules:

1. `site updb --step` runs one beat. `--steps <n>` runs at most n, and there is no unbounded loop.
2. Every beat re-reads `updbStatus()` and stops on `halted`, `rolled_back` or `abandoned` without
   consuming the remaining count.
3. A run with `--steps` above 1 requires `--snapshot <dir>` or `--no-snapshot`. `updbRollback()`
   exists on the worker and no route reaches it, so the only rollback available to a CLI is the
   snapshot it took.

`updbStatus()` is the terminating observation. A beat that returns with the cursor unmoved is
`updb-stalled`, exit `3`, naming the unit.

### 7.4 What `heal` Does Unattended

Nothing that writes. Bare `heal <target>` reports and exits `3` when quarantined or when a rollback
is pending. `heal --watch` re-reads on `--interval` and still writes nothing.

`--auto` is the closest thing to unattended repair and it is narrow: it performs only
the costless class (clear quarantine, resume replay), still needs `--yes`, and stops on the first
finding outside that class. A `--auto` that escalated would be a supervisor, and the object already
has one.

**`release()` is documented "explicit, never automatic"** (`worker/src/ops/repair.ts:145`). `--auto`
clearing quarantine is explicit: the user typed `--auto --yes`. `--watch` clearing it on its own
would not be, and does not.

---

## 8. Section G: Error Handling

### 8.1 What It Prints Today

Read out of the real catch blocks:

| path                         | what a user sees                                   |
| ---------------------------- | -------------------------------------------------- |
| `run.ts:24` `DranglerError`  | `drangler: <message>` on stderr, exit `e.exitCode` |
| `run.ts:27` anything else    | **the full stack** on stderr, exit 1 (G21)         |
| `run.ts:17` `CommanderError` | commander's own text, exit 0 for help, 2 otherwise |
| `probe.ts:187`               | `ProbeError` wrapping the raw fetch message        |
| `transport.ts:48`            | `TransportError` with ssh's stderr or `no detail`  |
| `build.ts:190-197`           | two prose lines on **stdout**, then a throw (G22)  |
| `copy.ts:120`, `copy.ts:197` | a `DranglerError` naming the file and the digest   |
| `migrate.ts:240-266`         | four distinct export codes with real next steps    |

The export codes are the model the rest should follow: `export-unauthorized` says where the token
comes from, `export-missing` distinguishes an old worker from a closed route, `export-unreplayable`
names the ceiling. Nothing else in the CLI is that specific, and none of it is machine-readable
because `--json` prints nothing on the error path.

### 8.2 The Model

Four fields on `DranglerError`, two of them new:

```ts
export class DranglerError extends Error {
  readonly code: string;
  readonly exitCode: number;
  /** whether re-running the same command could succeed without anything else changing */
  readonly retryable: boolean;
  /** the command to run next, or null when there is not one */
  readonly next: string | null;
}
```

- **`retryable` is about the operation, not the network.** A 503 from a warming site is retryable; a
  401 is not, even though both are transient in the sense that they may stop happening.
- **`next` is a command, never advice.** `drangler site claim https://...` is a next step;
  "check your credentials" is not, and is left out.

Output contract:

| mode     | stdout                                                           | stderr                                                           |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| text     | nothing on the error path                                        | `drangler: <message>` and, when `next` is set, `next: <command>` |
| `--json` | one object: `{"ok":false,"error":{code,message,retryable,next}}` | progress only                                                    |

**Under `--json`, stdout parses on both paths.** A CI step should not have to branch on the exit
code before it can parse. On a failure the error object is the report, so "stdout carries the report
and nothing else" holds unchanged.

**No stack traces.** `run.ts` maps an unknown exception to code `internal`, exit `1`, and prints
`e.message` plus "re-run with --verbose for the stack". The stack goes to stderr only under
`--verbose`. G22's two stdout lines move to stderr and become the `next` field of the thrown error.

### 8.3 The Code Table

Existing codes, read out of the source, plus the new ones Phase 6 needs.

| code                     | exit | retryable | raised by                                                      | next                                     |
| ------------------------ | ---- | --------- | -------------------------------------------------------------- | ---------------------------------------- |
| `usage`                  | 2    | no        | `UsageError`, everywhere                                       | -                                        |
| `internal`               | 1    | no        | `run.ts`, unknown exception                                    | re-run with `--verbose`                  |
| `probe`                  | 1    | yes       | `probe.ts` `get()`                                             | `drangler status <target>`               |
| `transport`              | 1    | yes       | `transport.ts`, ssh 255                                        | -                                        |
| `convert`                | 1    | no        | `convert.ts`                                                   | `migrate convert --skip-unsupported`     |
| `workspace`              | 1    | no        | `layout.ts`                                                    | `drangler build`                         |
| `auth`                   | 1    | no        | `cloudflare/auth.ts`                                           | `wrangler login`                         |
| `backup`                 | 1    | no        | `copy.ts` `applyCopy()`                                        | -                                        |
| `restore`                | 1    | no        | `copy.ts` `restoreBackup()`                                    | -                                        |
| `refresh`                | 1    | yes       | `build.ts` `assertClean()`                                     | -                                        |
| `refresh-dirty`          | 1    | no        | `build.ts` `assertClean()`                                     | `git -C <ws> stash`                      |
| `refresh-diverged`       | 1    | no        | `build.ts` `fastForward()`                                     | -                                        |
| `build-step`             | 1    | yes       | `build.ts` `runPlan()`                                         | step-dependent                           |
| `repack`                 | 1    | yes       | `migrate.ts` `runInstallCommand()`                             | `cd <ws> && bun run assets:sql`          |
| `export-unauthorized`    | 1    | no        | `migrate.ts`                                                   | `drangler site claim <target>`           |
| `export-missing`         | 1    | no        | `migrate.ts`                                                   | `drangler update <worker>`               |
| `export-unreplayable`    | 1    | no        | `migrate.ts`                                                   | `migrate export --all` off               |
| `export-failed`          | 1    | yes       | `migrate.ts`                                                   | -                                        |
| **new in Phase 6**       |      |           |                                                                |                                          |
| `checkpoint-mismatch`    | 2    | no        | `--resume` fingerprint disagrees                               | drop `--resume`                          |
| `checkpoint-unreadable`  | 2    | no        | the checkpoint is not JSON                                     | delete it and re-run                     |
| `export-stalled`         | 3    | no        | a chunk returns the same cursor                                | `migrate export --resume`                |
| `export-torn`            | 1    | no        | the route answers 409 mid-cursor                               | restart the export                       |
| `source-broken`          | 3    | no        | any `source.*` finding                                         | `drangler doctor --source <target>`      |
| `site-quarantined`       | 3    | no        | `/health` `.quarantined`                                       | `drangler heal <target> --release --yes` |
| `site-degraded`          | 3    | yes       | `x-cfw-degrade` is `read-only`                                 | wait for the UTC reset                   |
| `updb-halted`            | 3    | no        | `updbStatus()` phase `halted`                                  | -                                        |
| `updb-stalled`           | 3    | no        | a beat leaves the cursor unmoved                               | -                                        |
| `replay-stalled`         | 3    | no        | `x-cfw-migrate` unmoved past `--stall-after`                   | `drangler heal <target> --replay --yes`  |
| `eligibility-unmeasured` | 1    | no        | a criterion reached no measurement                             | `migrate eligibility --assume-worst`     |
| `repair-refused`         | 2    | no        | a write repair without `--yes`, or without a snapshot decision | add `--yes`                              |
| `rig-unavailable`        | 1    | yes       | a gated e2e requirement is absent                              | the compose command for it               |

`retryable` is what a wrapper reads to decide whether to loop. Nothing in drangler loops on it
itself; the flag exists so a caller does not have to pattern-match on messages.

---

## 9. Section H: Work Plan

Ordered. Each item is one commit. Numbering continues from PLAN-MODIFY's W35.

### Phase 6a - the CLI is wrong about the platform, second pass

| #   | repo | what                                                                                                        | files                                           | test                                                                         |
| --- | ---- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| W36 | [D]  | correct `export-gated`: `/export` is an owner route, and the blocker is a missing token (G17)               | `src/migrate/rules.ts`                          | `tests/migrate-plan.spec.ts` - a `to-vps` plan has no `export-gated` blocker |
| W37 | [D]  | correct `export-files`: the bytes leave in `cfw_file_chunk`; the blocker is that nothing unpacks them (G19) | `src/migrate/rules.ts`                          | same spec                                                                    |
| W38 | [D]  | `KNOWN_HEADER_VERSION = 2`; read `x-cfw-account-plan` (PLAN-MODIFY W7, now unblocked)                       | `src/health/probe.ts`                           | `tests/health.spec.ts` - v1 and v2 both parse                                |
| W39 | [D]  | read the degradation headers into `ProbeResult`; `classify()` returns `degraded` with a driver (G24)        | `src/health/probe.ts`, `src/commands/health.ts` | `tests/health.spec.ts` - reduced, read-only and normal                       |

### Phase 6b - the error model

| #   | repo | what                                                               | files                          | test                                                                               |
| --- | ---- | ------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| W40 | [D]  | `retryable` and `next` on `DranglerError`; the code table from 8.3 | `src/errors.ts`                | `tests/errors.spec.ts` (new) - every code has both fields                          |
| W41 | [D]  | `run.ts`: no stack without `--verbose`; `internal` code (G21)      | `src/run.ts`, `src/program.ts` | `tests/cli.spec.ts` - a thrown `TypeError` prints no stack                         |
| W42 | [D]  | `--json` emits the error object on stdout on the failure path      | `src/run.ts`, `src/format.ts`  | `tests/cli.spec.ts` - stdout parses on both paths                                  |
| W43 | [D]  | move `build.ts`'s two stdout lines into the error's `next` (G22)   | `src/workspace/build.ts`       | `tests/workspace-build.spec.ts` - `build --json` stdout parses on a failed hydrate |

### Phase 6c - shattered state and the doctor split

| #   | repo | what                                                                                                                 | files                                            | test                                                    |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| W44 | [D]  | two read-only survey steps: `SELECT 1` and the `file_managed` count                                                  | `src/migrate/survey.ts`                          | `tests/migrate-survey.spec.ts` - still no mutating verb |
| W45 | [D]  | `sourceFindings(survey)`: the seven `source.*` states from 5.1                                                       | `src/health/source.ts` (new)                     | `tests/source.spec.ts` (new) - one case per state       |
| W46 | [D]  | `doctor --source <ssh-target>`; a `source.*` finding is a blocker in `plan` (G23)                                    | `src/commands/doctor.ts`, `src/migrate/rules.ts` | `tests/doctor.spec.ts` (new)                            |
| W47 | [D]  | `siteFindings()`: the thirteen `site.*` states from 5.2, from `/health`, `/updb`, `/replica`, `/git` and the headers | `src/health/site.ts` (new)                       | `tests/site-health.spec.ts` (new) - one case per state  |
| W48 | [D]  | `doctor --site <origin>`, with the `not checked` block                                                               | `src/commands/doctor.ts`                         | `tests/doctor.spec.ts`                                  |

### Phase 6d - repairs

| #   | repo | what                                                                                     | files                        | test                                                                       |
| --- | ---- | ---------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| W49 | [D]  | `heal <target>`: report, `--watch`, `--release --yes` (PLAN-MODIFY W15, extended by 7.2) | `src/commands/heal.ts` (new) | `tests/heal.spec.ts` (new) - quarantined, clean, rollback pending          |
| W50 | [D]  | the three repair classes and their gates; `--snapshot` / `--no-snapshot` refusal         | `src/health/repair.ts` (new) | `tests/heal.spec.ts` - a schema repair without a snapshot decision exits 2 |
| W51 | [D]  | `heal --replay`, `--armfill`, `--invalidate <path>`, `--bump`                            | `src/commands/heal.ts`       | `tests/heal.spec.ts` - `--bump` prints its blast radius first              |
| W52 | [D]  | `site updb --step` / `--steps <n>`, stopping on a terminal phase                         | `src/commands/site.ts`       | `tests/site.spec.ts` - halted stops mid-count                              |
| W53 | [D]  | `heal --readmit` and `heal --unpin`                                                      | `src/commands/heal.ts`       | `tests/heal.spec.ts`                                                       |
| W54 | [D]  | `heal --auto`: costless class only, stops at the first finding outside it                | `src/commands/heal.ts`       | `tests/heal.spec.ts` - stops on a schema finding                           |

### Phase 6e - resumable migration

| #   | repo | what                                                                       | files                                              | test                                                                                         |
| --- | ---- | -------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| W55 | [D]  | `surveyFingerprint()` and the `migration.json` schema from 4.1             | `src/migrate/checkpoint.ts` (new)                  | `tests/checkpoint.spec.ts` (new) - `capturedAt` does not move it                             |
| W56 | [D]  | `migrate export` through `?cursor=`, with `--resume` (G20)                 | `src/commands/migrate.ts`                          | `tests/migrate-export.spec.ts` (new) - a resumed dump equals a whole one                     |
| W57 | [D]  | `survey --resume`: re-run only the steps with neither a value nor an error | `src/migrate/survey.ts`, `src/commands/migrate.ts` | `tests/migrate-survey.spec.ts`                                                               |
| W58 | [D]  | the ssh retry, terminating on "the step produced output"                   | `src/migrate/transport.ts`                         | `tests/migrate-transport.spec.ts` - three identical 255s record an error rather than looping |
| W59 | [D]  | `install --resume` reports the existing backup and refuses a second        | `src/commands/migrate.ts`, `src/workspace/copy.ts` | `tests/workspace-copy.spec.ts`                                                               |

### Phase 6f - eligibility and cutover

| #   | repo | what                                                                             | files                                                       | test                                                                                             |
| --- | ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| W60 | [D]  | `migrate eligibility`, the verdict set and the four exit mappings from 6.3       | `src/commands/eligibility.ts` (new), `src/migrate/rules.ts` | `tests/eligibility.spec.ts` (new) - one case per verdict                                         |
| W61 | [D]  | the `to-vps` rules read the `/export` envelope; every one takes its survey (G18) | `src/migrate/rules.ts`                                      | `tests/eligibility.spec.ts` - a `to-vps` finding changes with the envelope                       |
| W62 | [D]  | the substitution table from 6.2 as data, emitted under `--json`                  | `src/migrate/substitutions.ts` (new)                        | `tests/eligibility.spec.ts` - the table matches the sibling's classes under `REQUIRE_SIBLINGS=1` |
| W63 | [D]  | `evidence` on every `Finding`; a finding with none fails the spec                | `src/migrate/rules.ts`, `src/migrate/plan.ts`               | `tests/migrate-plan.spec.ts` - every rule names its field                                        |
| W64 | [D]  | `migrate delta`: the table set, the `sequences` re-seed, files-before-database   | `src/migrate/delta.ts` (new)                                | `tests/delta.spec.ts` (new) - `sessions` never in the set, `sequences` re-seeded                 |
| W65 | [D]  | `migrate cutover --checklist`, which prints and never ticks itself               | `src/commands/migrate.ts`                                   | `tests/migrate-cutover.spec.ts` (new)                                                            |
| W66 | [D]  | `migrate files --from-dump`: `cfw_file_chunk` rows back onto a filesystem        | `src/migrate/files.ts` (new)                                | `tests/migrate-files.spec.ts` (new) - a chunked file round-trips byte for byte                   |

### Phase 6g - the rig

| #   | repo | what                                                                  | files                                                            | test                            |
| --- | ---- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| W67 | [D]  | the `broken` profile and `broken-entrypoint.sh` from 2.2              | `docker/compose.yml`, `docker/drupal/broken-entrypoint.sh` (new) | -                               |
| W68 | [D]  | `profileGate()`; `REQUIRE_BROKEN` and `REQUIRE_WORKER`                | `tests/e2e/helpers/docker.ts`, `tests/e2e/helpers/stack.ts`      | itself; both directions counted |
| W69 | [D]  | `doctor-source.spec.ts` over the five faults                          | `tests/e2e/doctor-source.spec.ts` (new)                          | itself, behind `REQUIRE_BROKEN` |
| W70 | [D]  | `/health`, `/updb`, `/replica` and the degrade headers on the fixture | `tests/e2e/fixture-worker/src/worker.ts`                         | `tests/e2e/heal.spec.ts` (new)  |
| W71 | [D]  | `heal-real.spec.ts`: the real worker's envelopes against the parser   | `tests/e2e/heal-real.spec.ts` (new)                              | itself, behind `REQUIRE_WORKER` |
| W72 | [D]  | two CI jobs, one per new gate                                         | `.github/workflows/e2e.yml`                                      | -                               |
| W73 | [D]  | `tests/e2e/README.md`: the four gates and the counted skip pairs      | `tests/e2e/README.md`                                            | `bunx prettier --check .`       |

### Phase 6h - documentation

| #   | repo | what                                                               | files                   | test                      |
| --- | ---- | ------------------------------------------------------------------ | ----------------------- | ------------------------- |
| W74 | [D]  | `README.md`: `Healing`, `Eligibility`, `Migrating Under Traffic`   | `README.md`             | `bunx prettier --check .` |
| W75 | [D]  | `CLAUDE.md`: the error model, the repair classes, the rig's gates  | `CLAUDE.md`             | -                         |
| W76 | [W]  | `docs/configuration.md`: the repair surface an owner token reaches | `docs/configuration.md` | -                         |

### Deploys and Credentials

- **Nothing in Phase 6 needs a deploy.** Every route it drives is reachable from
  `wrangler dev --local`, and the four worker-side items PLAN-MODIFY listed as needing one are
  already in the tree (section 0).
- **W71 needs no credential** but does need a hydrated `drupflare/worker`, so it carries the same
  release-payload dependency `workspace-clone.spec.ts` already has. With no release it must skip
  with a named reason rather than fail.
- **W62's cross-repo assertion** reads `drupflare/drupflare`'s source and follows
  `tests/target-runtime.spec.ts`'s shape: skip without the sibling, fail under `REQUIRE_SIBLINGS=1`.
- **W67-W69 need Docker and roughly the same install time as the existing lane.** Nightly and
  dispatch, never the push gate.
- **W66 needs no network.** It reads a dump and writes files.

---

## 10. Section I: Refused

**Zero-downtime bidirectional sync.** Proposed as continuous replication so a migration has no
window at all. Three independent refusals: Drupal has no global LSN, so a delta cannot be computed
from a marker; MySQL binlog coordinates need `REPLICATION CLIENT` and binlogs enabled, which a
shared host does not give and a survey cannot assume; and applying a delta to a live drupflare site
would need a route that runs arbitrary SQL against a serving object, which is `/restore` with a
different name.

**The mechanism is closed; the objective is not.** "Make the window as small as it can be" is
section B: the delta pass narrows it to one dump of the authoritative table set plus a deploy, and
`migrate cutover --checklist` makes the remaining cost visible instead of hidden. What would reopen
the mechanism is a source with binlogs and a measured coordinate, which is a different product tier
and should be scored, not assumed.

**A `migrate import` counterpart, again.** Unchanged from PLAN-MODIFY section 9 and from
`CLAUDE.md`. `/restore` overwrites a whole database from a request body and is diagnostic-only for
that reason. Section B needed one and did not get one; the workspace-plus-deploy path is what
replaces it.

**`heal --force-rollback`.** Unchanged from PLAN-MODIFY. `shouldRollback()` refuses far more often
than it agrees and every refusal names a mechanism. A flag whose only job is defeating a guard is
not a feature.

**`heal --watch` clearing quarantine on its own.** `release()` is documented "explicit, never
automatic" (`worker/src/ops/repair.ts:145`), and the reason is in `recordOutcome()`: a clean pass
clears the strikes and does not un-quarantine, because one good render says nothing
about what caused the fault. A watcher that cleared on a clean read would be doing exactly the thing
the comment refuses.

**Reimplementing the supervisor tripwires in drangler so `heal` can judge locally.** `HOST_TRIPWIRES`
takes an `Observation` holding `maskDepth`, `semaphoreRows`, `asyncifyCalls` and a memory ring - none
of which crosses an HTTP boundary and none of which a CLI can gather. `heal` reads `lastFindings`
and the ledger off `/health` and prints what the object decided. This is the `invoke` disposition in
`CLAUDE.md`'s three-disposition table, and copying the tripwires would be the `move` disposition
applied to something that is not pure and not validation.

**A purpose-built broken-VPS image.** It would need a Dockerfile, a registry, a digest to pin and a
publish step, to produce a container that differs from the pinned one by an entrypoint. A compose
profile on the same digest gives every fault the plan needs. Reopen if a fault turns up that cannot
be planted at container start - a broken PHP _build_, for instance, rather than a broken PHP
configuration.

**Running every e2e spec against the real `drupflare/worker`.** It would make the lane's setup cost
a clone plus a hydrate plus a pack, for specs whose subject is drangler's parser. One gated spec
asserts the envelopes agree; the rest drive the fixture. This is the same split
`worker/tests/e2e/README.md` already argues for `tests/integration/` versus `tests/e2e/`: real
where only real will do.

**Planting a fault by patching drangler.** Same refusal `tests/e2e/detector.spec.ts` already
records: breaking the mover proves the mover can be broken. Every fault in 2.2 is planted in the
container.

**A bounded `--retries` on ssh with no observation.** Refused by the house rule and by the worker's
own recorded failure: `/user/password` re-queued forever on an idle object until `noteStorable()`
gave the loop something to observe. Section 4.4's retries each terminate on a fact.

**Snapshotting the whole site before every repair.** `/export` on a real site is minutes of work and
a large response, and taking one before clearing a quarantine would make the cheapest repair the
most expensive command in the CLI. The snapshot requirement is scoped to the class that changes
schema or what is served, and stating `--no-snapshot` is always available and always recorded.

**A fifth exit code for `GO WITH CHANGES`.** The set is closed at four and both non-`GO` verdicts
are "the check ran and found something". Widening it would break every caller that already treats
`3` as one thing. The verdict lives in the JSON, where a caller that cares can read it.

**Auto-repairing a VPS over ssh.** `tests/migrate-survey.spec.ts` asserts that no survey step
matches a mutating verb, and that property is what makes handing drangler production ssh access
reasonable. Every `source.*` state is report-only for that reason, not because the repairs would be
hard.
