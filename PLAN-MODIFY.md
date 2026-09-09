# drangler Overhaul: `modify`, Healing, Migration, Install

Design document. Nothing here is implemented. Every route name, flag string and file path below was
read out of the two trees on 2026-09-08; anything that could not be determined from the code says so.

Two trees are involved and they are at different commits. `drupflare/worker` carries a large
uncommitted working set (108 files, +7,176/-1,567) from several sessions. drangler was last touched
2026-08-27 and is behind that work in ways this document enumerates.

---

## 1. Current State

### 1.1 Command inventory

19 leaf commands. `drives` names the worker HTTP route the command actually issues, or `-` when it
touches only the local machine. `documented?` is against `README.md`.

| command           | arguments            | flags                                                                                                                 | exit codes | output      | documented? | drives                            |
| ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- | ----------- | --------------------------------- |
| `status`          | `<target>`           | `--path` `--site` `--config` `--timeout` `--json`                                                                     | 0,1,3      | kv + notes  | yes         | `GET /serve`, `GET /firstrun`     |
| `doctor`          | -                    | `--json`                                                                                                              | 0,3        | table       | yes         | -                                 |
| `build`           | -                    | `--workspace` `--source` `--ref` `--from` `--from-source` `--payload-only` `--refresh` `--force` `--dry-run` `--json` | 0,1        | table       | yes         | -                                 |
| `update`          | `[worker]`           | `--workspace` `--source` `--to` `--config` `--account` `--skip-validate` `--dry-run` `--json`                         | 0,1,2      | kv + table  | yes         | `GET /accounts/…/workers/scripts` |
| `validate`        | -                    | `--workspace` `--config` `--only` `--json`                                                                            | 0,3        | table       | yes         | -                                 |
| `dev`             | `[wrangler-args...]` | `--workspace` `--source` `--ref` `--config` `--from` `--from-source` `--payload-only` `--no-build` `--skip-validate`  | 0,1,3      | passthrough | yes         | -                                 |
| `deploy`          | `[wrangler-args...]` | same as `dev`                                                                                                         | 0,1,3      | passthrough | yes         | -                                 |
| `health`          | `<target>`           | `--path` `--site` `--kind` `--skip-edge` `--diagnostics` `--timeout` `--json`                                         | 0,2,3      | kv + notes  | yes         | `GET /serve`, `GET /stats`        |
| `config check`    | `<file>`             | `--account` `--plan` `--json`                                                                                         | 0,2,3      | kv          | yes         | `GET /accounts/…/subscriptions`   |
| `cf whoami`       | -                    | `--json`                                                                                                              | 0,3        | kv          | yes         | `wrangler whoami`                 |
| `cf workers`      | -                    | `--account` `--save` `--compare` `--json`                                                                             | 0,2,3      | table       | yes         | `GET /accounts/…/workers/scripts` |
| `cf cpu`          | `<capture>`          | `--json`                                                                                                              | 0,2,3      | table       | yes         | -                                 |
| `secrets scan`    | `<paths...>`         | `--json`                                                                                                              | 0,2,3      | kv          | yes         | -                                 |
| `migrate survey`  | -                    | `--host`\* `--root`\* `--identity` `--dry-run` `--replay` `--out` `--json`                                            | 0,1,2      | kv          | yes         | `ssh`                             |
| `migrate plan`    | -                    | `--survey` `--target-php` `--site` `--to` `--json`                                                                    | 0,2,3      | sections    | yes         | `GET /php`                        |
| `migrate export`  | -                    | `--url`\* `--site` `--token` `--all` `--out` `--json`                                                                 | 0,1,3      | kv          | yes         | `GET /export`                     |
| `migrate convert` | -                    | `--in`\* `--from`\* `--to`\* `--out` `--skip-unsupported` `--no-split-rows` `--max-statement-chars` `--json`          | 0,1,2,3    | kv          | yes         | -                                 |
| `migrate install` | -                    | `--workspace` `--db` `--asset` `--repack` `--dry-run` `--json`                                                        | 0,1,2      | table       | yes         | -                                 |
| `migrate restore` | -                    | `--backup`\* `--json`                                                                                                 | 0,1        | table       | yes         | -                                 |

`*` = `requiredOption`. Global flags: `--version`, `--help` only. There is no `--quiet`, `--verbose`,
`--yes`, `--profile`, no config file, and no global `--json`.

**drangler drives five worker routes in total**: `/serve`, `/firstrun` (GET), `/export`, `/stats`,
`/php`. The worker answers 51 public paths (`routeTable()` in `src/site.ts`: 7 public, 44 diagnostic,
15 owner, overlapping).

### 1.2 Gaps found

Each of these is a reading, not an opinion.

**G1. `validate`'s bundle check enforces a ceiling Cloudflare deleted.**
`src/workspace/bundle.ts:15` — `FREE_CEILING = 3_145_728`, compared against wrangler's `gzip:` line.
Cloudflare removed the compressed limit on 2026-09-04; the limit is 64 MiB **uncompressed**
(`worker/scripts/measure/bundle-size.ts:31`, `SIZE_CEILING = 67_108_864`, with `FREE_CEILING` and
`PAID_CEILING` aliased to it and marked `@deprecated`). The shipping bundle measured 3,990.8 KiB
gzipped, i.e. 4,086,579 bytes (`worker/CLAUDE.md`, 2026-09-08). **So `drangler deploy` and
`drangler update` fail their own gate on a bundle that uploads.** `GATES.dev` omits `bundle`, so
`drangler dev` is unaffected — which is why nothing has noticed.

**G2. `x-cfw-plan` is read as the account plan and is not one.**
`src/health/probe.ts:236` maps `x-cfw-plan` to `ProbeResult.plan`; `src/commands/status.ts:148`
prints it as `plan` and notes "the plan is unknown rather than free". In the worker the header is set
in three places with two different meanings: `site.ts:1039` (`from`, an edge-plan provenance),
`site.ts:1388` (`planTier`, e.g. `skip:set-cookie`), and `site-do.ts:11845`
(`isPaid(this.env) ? 'paid' : 'free'`). So `drangler status` prints a compiled-plan tier string in a
row labelled `plan`. The header is overloaded on the worker side and that is the root cause.

**G3. `migrate plan` refuses two modules the worker now verifies.**
`src/migrate/rules.ts:INCOMPATIBLE_MODULES` refuses `redis` with "raw TCP; the interpreter has no
socket extension". `worker/src/ops/module-table.ts:230` has `drupal/redis` **verified**, its socket
answered by the Zend park (`park-interpreter.spec.ts`). `SERVICE_MODULES.search_api_solr` says no
Solr host is provisioned; `module-table.ts:215` has it verified with the real historic blocker
(`php-64bit`) named and satisfied. `memcache`/`memcache_storage`/`mongodb` remain correct refusals.

