# 🔧 drangler

> Start, maintain and migrate a drupflare site, in either direction

[![Build](https://github.com/drupflare/drangler/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/drangler/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/drangler/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/drangler/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/drangler/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/drangler)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stands a Drupal site up on Cloudflare Workers in one line, moves an existing one on or off, and
tells you what will break before you start.** Both directions. Four commands write; every other one
reads.

---

## 📋 Table of Contents

- [Install](#-install)
- [Quick Start](#-quick-start)
- [Site Lifecycle](#-site-lifecycle)
- [Commands](#-commands)
- [Workspaces](#-workspaces)
- [Validation](#-validation)
- [Migrating to Workers](#-migrating-to-workers)
- [Migrating Back to a VPS](#-migrating-back-to-a-vps)
- [Installing a Migrated Site](#-installing-a-migrated-site)
- [Dialect Conversion](#-dialect-conversion)
- [Cloudflare Access](#-cloudflare-access)
- [Exit Codes](#-exit-codes)
- [Out of Scope](#-out-of-scope)
- [Testing](#-testing)
- [Related Repositories](#-related-repositories)
- [License](#-license)

---

## 📥 Install

```sh
bun add -g @drupflare/drangler
```

Or build the single-file binary, which carries its own runtime:

```sh
bun run build:binary # dist/drangler
```

`git`, `ssh` and `wrangler` are needed on the machine running drangler. `drangler doctor` reports
which are present and how to install the ones that are not.

---

## 🚀 Quick Start

A local Drupal to click around in, from nothing:

```sh
drangler dev
```

That clones `drupflare/worker`, downloads the generated Drupal tree and the PHP interpreter, checks
the result, and runs `wrangler dev`. Run it again and it reuses the workspace instead of starting
over. When you like what you see:

```sh
drangler deploy
```

Moving an existing site starts by reading it:

```sh
drangler migrate survey --host deploy@old.example --root /var/www/html --out survey.json
drangler migrate plan --survey survey.json --to workers
```

Check the destination once it is up:

```sh
drangler status drupflare.example             # what is deployed
drangler health drupflare.example --skip-edge # is it serving, and from which tier
```

`status` answers "what am I running" from a single public request: no credential, no diagnostic
route, and nothing on disk. `health` answers "is it up and which tier answered", which is the one to
put in a monitor.

---

## 🧭 Site Lifecycle

What happens between a `deploy` and a site you can log in to. The same sequence runs for
`drangler dev`, the one-click Deploy to Cloudflare button, and `wrangler deploy` in a checkout.

### First Boot

A fresh site has an empty Durable Object, and the first request is what starts it. Until the packed
database has finished replaying, every request gets a **503** carrying `x-cfw-migrate` and
`x-cfw-migrate-state`; a browser sees a self-refreshing page and lands on the site by itself.

**Measured on a deployed worker: 4 to 7 polls at 2 s, so 8 to 14 seconds from the first request to
the first 200.** `health` calls that `warming` and exits `0`, and names the chunk it is on:

```sh
drangler health my-site.example --skip-edge
# verdict  warming
# notes
#   - replaying the database, chunk 31/62 (running); a fresh site does this once, and a 503
#     until it finishes is expected
```

### Claiming

The pack ships an **installed** database, so Drupal's `install.php` never runs and uid 1 carries a
hash no password matches. `/firstrun` is what sets the administrator password, and until it does,
whoever reaches the URL first can claim the site. A browser navigating to an unclaimed site gets a
one-click claim page instead of the front page.

`status` reports the claim state and exits `3` while the window is open:

```sh
drangler status my-site.example
# claimed  unclaimed
# notes
#   - nobody has claimed this site: uid 1 has no usable password and whoever reaches the URL
#     first can set one. POST /firstrun to claim it, and store the adminPass and ownerToken
#     it returns
```

Claim it in the browser, or from a terminal:

```sh
curl -X POST "https://my-site.example/firstrun" \
  -H 'content-type: application/json' \
  -d '{"siteName":"My Site","adminMail":"you@example.com"}'
```

The response carries **`adminPass` and `ownerToken`, each shown once and stored nowhere.** Save both.
A site that answered `/firstrun` before this drangler could ask reports `unknown` rather than
`unclaimed`, because "I could not tell" and "nobody has claimed it" are different answers.

### Logging In and the Owner Token

Log in at `/user/login` as `admin` with the `adminPass`. That is the Drupal account.

**The `ownerToken` is a separate credential and is not a login.** It goes in an `Authorization:
Bearer` header and reaches `/export`, `/health`, `/setup/cf` and `/setup/mail` without exposing the
diagnostic routes. drangler reads it from `--token` or `DRUPFLARE_OWNER_TOKEN`:

```sh
export DRUPFLARE_OWNER_TOKEN=...
drangler migrate export --url my-site.example --out worker.sql
```

`secrets scan` knows the shape of both that token and a pasted `CF_EMAIL_TOKEN`, so a dump or a
`.env` carrying either is a finding rather than a surprise.

### Running Day to Day

| Question                                   | Command                             |
| ------------------------------------------ | ----------------------------------- |
| What is deployed, and has it been claimed? | `drangler status <target>`          |
| Is it up, and which tier answered?         | `drangler health <target>`          |
| Is my machine set up to work on it?        | `drangler doctor`                   |
| Will this config deploy?                   | `drangler config check <file>`      |
| Which Cloudflare credential am I using?    | `drangler cf whoami`                |
| Did a throwaway deploy leave anything?     | `drangler cf workers --compare <f>` |
| Is there a credential in this artifact?    | `drangler secrets scan <paths...>`  |
| Move to a newer Drupflare                  | `drangler update [worker]`          |
| Get my data out                            | `drangler migrate export`           |

`update` picks what it is updating from what it was given. With no argument it fast-forwards the
local checkout and rebuilds the artifacts belonging to the version it left behind; naming a worker
updates the checkout and deploys it there. `--to <ref>` moves to a named version rather than the
latest, and a dirty tree is refused before anything is fetched.

```sh
drangler update             # the local checkout, to the latest
drangler update --to v0.3.0 # or to a named version
drangler update my-site     # and deploy it to an existing worker
```

### Connecting Cloudflare and Sending Mail

Both are HTTP flows on the site itself rather than drangler commands, because both are
owner-authenticated and one of them is an OAuth consent screen that has to complete in a browser:

- **`GET /setup/cf?action=connect&client_id=<id>`** returns an authorize URL; `?action=status` and
  `?action=disconnect` are the other two actions. Pasting `CF_EMAIL_ACCOUNT_ID` and `CF_EMAIL_TOKEN`
  is the alternative and needs no OAuth client.
- **`GET /setup/mail?zone=<zone-id>`** reports which of five stages the sending domain is waiting on;
  `?action=apply` creates the subdomain and writes the DNS.

The contracts live in
[`worker/docs/configuration.md`](https://github.com/drupflare/worker/blob/master/docs/configuration.md)
under **Connecting a Cloudflare Account** and **Onboarding a Sending Domain**. drangler does not
restate the stage vocabulary; that has one implementation, in the worker.

---

## 🔧 Commands

| Command                   | What it does                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `build`                   | Clone `drupflare/worker` and build it into a deployable tree       |
| `validate`                | Everything that has to hold before `dev` or `deploy` will work     |
| `dev`                     | Build if needed, check, then run a local Drupal                    |
| `deploy`                  | Build if needed, check, then deploy to your Cloudflare account     |
| `update [worker]`         | Move a checkout to another version, and the worker running it      |
| `status <target>`         | What is deployed: plan, generation, claim state, diagnostics       |
| `doctor`                  | Preflight the toolchain and the Cloudflare credential              |
| `health <target>`         | Probe a deployed worker or a VPS Drupal and report what answered   |
| `config check <file>`     | Score a wrangler config against known-bad deployments              |
| `cf whoami`               | Which Cloudflare credential drangler would use                     |
| `cf workers`              | List the account workers, and compare against a saved baseline     |
| `cf cpu <capture>`        | Summarise a `wrangler tail` capture, refusing an untrustworthy one |
| `secrets scan <paths...>` | Find credentials in a dump or a tree, without printing them        |
| `migrate survey`          | Read a VPS Drupal over SSH: versions, database, modules, files     |
| `migrate plan`            | Score a survey and order the work, in either direction             |
| `migrate export`          | Pull a deployed site's database out through `/export`              |
| `migrate convert`         | Convert a SQL dump between MySQL and SQLite                        |
| `migrate install`         | Land a migrated database or asset in a workspace, with a backup    |
| `migrate restore`         | Put a backup set back where it came from                           |

Every command takes `--json` and prints the same object its text render is built from.

**`build`, `dev`, `deploy`, `update` and `migrate install` are the five that write.** The first four
write to a local workspace and to your own Cloudflare account through your own `wrangler`; the last
writes to a workspace and backs up anything it replaces first. Nothing in drangler deletes a file or
a directory.

---

## 📁 Workspaces

A workspace is a checkout of [`drupflare/worker`](https://github.com/drupflare/worker) with its
generated tree in place: 22 MB of Drupal packs and the PHP 8.5 interpreter, neither of which is in
the repository. `drangler build` produces one in four steps, of which `refresh` is opt-in.

| Step      | Command                          | Skipped when                        |
| --------- | -------------------------------- | ----------------------------------- |
| `clone`   | `git clone --depth 1 --branch …` | the workspace is already a checkout |
| `refresh` | `git fetch` + `merge --ff-only`  | not asked for, with `--refresh`     |
| `install` | `bun install`                    | `node_modules` is populated         |
| `hydrate` | `bun run hydrate`                | every generated artifact is on disk |

**Each step asks the disk whether its output exists, not a lock file whether it ran.** So an
interrupted build resumes at the step that did not finish, a finished one downloads nothing, and
`drangler dev` twice in a row clones once.

Where the workspace goes, in order: `--workspace`, then `DRANGLER_WORKSPACE`, then the working
directory when that is itself a worker checkout, then `.drupflare/worker` under it. `--source` and
`DRANGLER_WORKER_SOURCE` change where the clone comes from and take a local path as readily as a
URL, which is how a fork or an offline copy is used.

`--refresh` runs `git fetch` and `git merge --ff-only`, and refuses outright when the checkout has
uncommitted changes in it. `--force` re-runs `install` and `hydrate`; it never re-clones, because
that would mean deleting a tree.

---

## ✅ Validation

`drangler validate` runs five checks against a workspace. Each one reports a fix, and a check that
could not be made is reported as such rather than as a pass.

| Check       | What it proves                                                            | Runs for    |
| ----------- | ------------------------------------------------------------------------- | ----------- |
| `workspace` | `package.json` names `@drupflare/worker`                                  | dev, deploy |
| `artifacts` | every generated path is on disk, interpreter included                     | dev, deploy |
| `config`    | the wrangler config carries none of the blockers this project has shipped | dev, deploy |
| `scrub`     | the per-file pack carries no seeded secret                                | deploy      |
| `bundle`    | `wrangler deploy --dry-run` fits the 3 MiB free-plan ceiling              | deploy      |

**`dev` gates on three of them and `deploy` on all five**, because `wrangler dev` bundles locally and
never uploads: the size ceiling does not apply to it and it publishes no pack. `--only` runs a
subset; `--skip-validate` on `dev` or `deploy` bypasses the gate entirely.

The size figure is the one `wrangler deploy` prints, not a local gzip. The interpreter list is read
out of the config's own `php-binary` alias and the seam it points at, so a checkout whose alias
resolves to the fallback binary is reported rather than deployed at 710,410 bytes over the ceiling.
The pack check runs the checkout's own `assets:scrub:check`; drangler does not open the pack.

Exit `3` means a check ran and found something, and `1` means a check could not run. A CI step can
read the status instead of grepping the output.

---

## 🚚 Migrating to Workers

`migrate survey` runs ten read-only commands over SSH and folds them into one record: PHP version and
loaded extensions, Drupal version and install profile, database driver and size, the public files
directory, the enabled module list, the node count and the image style count.

`--dry-run` prints the command plan and connects to nothing, so the list can be reviewed before an
SSH key is handed over:

```sh
drangler migrate survey --host deploy@old.example --root /var/www/html --dry-run
```

`--replay <transcript.json>` drives the same survey from recorded output, which is how a survey
captured on a machine that can reach the host gets re-planned anywhere.

`migrate plan` scores that survey. Findings come in three severities and each one carries its
mechanism:

| Finding                 | Severity | What it means                                                         |
| ----------------------- | -------- | --------------------------------------------------------------------- |
| `db-driver`             | varies   | MySQL and MariaDB convert; SQLite needs nothing; anything else blocks |
| `incompatible-modules`  | blocker  | Redis, Memcache, MongoDB, ImageMagick: raw TCP or a process spawn     |
| `service-modules`       | warning  | Solr and Backup & Migrate: runnable, but nothing provisions them      |
| `php-version`           | warning  | the source runs older than the interpreter the destination runs       |
| `ext-archive`           | warning  | the source loads `zip` or `Phar`; the wasm build has neither          |
| `image-transforms`      | warning  | styles times files against a 5,000/month Cloudflare Images cap        |
| `files-payload`         | warning  | public files exceed the 25 MiB per-asset ceiling the pack is built to |
| `database-size`         | warning  | large enough to meet the 100,000-character statement ceiling          |
| `regeneration-ceiling`  | varies   | nodes against 1,052 renders/day cold, 7,575 with a fill window        |
| `drush-absent`          | warning  | without drush most of the survey is blank and the plan scores nothing |
| `shellout-undetectable` | note     | a module calling `exec()` cannot be found from a survey               |
| `cron`                  | note     | system cron becomes a `*/5` Cron Trigger                              |

Fields the survey did not measure are listed under **NOT MEASURED** rather than scored as passes.

**The destination's PHP version is stated on every plan, with where it came from.** Only `/php`
reports it and that route is diagnostic-gated, so on a correctly configured deployment it cannot be
read and the plan says `assumed`. `--target-php <version>` states it; `--site <origin>` reads it from
a deployment that does expose it. A figure that was not measured is never printed as though it was.

---

## 🔙 Migrating Back to a VPS

```sh
drangler migrate plan --to vps
drangler migrate export --url drupflare.example --out worker.sql
drangler migrate convert --from sqlite --to mysql --in worker.sql --out vps.sql
```

`migrate export` reads `/export?body=1`, which is `dumpDatabase()` in `drupflare/worker`. Four things
about that path are worth knowing before relying on it:

- **`/export` needs the site owner token.** It sits on the owner tier: pass `--token`, or set
  `DRUPFLARE_OWNER_TOKEN`. The token is minted per site and returned once by `/firstrun` as
  `ownerToken`. Without one the route answers 401 with a `WWW-Authenticate: Bearer` challenge, and
  drangler reports that as a missing credential rather than a missing route. `/restore` and `/sql`
  remain diagnostic-only, which is why there is no import counterpart to this command.
- **Some tables come back as schema with no rows.** Which ones is reported in the envelope's
  `structureOnly` field and printed verbatim; drangler does not restate the rule. `--all` includes
  their rows, and the worker answers 409 when that produces a dump it knows cannot be replayed.
- **Managed files are not in the export.** User uploads live outside the database and outside the
  Drupal pack; copy them separately.
- **The hash salt does not travel.** The shipped tree assigns an empty `$settings['hash_salt']` and
  the object mints one per site. A restored VPS needs its own, and links minted by the worker stop
  validating.

---

## 📦 Installing a Migrated Site

`migrate convert` writes a dump; `migrate install` puts the result into a workspace and backs up
whatever it replaces.

```sh
sqlite3 site.sqlite < vps.sql
drangler migrate install --db site.sqlite --repack
```

`--db` takes a SQLite database file, not a SQL dump, and `--repack` runs the checkout's
`bun run assets:sql` afterwards, which is what turns the database into the chunks the worker
replays. Without it the database is on disk and the site still serves the old one, which the report
says. `--asset <from>=<to>` lands any other file at a workspace-relative destination.

Three rules govern every write:

- **Backups come first, all of them, before a single byte is written.** Each one is verified by
  digest against the file it copied; a backup that does not read back stops the run before anything
  is overwritten.
- **A byte-identical file is neither backed up nor written.** Re-running an install does not fill a
  backup directory with files that never changed.
- **A backup set is restorable with one command.** `.drangler-backup/<timestamp>/backup.json`
  records every original path and digest, and `migrate restore --backup <dir>` verifies the whole
  set before it writes any of it.

```sh
drangler migrate install --db site.sqlite --dry-run # what would be written, and what backed up
drangler migrate restore --backup .drupflare/worker/.drangler-backup/20260815T031500000Z
```

---

## 🔄 Dialect Conversion

`migrate convert` reads a `mysqldump` or a SQLite dump and writes the other. It refuses rather than
guesses: an unconvertible statement is an error naming the statement, and `--skip-unsupported`
downgrades that to a recorded skip.

| Handled                | Detail                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| statement splitting    | a scanner, so a semicolon inside serialized PHP does not split a row          |
| type mapping           | MySQL widths onto SQLite's storage classes, and SQLite's back out wide        |
| `AUTO_INCREMENT`       | becomes `INTEGER PRIMARY KEY AUTOINCREMENT`, with no duplicate key            |
| `KEY` and `UNIQUE KEY` | lifted into `CREATE INDEX`, renamed `<table>__<index>`                        |
| key prefix lengths     | added on the way to MySQL, which cannot index a TEXT column without one       |
| string escaping        | MySQL backslash escapes decoded, then re-encoded for the target               |
| values carrying NUL    | `CAST(x'..' AS TEXT)` into SQLite, a bare hex literal into MySQL              |
| blob literals          | `0xAB` and `x'AB'` swapped both ways, including the empty one                 |
| charset declaration    | `SET NAMES utf8mb4`, without which a 4-byte character is refused              |
| multi-row `INSERT`     | split one row per statement into SQLite, under `--no-split-rows`              |
| the statement ceiling  | a row over 100,000 characters is refused, because a Durable Object refuses it |

| Refused                                           | Why                                                   |
| ------------------------------------------------- | ----------------------------------------------------- |
| `CREATE TRIGGER`, `VIEW`, `PROCEDURE`, `FUNCTION` | the body is dialect-specific                          |
| `ALTER TABLE`                                     | SQLite supports a subset and the difference is silent |
| `INSERT ... ON DUPLICATE KEY UPDATE`              | no SQLite equivalent                                  |
| a type with no storage class, such as `geometry`  | mapping it would change what the column holds         |
| a row wider than the target accepts               | `--skip-unsupported` drops it and names the table     |

**A real Drupal 11 dump does not fit a Durable Object.** `cache_container` holds a single row far
over the 100,000-character statement ceiling, so a converted dump that looks complete replays into a
plain SQLite and dies part-way into the destination that matters. Conversion refuses those rows by
width and names them; `--skip-unsupported` keeps their schema and drops the rows. Which tables
breach it is a property of the site, so the ceiling is the rule rather than a table list.

Conversions that succeed but do not round-trip are reported as **lossy**: a dropped index prefix
length, a dropped `FULLTEXT` index, a SQLite `NUMERIC` given an invented scale, and a MySQL key
narrowed to the first 191 characters of a text column, which changes what uniqueness means.

---

## 🔑 Cloudflare Access

`cf whoami` resolves the credential in the order wrangler itself resolves it: `CLOUDFLARE_API_TOKEN`
first, then the `wrangler login` OAuth session. When there is neither it says which command to run.

`cf workers` lists the account's workers and compares them against a saved baseline:

```sh
drangler cf workers --save baseline.json
# deploy a throwaway worker, measure, tear it down
drangler cf workers --compare baseline.json
```

It exits 3 when the list differs, naming what was added and what went missing. The REST call needs a
token; the OAuth credential `wrangler login` writes cannot be read by anything but wrangler.

`cf cpu` reads a saved `wrangler tail --format json` capture and summarises cpuTime per execution
model, reporting the spread rather than a median alone. It refuses a capture holding stateless events
and no `durableObject` event: tail has been measured dropping those silently while the Workers
Observability API reported the same invocations, so a capture in that shape is an instrument failure
rather than a measurement.

---

## 🚦 Exit Codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | ok                                                            |
| `1`  | the check could not run                                       |
| `2`  | bad input                                                     |
| `3`  | the check ran and found something: blockers, secrets, a drift |

---

## 🚫 Out of Scope

- **It does not delete.** No command removes a file, a directory, a worker or a remote object.
  `build --force` re-runs the build steps and never re-clones; a workspace holding something other
  than a worker checkout is refused rather than cleared.
- **It does not hold a Cloudflare deploy credential.** `deploy` runs your `wrangler`, which uses the
  login you already have. drangler never reads it.
- **It does not write to a remote host.** The survey command plan is read-only by construction, and
  there is no counterpart to `migrate export` that posts to `/restore`.
- **It does not move a public files tree.** `migrate plan` emits the `rsync` line; those bytes are
  yours to copy. `migrate install` lands a database and named assets, not a Drupal file system.
- **It does not build the Drupal packs.** Those are generated in `drupflare/worker`, where the
  hand-trimmed database that feeds them lives. `drangler build` runs that repository's own pipeline
  inside a checkout of it.
- **It does not read a per-file pack.** That format has one implementation, in `drupflare/worker`,
  and a second copy would drift from it. The pack check runs that repository's own scrubber.

---

## 🧪 Testing

Two lanes. The gate is hermetic; the integration lane needs Docker.

```sh
bun run typecheck
bun run test # 547 assertions across 18 specs, no network, no daemon
bun run test:coverage

bun run test:e2e       # 35 assertions across 5 specs, against a real Drupal
bun run test:e2e:clone # the clone lane alone; no Docker, about ten seconds
bun run e2e:down       # remove the containers and their volumes
```

**547 passing** in the gate at **98.33% statements**, with every external effect behind an injected
seam: the terminal, the filesystem, subprocesses, `fetch`, and the environment. No gate test opens a
socket, reaches a VPS, contacts Cloudflare, or clones a repository. The workspace commands are
covered against a scripted runner whose build steps land the files they really produce, so the gate
scores itself against a tree the build made rather than against an empty directory.

**35 passing** in the integration lane, which boots MariaDB and a real Drupal 11 in Docker, runs the
survey over a real SSH connection, and drives a real Durable Object under `wrangler dev`. Both
migration directions are asserted byte for byte, and the comparator reads hex through a different
path from the one that moved the data. Alongside it, the clone lane builds a workspace out of the
published `drupflare/worker` with the real runner and the real filesystem, which is the only place
`git clone`, `bun install` and the interpreter alias are read from the thing that ships rather than
from a fixture. Three more assertions cover hydrating a release payload and wait on the first tag.
`tests/e2e/README.md` covers the topology, the seed corpus and its gaps, and the planted defects
that prove the lane can fail.

Two requirements, two gates, two jobs in `.github/workflows/e2e.yml`. Each skips when what it needs
is absent and fails when the lane declares it: `REQUIRE_DOCKER=1` for the Drupal half,
`REQUIRE_CLONE=1` for the clone half.

---

## 🔗 Related Repositories

| Repository                                                          | What it is                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)           | Drupal 11 on Cloudflare Workers; the thing this migrates to |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge)     | running a blocking interpreter inside a Durable Object      |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb)     | the measured limits of Durable Object SQLite                |
| [`drupflare/untarl`](https://github.com/drupflare/untarl)           | tar and tar.gz extraction with no Node APIs                 |
| [`drupflare/stream-http`](https://github.com/drupflare/stream-http) | an `https://` stream wrapper for PHP builds with no sockets |

---

## 📄 License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