**G4. `config check`'s diagnostics finding names routes that moved.**
`src/cloudflare/config.ts:181` — "that opens /sql, /export, /restore, /firstrun and /php". `/firstrun`
is in `PUBLIC_ROUTES` and `/export` is in `OWNER_ROUTES` (`worker/src/site.ts:146,228`). The finding
is still correct that `PW_DIAGNOSTICS=1` is a blocker; its detail is two routes stale.

**G5. `config check`'s interpreter-alias finding quotes the dead ceiling.**
`src/cloudflare/config.ts:228` — "3,856,138 gzipped bytes against a 3,145,728 ceiling". Same cause as
G1.

**G6. `--site` means two different things.**
`status --site`, `health --site`, `migrate export --site` = the Durable Object identity name.
`migrate plan --site` = a deployment ORIGIN to read `/php` from (`src/commands/migrate.ts:180`). Two
meanings, one string.

**G7. `README.md` claims a `--json` that four commands do not have.**
"Every command takes `--json`" (README, Commands). `dev` and `deploy` have none by construction; the
`config`, `cf`, `secrets` and `migrate` group commands have none because they are groups.

**G8. `target-runtime.ts`'s docblock names a seam that was replaced.**
`src/migrate/target-runtime.ts:24` — "aliasing `./runtime/php-binary.js` to `php-binary-85.ts`". The
shipping alias is `./src/runtime/php-binary-raw.ts` (`worker/wrangler.jsonc`) and
`src/runtime/php-binary-zstd.ts` is deleted. `FALLBACK_TARGET_PHP = '8.5'` is still right, and
`tests/target-runtime.spec.ts` reads the live alias, so only the prose is wrong.

**G9. `tests/helpers.ts` pins the old alias in its fixture.**
`WORKER_CONFIG` declares `alias: { './runtime/php-binary.js': './src/runtime/php-binary-85.ts' }`.
Harmless to the assertions; misleading to the next reader.

**G10. Nothing claims a site.**
The claim window is the whole security-relevant moment of a new deploy: uid 1 has no usable password
until `POST /firstrun` mints one, and `status` exits 3 telling the user to do it by hand. There is no
`drangler` command that POSTs `/firstrun`, and therefore no command that captures the `ownerToken`
that six worker routes and six admin pages require.

**G11. No command reads any owner route except `/export`.**
`/health`, `/ops`, `/installable`, `/install`, `/enable`, `/git`, `/setup/cf`, `/setup/mail`,
`/setup/oidc` and the six `/_cfw` pages are all owner-gated and all unreachable from drangler.

**G12. `/updb` is named by the worker and does not exist.**
`worker/src/site-do.ts:673-674` refuses sliced `cr` and `updb` operations by naming "/updb" as the
driver. `/updb` is in no route set. The updb chain runs only from `alarm()`
(`site-do.ts:8321`). A 501 that names a route the caller cannot reach is the same failure the
`OPS_DRIVERS` docblock exists to prevent.

**G13. `LIMITS` in `migrate/rules.ts` carries render ceilings nothing re-derives.**
`rendersPerDayCold: 1_052`, `rendersPerDayWindowed: 7_575`. The worker scores against
`scripts/measure/free-envelope.ts` and its CLAUDE.md quotes 10,869/day windowed and 2,777 on the
alarm chain for rows written. These are not the same quantity, so this is not a proven contradiction
— it is an unsourced figure in a user-facing plan, which is the thing this project has been wrong
about repeatedly. It needs a provenance or a deletion, not a guess.

**G14. `npm i -g` installs something that cannot run.**
`package.json` `bin.drangler = "./src/cli.ts"`, and `src/cli.ts` starts `#!/usr/bin/env bun`. On a
machine with node and no bun that is a broken binary with a confusing error. `files` ships `src`
only; there is no built entrypoint.

**G15. The README is not in the house documentation style.**
Emoji headers on all 15 sections, a table of contents, and margin-to-limit figures ("22 MB of Drupal
packs", "710,410 bytes over the ceiling", "fits the 3 MiB free-plan ceiling"). Both the emoji
headings and the headroom figures are named as things to remove in `~/.claude/CLAUDE.md`.

**G16. `version_metadata` is bound and never read.**
`worker/wrangler.jsonc` declares `"version_metadata": { "binding": "CF_VERSION_METADATA" }`. No file
under `worker/src/` mentions `CF_VERSION_METADATA`. Decorative configuration: the one thing the
Cloudflare versions surface is genuinely good for — saying which code version answered a request —
is bound and discarded.

---

## 2. The Install Experience

### 2.1 What it prints today

`bun add -g @drupflare/drangler` prints bun's own install summary and nothing of drangler's. There is
no postinstall, no wizard, no first-run message, and no config file. The first thing a user sees from
drangler is whatever command they typed next. `drangler --help` prints commander's default render
with the description from `src/program.ts:27`:

```text
Usage: drangler [options] [command]

Start, maintain and migrate a drupflare site. Read-only apart from four commands that say what
they write: build, dev, deploy and migrate install.
```

That description undercounts: `update` also writes, which the README already corrects to five.

### 2.2 Install routes

| route                            | works today  | after this plan | needs                                      |
| -------------------------------- | ------------ | --------------- | ------------------------------------------ |
| `bun add -g @drupflare/drangler` | yes          | yes             | -                                          |
| `npm i -g @drupflare/drangler`   | **no** (G14) | yes             | a built `dist/cli.js` and a `node` shebang |
| `bunx @drupflare/drangler`       | yes          | yes             | -                                          |
| `curl -fsSL … \| sh`             | no           | deferred        | a published GitHub release with the binary |
| `bun run build:binary`           | yes          | yes             | -                                          |

**Fix for `npm i -g`:** add a `build:dist` script (`bun build src/cli.ts --target=node --outdir=dist
--format=esm`), point `bin.drangler` at `./dist/cli.js`, give that file `#!/usr/bin/env node`, add
`dist` to `files`, and run it from `prepublishOnly`. `src/` stays in `files` because `exports.` points
there for library consumers.

**`curl | sh` is refused until a release exists.** There is no tag on `drupflare/drangler` and no
release payload on `drupflare/worker` either (`no-release-payload` is already a recorded state in
project memory). An install script that fetches a binary that is not published is a worse first
experience than no install script.

### 2.3 Config resolution

drangler has no config file today. Everything is a flag or an ad-hoc environment variable:
`DRANGLER_WORKSPACE`, `DRANGLER_WORKER_SOURCE`, `DRANGLER_WORKER_REF`, `DRUPFLARE_OWNER_TOKEN`,
`CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` / `CF_ACCOUNT_ID`.

Proposed, in resolution order, most specific first:

1. an explicit flag
2. the environment variable
3. `drangler.json` in the nearest ancestor directory of `cwd` that has one (project config)
4. `$XDG_CONFIG_HOME/drangler/config.json`, else `~/.config/drangler/config.json` (global config)
5. the built-in default

`--profile <name>` selects a named block inside either file. `--config-file <path>` overrides the
search. `drangler config where` prints which file supplied each value and stops the "why is it
picking that account" question dead.

```jsonc
// drangler.json, written by `drangler modify init`
{
  "site": {
    "origin": "https://mysite.example",
    "name": "site"
  },
  "module": {
    "root": ".",
    "package": "mantle2"
  },
  "workspace": ".drupflare/worker"
}
```

The owner token is **not** written to `drangler.json`. It goes to the global config under
`sites["https://mysite.example"].ownerToken` with mode `0600`, because `drangler.json` is a file
people commit. `drangler modify init` says so in one line rather than assuming.

### 2.4 First-run wizard

`drangler` with no arguments today prints commander's help. It should instead print a six-line
orientation and exit 0. `drangler init` runs the wizard. It asks at most five questions, every one of
which changes what gets written:

1. **What are you doing here?** — run a site locally / deploy a new site / connect to a site that
   already exists / develop a module against a site. Selects which of the remaining questions are
   asked at all.
2. **Site origin** (skipped for "run locally") — validated with one `GET /serve` and reported: is it
   drupflare, is it claimed, which tier answered.
3. **Owner token** (skipped when the site is unclaimed; then it offers to claim instead) — accepted
   from a paste, from `DRUPFLARE_OWNER_TOKEN`, or minted by claiming.
4. **Cloudflare account** (only when the answer to 1 involves deploying) — from `wrangler whoami`
   when it resolves one, offered as a list when it resolves several.
5. **Write config where?** — project `drangler.json`, global, or neither (print the flags instead).

Copy rules for every message the installer and the wizard print: plain sentences, no exclamation
marks, no emoji, no "Welcome". State what happened and what to type next. Progress on stderr, the
result on stdout, so `--json` stays parseable.

```text
drangler 0.2.0

Nothing is configured yet.

  drangler dev              a local Drupal, from nothing
  drangler init             connect to a site you already have
  drangler --help           every command

Docs: https://github.com/drupflare/drangler
```

---

## 3. Migration Paths

"Migration" means three unrelated things in this codebase and the CLI currently exposes only one.

| what                    | who owns it                                | worker route            | drangler today |
| ----------------------- | ------------------------------------------ | ----------------------- | -------------- |
| VPS <-> Workers move    | `src/migrate/*`                            | `/export`               | `migrate *`    |
| pack replay into the DO | `site-do.ts:/__migrate`, `migrateChunks()` | `/migrate` (diagnostic) | none           |
| Drupal `update.php`     | `src/ops/updb.ts`, driven from `alarm()`   | none (G12)              | none           |

### 3.1 What happens today when a site is behind

- **Pack replay behind.** The object answers 503 with `x-cfw-migrate: <chunk>` and
  `x-cfw-migrate-state`. `probe.classify()` reads that as `warming` (correct — it was a real bug that
  it read as `degraded`, fixed at `probe.ts:125`) and `health` prints one note. Nothing polls to
  completion, so a user has to re-run the command until the note goes away.
- **Schema behind.** `updbStatus(sql)` exists (`ops/updb.ts:2103`) and reports phase, cursor and halt
  state. It is reachable from `/__ops` only indirectly and from no public route. The supervisor
  tripwire `updbHalted` (`supervisor.ts:267`) fires and records a finding that nothing reads.
- **Interpreter behind.** `/php` reports the version and is diagnostic-gated, so on a correct
  deployment the answer is unreadable. `migrate plan` degrades to `assumedTarget()` and says so,
  which is the right behaviour and should not change.
- **Worker code behind.** `drangler update <worker>` fast-forwards the checkout and redeploys. It
  cannot say what version is currently serving, because nothing reads `CF_VERSION_METADATA` (G16).

### 3.2 What it should do

**`drangler site` becomes a new group** so the word `migrate` keeps meaning "move between hosts".

```text
drangler site claim <target>        POST /firstrun, store the ownerToken
drangler site status <target>       the deployment-state half of `status`, owner-authenticated
drangler site upgrade <target>      deploy, then wait for the pack replay, then report updb
drangler site updb <target>         read the updb cursor; --step drives one beat
drangler site invalidate <target>   bump the generation, or purge one path
```

- **`site claim`** POSTs `{"adminPass": "...", "siteName": "..."}` to `/firstrun`. The route refuses a
  `?pass=` query parameter outright (`site-do.ts:/__firstrun`) — a body is the only way, so this is a
  command rather than a `curl` line a user gets wrong. It prints the `adminPass` and `ownerToken`
  once, offers to write the token to the global config, and exits 3 if the site was already claimed
  (409) so a script can tell "I claimed it" from "somebody else did".
- **`site upgrade`** is the composite that does not exist: `deploy`, then poll `GET /serve?edge=0`
  until `x-cfw-migrate` is absent, printing chunk progress, then `GET /updb` (new route, below) until
  the phase is terminal. Bounded by `--timeout` with a real default and a resumable exit — re-running
  it continues rather than restarting, because both halves are cursor-driven on the worker side.
- **`site updb`** needs the new `/updb` owner route (work item W16). `GET` returns `updbStatus(sql)`;
  `POST /updb?step=1` runs one `updbStepOnce()` beat. That closes G12 and makes the `OPS_DRIVERS`
  refusal text true.
- **`site invalidate`** needs `/invalidate` and `/bump` moved from `DIAGNOSTIC_ROUTES` into
  `OWNER_ROUTES` (work item W17). Today a site owner cannot purge their own cache without
  `PW_DIAGNOSTICS=1`, which `config check` correctly calls a blocker.

### 3.3 What must NOT change

`/restore` and `/sql` stay diagnostic-only, and there is still no `migrate import`. The asymmetry is
deliberate and is recorded in `CLAUDE.md`: pulling your data out is a right, pushing arbitrary SQL in
is a remote shell.

---

## 4. Healing Paths

The worker's healing machinery is real and complete: `RUNGS` (observe, reset, reconstruct,
reconfigure, quarantine, rollback), `QUARANTINE_STRIKES = 3`, `ROLLBACK_DWELL_MS = 30 * 60_000`,
`recordOutcome()`, `shouldRollback()`, `release()` in `src/ops/repair.ts`; 14 tripwires and a 500-row
ledger in `src/ops/supervisor.ts`; three degradation levels in `src/ops/degrade.ts`
(`REDUCE_AT = 0.8`, `READ_ONLY_AT = 0.95`).

**All of it is exposed on exactly one route.** `GET /health` (owner + diagnostic) returns:

```json
{ repair, quarantined, rollback, advisories, lastFindings, ledger, ledgerRows }
```

and `GET /health?clear=1` calls `release()` and returns `{ ok, released, was }`.

Degradation state is not on `/health`; it is on the response headers `degradeHeaders(d)` and in
`/serve-stats` (diagnostic).

### 4.1 `drangler doctor` — split, not extended

`doctor` today looks at nothing on disk and nothing on the network beyond `wrangler whoami`, and
`CLAUDE.md` records why (a health check that only passes on a maintainer's laptop). Keep that. Add:

- **`doctor` gains config-resolution rows**: which config file supplied the site, the profile, the
  workspace, and the account. Local, cheap, and it answers the most common confusion.
- **`doctor --site <target>`** additionally runs the remote half and exits 3 on any finding. It does
  not become required; without the flag `doctor` is unchanged.
- **`TOOLS` gains nothing.** `git` is genuinely used again once `modify` ships (it reads a working
  tree's HEAD), so `git` goes back into `TOOLS` as **optional**, not required, and only when W30
  lands. A preflight that demands a tool the CLI does not run is the exact bug the docblock at
  `commands/doctor.ts:33` warns about.

### 4.2 `drangler heal <target>` — new

Read-only by default. Every write is behind an explicit flag and `--yes`.

```text
drangler heal <target>                    report; exit 3 if quarantined or a rollback is pending
drangler heal <target> --watch            re-read every --interval until clean or --timeout
drangler heal <target> --release --yes    GET /health?clear=1
drangler heal <target> --ledger 200       widen the ledger window (worker caps at LEDGER_MAX_ROWS)
```

Report shape:

```text
site        https://mysite.example
rung        quarantine
code        bridge.asyncify_called
strikes     3 of 3
since       2026-09-08T04:12:09Z (48m)
rollback    no -- quarantined 48m for bridge.asyncify_called; replaying restore point 17 (412 statements)
advisories  1 security advisory outstanding
degraded    reduced (rows-written 0.83 of 1.00)

findings
  warn   memory.trend_rising     recycle at the next quiet moment
  error  bridge.asyncify_called  3 consecutive

ledger (last 5 of 500)
  ...
```

**What `heal` can fix today: exactly one thing** — clearing quarantine, via `/health?clear=1`. That is
the only healing action reachable through an owner route. Saying "one" plainly is the point; a
command that implies more repair than the routes permit is the failure this project keeps recording.

**What becomes fixable after the worker work items below:**

| action                  | needs                                          | work item |
| ----------------------- | ---------------------------------------------- | --------- |
| clear quarantine        | nothing; `/health?clear=1` exists              | -         |
| re-arm a stalled fill   | `/armfill` moved to `OWNER_ROUTES`             | W13       |
| resume a stalled replay | `/migrate` moved to `OWNER_ROUTES`             | W13       |
| purge a generation      | `/invalidate`, `/bump` moved to `OWNER_ROUTES` | W13       |
| drive one updb beat     | new `/updb` route                              | W12       |

**What must stay manual, and why:**

- **Rollback.** `shouldRollback()` is a decision the object makes with a dwell timer and a restore
  point it can see; a CLI forcing it would be overriding a guard whose whole job is refusing more
  often than it agrees. `heal` prints the decision and its reason; it does not offer to override it.
- **Point-in-time recovery.** `/pitr` reaches a 30-day window with no undo. It is diagnostic-only and
  should stay there. `heal` names it as the manual escalation and prints nothing that runs it.
- **Interpreter recycling.** `recycleIfOversized()` must run between invocations. A CLI-triggered
  drop would run inside one and hold both allocations at once, which is the documented failure mode.

---

## 5. `drangler modify`

### 5.1 What a revision is

**A revision is an immutable, content-addressed manifest of one package's files, stored in one site's
Durable Object.** It is per-site state, not per-Worker code. Nothing about it involves a Cloudflare
Worker version, and section 9 explains why that is the right shape rather than a fallback.

The worker already has three quarters of this:

- `cfw_module_file (path PRIMARY KEY, package, version, source, installed_at)` — the **active**
  materialised tree the boot mount reads (`site-do.ts:4690`). `version` already holds a git sha.
- `planSync(stored, incoming)` (`ops/git-sync.ts:226`) — computes added / modified / removed /
  unchanged plus `rowsWritten`, and line deltas per file.
- `gitApply()` / `gitRestore()` / `gitVerifyBoot()` (`site-do.ts:4018-4090`) — one transaction, then a
  real kernel boot, then a full restore of the previous file set if the boot fails.

What is missing is history: `gitRestore` restores an in-memory snapshot **within the same call**.
Once an apply succeeds the previous state is gone, so there is no rollback after the fact, and there
is no way to deliver a tree that is not on a git host.

Two new tables, both in `ensureServeTables()`:

```sql
CREATE TABLE IF NOT EXISTS cfw_module_blob (
  hash TEXT PRIMARY KEY,      -- sha256 of the file bytes, hex
  source TEXT NOT NULL,
  bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cfw_module_rev (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package TEXT NOT NULL,
  rev TEXT NOT NULL,          -- sha256 of the sorted manifest; the revision's identity
  kind TEXT NOT NULL,         -- 'upload' | 'git' | 'composer'
  label TEXT NOT NULL,        -- free text from --message, or the git subject
  origin TEXT NOT NULL,       -- a local path, a git sha, or a package version
  manifest TEXT NOT NULL,     -- JSON {"<mounted path>": "<blob hash>"}
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL     -- 1 for the revision currently materialised
);
```

**Why content-addressed:** rows written is the meter that binds regeneration (worker CLAUDE.md), and
a second full copy of a module per revision would price history out. A blob whose hash is already
present costs zero rows. A typical edit-and-upload cycle on mantle2 writes: 1 revision row + N
changed blobs + the `cfw_module_file` diff that `planSync` already computes. **Retention** defaults to
the last 5 revisions per package; dropping one deletes its blobs only when no surviving manifest
references them.

`AUTOINCREMENT` is used deliberately for `id`: the worker's recorded finding is that it costs
speculative replay (4 rows vs 1) on the _driver_ path, and this table is written once per revision by
host code, not by the PDO shim.

### 5.2 New worker routes

One route, seven actions, mirroring `/git`'s existing shape. `/modify` joins `OWNER_ROUTES` and gets
`DO_ROUTE['/modify'] = '/__modify'`.

| action      | method | parameters                   | body                          | returns                                           |
| ----------- | ------ | ---------------------------- | ----------------------------- | ------------------------------------------------- |
| `plan`      | POST   | `package`                    | `{files:[{path,hash,bytes}]}` | `{have:[hash], want:[hash], counts, rowsWritten}` |
| `blobs`     | POST   | `package`                    | `{blobs:[{hash,source}]}`     | `{stored, skipped, bytes}`                        |
| `commit`    | POST   | `package`, `label`, `origin` | `{files:[{path,hash}]}`       | `{rev, applied, rolledBack, counts, error?}`      |
| `revisions` | GET    | `package`, `limit`           | -                             | `{revisions:[…], active}`                         |
| `activate`  | POST   | `package`, `rev`             | -                             | `{rev, applied, rolledBack, counts}`              |
| `status`    | GET    | `package?`                   | -                             | `{packages:[{package,rev,files,bytes,at}]}`       |
| `drop`      | POST   | `package`, `rev`             | -                             | `{dropped, blobsFreed}`                           |

- `plan` is the have/want negotiation. Without it every upload sends the whole module; with it a
  one-file edit sends one file. It costs one DO request and writes nothing.
- `blobs` is bounded by `MAX_BODY_BYTES` (`env.ts:138`) and by `RECORD_CAP = 2_199_995` per file
  (`ops/package-install.ts:179`). The CLI batches to stay under both and reports the batching.
- `commit` reuses `planSync` + `gitApply`-equivalent + `gitVerifyBoot` unchanged, so a module that
  breaks the container rolls back exactly the way a git pull does today.
- `activate` is `commit` against a stored manifest and needs no network at all.
- Path mounting reuses `selectFiles()` / `moduleRoots()` / `mountPlan()` from `ops/git-sync.ts`, so
  an uploaded tree and a git-delivered tree land in the same place by construction. `mantle2` has
  `mantle2.info.yml` at its root, so `moduleRoots()` returns one root `''` named `mantle2` and it
  mounts at `modules/custom/mantle2`.

**Conflict with `/git`.** `detectConflicts()` already refuses a path another package owns. An upload
of a package a git remote also delivers is a real conflict and gets the same 409, naming both.

### 5.3 Project detection

`modify` runs from four shapes. Detection is one function, `detectProject(files, dir)`, and it never
guesses silently — `modify status` prints which shape it detected and from which file.

| shape                  | detected by                                          | package name from           | mantle2? |
| ---------------------- | ---------------------------------------------------- | --------------------------- | -------- |
| module / theme project | one or more `*.info.yml` (`moduleRoots()` rules)     | the info file's basename    | yes      |
| Drupal source tree     | `core/lib/Drupal.php` or `web/core/lib/Drupal.php`   | each dir under `*/custom/*` | no       |
| bare module directory  | exactly one `*.info.yml` at the top level            | the info file's basename    | no       |
| patch listing          | a directory of `*.patch` / `*.diff` and no info file | **refused**, see section 9  | no       |

For a Drupal source tree, `modify` operates on `modules/custom/*`, `themes/custom/*` and
`profiles/custom/*` only — one package per directory. Contrib is not uploaded: it is
`drangler modify require <name>`, which drives `/installable` then `/install` and is the correct
mechanism for anything that has a registry entry.

### 5.4 Subcommands

Every one takes the global flags from section 7. `<target>` is resolved from `--site`, then
`drangler.json`, then the global config.

```text
drangler modify init [dir]
  --site <origin>            the drupflare site to link to
  --name <package>           override the detected package name
  --global                   write the link to the global config instead of drangler.json
  --token <token>            owner token; also read from DRUPFLARE_OWNER_TOKEN
```

Writes `drangler.json`, stores the token in the global config at `0600`, and prints where each landed.
Exits 2 when the directory matches no known shape, naming what it looked for.

```text
drangler modify status
  --package <name>           one package instead of every detected one
```

The one command a user runs most. Reads `GET /modify?action=status` and the local tree, and prints
what is live against what is here.

```text
drangler modify diff
  --package <name>
  --name-only                paths only, no line counts
  --against <rev>            compare against a stored revision rather than the active one
```

Local against live, file by file, using the same `lineDelta()` arithmetic the worker uses so the two
never disagree. Exits 3 when there is a difference, 0 when there is not — so a CI step reads a status.

```text
drangler modify check
  --package <name>
  --php <path>               a local PHP binary for `php -l`; skipped with a named reason if absent
  --deps                     resolve *.info.yml dependencies against /installable
```

Everything that can be known before bytes leave the machine: every kept file lints, no file exceeds
`RECORD_CAP`, the total fits `MAX_BODY_BYTES` in some number of batches, no path collides with
another package on the site, and (with `--deps`) every declared dependency is `installable`. mantle2
declares ten (`node`, `user`, `comment`, `json_field`, `key`, `field`, `options`, `datetime`, `smtp`,
`redis`), five of which are contrib, so this is not a theoretical check.

```text
drangler modify upload
  --package <name>
  --message <text>           the revision label; defaults to the git subject when there is one
  --activate                 materialise immediately (default)
  --no-activate              store the revision without making it live
  --dry-run                  print the plan and send nothing
  --force                    upload despite a `check` finding
```

`check` -> `plan` -> `blobs` -> `commit`. Prints the have/want split so the cost is visible before it
is paid.

```text
drangler modify revisions
  --package <name>
  --limit <n>                default 20
```

```text
drangler modify activate <rev>
  --package <name>
  --yes                      required; this changes what the site serves
```

```text
drangler modify rollback
  --package <name>
  --yes
```

`activate` against the revision immediately preceding the active one. Sugar over `activate`, and it
is the one people will actually type.

```text
drangler modify release
  --package <name>
  --tag <tag>                the git tag to release from; requires a clean tree
  --message <text>
  --yes
```

Uploads from a tagged commit rather than the working tree, refuses a dirty tree, and labels the
revision with the tag. This is the only `modify` subcommand that requires `git`.

```text
drangler modify require <name>
  --version <constraint>
  --registry <composer|npm>
  --enable                   also call /enable after a successful /install
  --force                    pass force=1 to /install
```

Drives `/installable` then `/install` then optionally `/enable`. Not an upload path — a package with a
registry entry belongs to the registry.

```text
drangler modify enable <name...>
drangler modify remove --package <name> --yes
```

### 5.5 stdin/stdout contract

- **stdout carries the report and nothing else.** Under `--json` it is exactly one object, the same
  one the text render is derived from. This is already the house rule in drangler's `CLAUDE.md` and
  `runPlan()` has already broken it once.
- **stderr carries progress**: upload batches, poll ticks, the wrangler handoff line.
- **stdin is read by exactly one path**: `modify upload --files -` takes a newline-separated list of
  paths, so `git diff --name-only | drangler modify upload --files -` works. No other command reads
  stdin.
- **No command is interactive without a TTY.** `--yes` is required in a pipe; without it and without
  a TTY the command exits 2 naming the flag.

### 5.6 Exit codes

The closed set is unchanged: `0` ok, `1` the check could not run, `2` bad input, `3` the check ran and
found something. `modify diff` exits 3 on a difference; `modify check` exits 3 on a finding;
`modify upload` exits 1 when the commit rolled back (the kernel refused to boot — that is a failure to
complete, not a finding), and 3 when it succeeded but `check` had warnings that `--force` overrode.

### 5.7 A worked session

```console
$ cd ~/gmitch215/earth-app/mantle2
$ drangler modify init --site https://earth.example
detected      module project (mantle2.info.yml)
package       mantle2
mounts to     modules/custom/mantle2
site          https://earth.example (claimed, answered EDGE)
wrote         ./drangler.json
wrote         ~/.config/drangler/config.json (owner token, mode 0600)

next: drangler modify check

$ drangler modify check --deps
package     mantle2
files       412 kept, 1,908 skipped
bytes       1.8 MB in 2 batches of at most 1.0 MB
lint        412 ok (php 8.4.12)
paths       no collision with any package on the site

dependencies
  node          core
  user          core
  comment       core
  field         core
  options       core
  datetime      core
  json_field    installable (drupal/json_field 1.4.2)
  key           installable (drupal/key 1.22.0)
  smtp          installable (drupal/smtp 1.4.0)
  redis         installable (drupal/redis 1.10.0)

4 contrib dependencies are not installed on the site.
  drangler modify require drupal/json_field drupal/key drupal/smtp drupal/redis --enable

$ drangler modify upload --message "add the streak service"
plan        412 files, 6 not on the site, 406 already there
rows        7 (6 blobs + 1 revision)
uploading   6 blobs, 41.2 kB, 1 batch
commit      rev 9f2c1ab4
verify      kernel booted
active      rev 9f2c1ab4 (was 3d81ee07)

changed
  modified  modules/custom/mantle2/src/Service/StreakService.php   +84  -12
  added     modules/custom/mantle2/src/Service/StreakInterface.php +31  -0
  ...

$ drangler modify status
package   mantle2
live      9f2c1ab4  add the streak service           2026-09-08T11:04:22Z
local     9f2c1ab4  (clean)
history   5 revisions, 2.1 MB in 1,204 blobs

$ drangler modify rollback --yes
active    rev 3d81ee07 (was 9f2c1ab4)
verify    kernel booted
rows      6
```

### 5.8 Sibling-module work items

`drupflare/drupflare` (the `drupflare` Drupal module) needs no change: `/modify` is host code and
writes the same `cfw_module_file` rows the mount already reads at boot
(`site-do.ts:1934`, "this is the only place either becomes reachable to PHP").

`drupflare/rom` needs no change.

The one sibling item is **`RepairLadder::RUNGS` stays the mirror of `ops/repair.ts:RUNGS`**. Nothing
here changes the ladder, so nothing there moves — recorded so the next person does not assume it
must.

---

## 6. `dev` Unification

**One command. `drangler modify dev` is an alias for `drangler dev --modify .`.**

The reasoning is what each one actually does:

- `drangler dev` clones `drupflare/worker`, hydrates 22 MB of packs and an interpreter, validates,
  and hands the terminal to `wrangler dev`. That is a full local Drupal.
- A hypothetical `modify dev` needs a full local Drupal to mount a module into. It has no separate
  job; it has one extra step after the server is listening.

Two commands would mean two workspaces, two hydrates and two `wrangler dev` processes fighting over
port 8787. That is not a trade-off, it is a mistake, so the Confusion Protocol does not apply and this
is not a question for sign-off.

Resulting shape:

```text
drangler dev [wrangler-args...]
  --modify <dir>       mount a local module project into the dev site; repeatable
  --watch              re-upload on change (default when --modify is given)
  --no-watch           upload once and stop
  --port <n>           passed through to wrangler
```

Sequence: existing build -> existing validate -> `bunx wrangler dev` -> wait for the port ->
`POST /firstrun` against `localhost` if the dev site is unclaimed -> `plan`/`blobs`/`commit` for each
`--modify` tree -> watch and re-commit on change. The local dev site is `site=dev` and its owner token
is minted and held in memory for the process; it is never written to disk.

When `cwd` is a detected module project and `drangler.json` exists, `--modify .` is implied, so
`drangler dev` inside mantle2 does the obvious thing with no flags.

**Comparison against a remote site is a different feature and is not in `dev`.** `modify status` and
`modify diff` answer "what is live vs what is here" at the file level. Diffing rendered responses
between a local dev site and a remote one is a bigger thing with its own instrument problems
(different generations, different session state, different cache tiers) and is refused for now —
section 9.

---

## 7. Flags and Documentation

### 7.1 Global flag convention

Declared once with `program.option()` and inherited, so no command re-declares them and no two
commands disagree.

| flag                | type    | default          | meaning                                                        |
| ------------------- | ------- | ---------------- | -------------------------------------------------------------- |
| `--json`            | boolean | off              | stdout is one JSON object, the same one the text is built from |
| `--quiet`, `-q`     | boolean | off              | suppress progress on stderr; the report still prints           |
| `--verbose`, `-v`   | boolean | off              | every subprocess argv and every HTTP request line, on stderr   |
| `--site <origin>`   | string  | config           | **the site to act on**, always an origin from here on          |
| `--site-name <n>`   | string  | `site`           | the Durable Object identity, formerly the meaning of `--site`  |
| `--profile <name>`  | string  | `default`        | which config block to read                                     |
| `--config-file <p>` | string  | search           | override config discovery                                      |
| `--yes`, `-y`       | boolean | off              | consent for anything that writes to a live site                |
| `--dry-run`         | boolean | off              | print the plan, execute nothing                                |
| `--timeout <ms>`    | number  | `15000`          | per-request timeout                                            |
| `--token <token>`   | string  | env, then config | the owner token                                                |

**`--site` changes meaning and that is a breaking change**, which is why it is called out here rather
than buried. Today it is the DO identity on three commands and an origin on one (G6). After this it
is always an origin; the identity becomes `--site-name`. `status --site foo` currently means "the
object named foo"; a bare word that is not a URL now exits 2 naming the new flag rather than silently
probing `https://foo`. One release of that refusal is cheaper than a permanent ambiguity.

`--quiet` and `--verbose` together exit 2.

### 7.2 Help text format

Every command's help has four parts in this order, and nothing else:

1. one line saying what it does, imperative, no trailing period
2. `Usage:` from commander
3. the flag list, aligned, each description lowercase and under 70 characters
4. an `Examples:` block of at most three real invocations

Long explanation goes in the README, not in `--help`. A description that needs a semicolon needs to be
two sentences in the README instead.

### 7.3 README as a product document

Rewrite against the house rules. Concretely:

- **Strip all 15 emoji headers.** `## Install`, `## Quick Start`, `## Commands`, `## Workspaces`,
  `## Validation`, `## Migrating to Workers`, `## Exit Codes`, `## Out of Scope`.
- **Drop the table of contents.** GitHub renders one.
- **Remove every margin-to-a-limit figure**: "22 MB of Drupal packs", "710,410 bytes over the
  ceiling", "fits the 3 MiB free-plan ceiling", "3,856,138 gzipped bytes". State the capability. The
  numbers belong in `CLAUDE.md` where a maintainer reads them.
- **Remove the development narrative**: "The payload half waits on a release", "no tag exists yet",
  the version-skew paragraph in Workspaces.
- **Fix "Every command takes `--json`"** (G7) — it becomes true once section 7.1 lands, so the
  sentence stays and the code changes to match it.
- **New sections**: `Modify`, `Healing`, `Configuration`. `Modify` gets the worked session from 5.7,
  trimmed.
- Keep the badges and the license section.

---

## 8. Work Plan

Ordered. Each item is one commit. `[D]` drangler, `[W]` worker, `[S]` a sibling module repo.

### Phase 1 — the CLI is wrong about the platform (do this first, it is broken today)

| #   | repo | what                                                                                                               | files                                                                     | test                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| W1  | [D]  | `SIZE_CEILING = 67_108_864` on **raw** bytes; parse wrangler's `Total Upload` line; keep the gzip figure unchecked | `src/workspace/bundle.ts`, `src/workspace/validate.ts`                    | `tests/workspace-validate.spec.ts` — a 4 MB gzip bundle passes       |
| W2  | [D]  | drop the ceiling quote from the interpreter-alias finding (G5)                                                     | `src/cloudflare/config.ts`                                                | `tests/cloudflare.spec.ts` — finding text has no byte figure         |
| W3  | [D]  | fix the `PW_DIAGNOSTICS` finding's route list (G4)                                                                 | `src/cloudflare/config.ts`                                                | same spec                                                            |
| W4  | [D]  | move `redis` and `search_api_solr` out of the refusal lists, with the park and long64 mechanisms named (G3)        | `src/migrate/rules.ts`                                                    | `tests/migrate-plan.spec.ts` — a survey listing redis has no blocker |
| W5  | [D]  | rename the probe field `plan` -> `planTier`; add a note that it is the edge-plan verdict (G2)                      | `src/health/probe.ts`, `src/commands/status.ts`, `src/commands/health.ts` | `tests/status.spec.ts`, `tests/health.spec.ts`                       |
| W6  | [W]  | give `x-cfw-plan` one meaning; move the account-plan reading to `x-cfw-account-plan` and bump `CFW_HEADER_VERSION` | `src/site.ts`, `src/site-do.ts`                                           | `tests/unit/runtime/route-gate.spec.ts` + a header-contract spec     |
| W7  | [D]  | read `x-cfw-account-plan`, raise `KNOWN_HEADER_VERSION` to 2                                                       | `src/health/probe.ts`                                                     | `tests/health.spec.ts` — v1 and v2 both parse                        |
| W8  | [D]  | correct the stale seam prose and the fixture alias (G8, G9)                                                        | `src/migrate/target-runtime.ts`, `tests/helpers.ts`                       | `tests/target-runtime.spec.ts` under `REQUIRE_SIBLINGS=1`            |
| W9  | [D]  | give `LIMITS.rendersPerDay*` a provenance or delete them (G13)                                                     | `src/migrate/rules.ts`                                                    | `tests/migrate-plan.spec.ts`                                         |

W6 needs a deploy to verify end to end, and it is a header rename, so `CFW_HEADER_VERSION` must move
in the same commit — that is the whole reason the version exists. W7 must land before or with W6 or a
drangler in the wild reports `-` for the plan.

### Phase 2 — install and configuration

| #   | repo | what                                                                                            | files                                                       | test                                                     |
| --- | ---- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| W10 | [D]  | build a node entrypoint; `bin` -> `dist/cli.js`; `prepublishOnly` (G14)                         | `package.json`, `src/cli.ts`                                | `tests/cli.spec.ts` — the shebang and bin path agree     |
| W11 | [D]  | config file: discovery, profiles, `drangler config where`, `--config-file`                      | `src/config/*.ts` (new), `src/context.ts`, `src/program.ts` | `tests/config-file.spec.ts` (new) — all five precedences |
| W12 | [D]  | global flags from 7.1, including `--site` / `--site-name` and the exit-2 refusal of a bare word | `src/program.ts`, every `src/commands/*.ts`                 | `tests/cli.spec.ts` — one case per flag                  |
| W13 | [D]  | `drangler init` wizard and the no-argument orientation                                          | `src/commands/init.ts` (new), `src/program.ts`              | `tests/init.spec.ts` (new) — every branch of question 1  |

### Phase 3 — site lifecycle and healing

| #   | repo | what                                                                                        | files                                                      | test                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| W14 | [D]  | `drangler site claim`                                                                       | `src/commands/site.ts` (new)                               | `tests/site.spec.ts` (new) — 200, 409, and the `?pass=` refusal      |
| W15 | [D]  | `drangler heal` (report, `--watch`, `--release --yes`)                                      | `src/commands/heal.ts` (new), `src/health/repair.ts` (new) | `tests/heal.spec.ts` (new) — quarantined, clean, and a rollback wait |
| W16 | [W]  | new `/updb` owner route: `GET` returns `updbStatus()`, `POST ?step=1` drives one beat (G12) | `src/site.ts`, `src/site-do.ts`, `src/ops/updb.ts`         | `tests/integration/ops-surface.spec.ts`                              |
| W17 | [W]  | move `/armfill`, `/invalidate`, `/bump`, `/migrate` into `OWNER_ROUTES`                     | `src/site.ts`                                              | `tests/unit/runtime/route-gate.spec.ts`                              |
| W18 | [D]  | `drangler site updb`, `site invalidate`, `site upgrade`                                     | `src/commands/site.ts`                                     | `tests/site.spec.ts`                                                 |
| W19 | [W]  | read `CF_VERSION_METADATA` and report `{id, tag, timestamp}` on `/health` (G16)             | `src/site.ts`, `src/site-do.ts`, `src/env.ts`              | `tests/integration/ops-surface.spec.ts`                              |

W17 changes who can reach four routes. It widens nothing to the public — an owner token is a stronger
credential than `PW_DIAGNOSTICS=1`, which is a deploy-wide boolean — but it is a security-surface
change and wants its own commit and its own review.

### Phase 4 — modify

| #   | repo | what                                                                                    | files                                                  | test                                                                             |
| --- | ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| W20 | [W]  | `cfw_module_blob` + `cfw_module_rev` DDL and the pure revision helpers                  | `src/ops/module-rev.ts` (new), `src/site-do.ts`        | `tests/unit/ops/module-rev.spec.ts` (new) — manifest hashing, refcounts, GC      |
| W21 | [W]  | `/modify` route: `plan`, `blobs`, `commit`, reusing `planSync` and `gitVerifyBoot`      | `src/site.ts`, `src/site-do.ts`                        | `tests/integration/modify-upload.spec.ts` (new) — an upload boots and rolls back |
| W22 | [W]  | `/modify` route: `revisions`, `activate`, `status`, `drop`                              | `src/site-do.ts`                                       | same spec — activate, rollback, retention                                        |
| W23 | [W]  | conflict between an uploaded package and a git remote, both directions                  | `src/site-do.ts`                                       | `tests/integration/modify-upload.spec.ts`                                        |
| W24 | [D]  | `detectProject()` for all four shapes, including the patch-listing refusal              | `src/modify/detect.ts` (new)                           | `tests/modify-detect.spec.ts` (new) — mantle2's real layout as a fixture         |
| W25 | [D]  | `modify init`, `modify status`                                                          | `src/commands/modify.ts` (new)                         | `tests/modify.spec.ts` (new)                                                     |
| W26 | [D]  | `modify diff`, `modify check` (with `php -l` and `--deps`)                              | `src/commands/modify.ts`, `src/modify/check.ts` (new)  | `tests/modify.spec.ts` — a lint failure, a `RECORD_CAP` overflow, a collision    |
| W27 | [D]  | `modify upload` — have/want, batching, commit, the rolled-back path                     | `src/commands/modify.ts`, `src/modify/upload.ts` (new) | `tests/modify.spec.ts` — batching against `MAX_BODY_BYTES`                       |
| W28 | [D]  | `modify revisions`, `activate`, `rollback`, `drop`                                      | `src/commands/modify.ts`                               | `tests/modify.spec.ts`                                                           |
| W29 | [D]  | `modify require`, `modify enable` against `/installable`, `/install`, `/enable`         | `src/commands/modify.ts`                               | `tests/modify.spec.ts` — the 409 conflict envelope and `force=1`                 |
| W30 | [D]  | `modify release --tag` and the dirty-tree refusal; `git` back in `TOOLS` as optional    | `src/commands/modify.ts`, `src/commands/doctor.ts`     | `tests/modify.spec.ts`, `tests/cli.spec.ts`                                      |
| W31 | [D]  | `dev --modify` + watch; `modify dev` as an alias                                        | `src/commands/workspace.ts`, `src/program.ts`          | `tests/workspace-cli.spec.ts` — the call ledger orders build/validate/wrangler   |
| W32 | [D]  | e2e: upload mantle2 into a real `wrangler dev` site and assert the module is discovered | `tests/e2e/modify.spec.ts` (new)                       | itself, behind `REQUIRE_CLONE`                                                   |

### Phase 5 — documentation

| #   | repo | what                                                     | files                   | test                                           |
| --- | ---- | -------------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| W33 | [D]  | README rewrite per 7.3                                   | `README.md`             | `bunx prettier --check .`                      |
| W34 | [D]  | `CLAUDE.md`: modify, the revision model, the new seams   | `CLAUDE.md`             | -                                              |
| W35 | [W]  | `docs/configuration.md`: `/modify`, `/updb`, W17's moves | `docs/configuration.md` | `tests/node/module-table.spec.ts` if it counts |

### Deploys and credentials

- **W6** (header rename) and **W19** (`CF_VERSION_METADATA`) can only be verified end to end on a
  deployed worker. Use a `cfw-*` name, tear it down, and verify `cf workers --compare` returns to
  baseline. Everything else in Phase 1-4 is reachable from `wrangler dev --local`.
- **W29** and **W26 `--deps`** reach `packages.drupal.org` and `repo.packagist.org` unauthenticated.
  No credential; they do need network and belong behind the e2e lane's existing gates.
- **W32** needs the pack, so it belongs in `ARTIFACT_SPECS` reasoning: on a clean checkout with no
  release payload it must skip with a named reason rather than fail.
- Nothing here needs a Cloudflare API token beyond what `cf workers` already uses.

---

## 9. Refused

**The Workers Versions API and preview URLs, for previewing a module revision.**
Cloudflare's own documentation: _"Preview URLs are not generated for Workers that implement a Durable
Object, including Containers and Sandbox Workers."_
(`developers.cloudflare.com/workers/configuration/previews`). `wrangler.jsonc` declares
`durable_objects.bindings` for `SitePhpDurableObject`, so drupflare is exactly that Worker, and the
mechanism is unavailable at any price. Two further findings from the same research, each independently
sufficient:

- _"Versions of Worker bundles that change Durable Object class lifecycle cannot be uploaded"_, and a
  gradual deployment resets a Durable Object when it is assigned a different version
  (`versions-and-deployments/gradual-deployments/with-durable-objects`). A reset drops the interpreter
  and every in-flight request on that object.
- **It is the wrong artifact anyway.** The thing being previewed is a module revision inside one
  site's Durable Object storage. A Worker version is code shared by every site in the namespace.
  Uploading a version to preview one customer's module change would put that change in front of every
  site.

Gradual deployments themselves **are** free-plan reachable (open beta, Free / Paid / Enterprise), and
the versions REST surface exists at `/accounts/{id}/workers/scripts/{name}/versions`. Neither helps
here.

**The mechanism is closed; the objective is not.** "See a module change on the real site before it
becomes what visitors get" is served by section 5's per-site revision table: `commit --no-activate`
stores it, `activate` makes it live, `rollback` reverses it, and the worker's existing
`git_previewof_*` machinery already proves the shape works — a preview pins the site at a revision and
stops the poller and the webhook from replacing it (`site-do.ts:9920`, `4128`).

**The one part of the versions surface worth keeping** is identity: `CF_VERSION_METADATA` is already
bound and already discarded (G16). Reading it on `/health` answers "which worker code is serving this
site", which is a question `drangler status` cannot answer today. That is W19, and it is the surviving
half of the refused mechanism rather than a consolation.

---

**A patch listing as a `modify` source.** A directory of `*.patch` files is not a module tree: applying
a patch needs the thing it patches, which is Drupal core or a contrib module that lives on the site
rather than on the developer's disk. Applying patches host-side would mean shipping a patch engine
into the Durable Object and reconciling it with `/install`'s registry-driven tree. `detectProject()`
refuses it by name and points at the two real answers: patch the checkout and upload the result, or use
`composer-patches` in a Drupal source tree and upload the patched module directory. Reopen if a user
brings a case the two answers do not cover.

**Response-level diffing between local dev and a live site.** Proposed as part of `modify dev`. The
comparison is not well defined: the two sites have different generations, different cache tiers,
different session state and different `x-cfw-plan` verdicts, so a byte diff of two renders reports
noise. The worker's own instrument history is full of exactly this failure — comparing two arms
produced under conditions that were not the same. `modify diff` at the file level answers the question
people actually have. Reopen with a stated normalisation.

**A `migrate import` counterpart to `migrate export`.** Unchanged from the existing refusal: `/restore`
overwrites a whole database from a request body and is diagnostic-only for that reason. The
asymmetry is the security property.

**Vendoring the worker's `planSync` / `selectFiles` into drangler so `modify diff` can compute the
plan locally.** That is the drift `CLAUDE.md`'s three-disposition table exists to prevent, and the
`invoke` disposition already covers it: `modify diff` asks the site for the plan via
`/modify?action=plan`, which costs one DO request and writes nothing. `lineDelta()` is the one
exception worth arguing about, and it stays on the worker too — the CLI prints what the site computed.

**A delete seam on `FileHost` so `build --force` can re-clone.** Unchanged. `modify` writes nothing to
a local tree at all, so it adds no pressure on this.

**Making `drangler heal` able to force a rollback.** `shouldRollback()` refuses far more often than it
agrees, deliberately, and every refusal names a mechanism (no restore point, dwell not elapsed, the
lower rungs own it). A `--force-rollback` would be a flag whose only job is defeating a guard.
`heal` prints the decision and its reason and stops there.

**Auto-enabling a module after `modify upload`.** `/install` and `/enable` are separate on the worker
because a package that has landed is not a module Drupal knows about and the two have different
failure modes. `modify upload` lands files; `modify enable` is the next command. Folding them would
hide an enable failure behind an upload success.
