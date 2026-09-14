# drangler

> Start, maintain and migrate a drupflare site, in either direction

[![Build](https://github.com/drupflare/drangler/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/drangler/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/drangler/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/drangler/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/drangler/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/drangler)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Stands a Drupal site up on Cloudflare Workers in one line, moves an existing one on or off, develops
a module against it, and tells you what will break before you start.

---

## Install

```sh
bun add -g @drupflare/drangler
npm i -g @drupflare/drangler
```

Every release also carries a single-file binary that needs no runtime, for Linux, macOS and Windows
on x64 and arm64. Download the archive for your platform from the
[releases page](https://github.com/drupflare/drangler/releases), verify it against the `SHA256SUMS`
beside it, and put `drangler` on your `PATH`.

From a checkout, `bun run build:binary` writes the same thing to `dist/drangler`.

`ssh` and `wrangler` are required on the machine running drangler; `git`, `bun` and `rsync` are used
by some commands and optional for the rest. `drangler doctor` reports which are present, how to
install the ones that are not, and which config file supplied each setting.

---

## Quick Start

A local Drupal to click around in, from nothing:

```sh
drangler dev
```

That clones `drupflare/worker`, downloads the generated Drupal tree and the PHP interpreter, checks
the result, and runs `wrangler dev`. Run it again and it reuses the workspace instead of starting
over. When you like what you see:

```sh
drangler deploy
drangler site claim my-site.example
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

## Configuration

Every setting resolves in the same order, most specific first: a flag, then the environment
variable, then a `drangler.json` in the nearest ancestor of the working directory, then
`$XDG_CONFIG_HOME/drangler/config.json` (or `~/.config/drangler/config.json`), then the built-in
default. `drangler config where` prints which file supplied each value.

```jsonc
{
  "site": { "origin": "https://my-site.example", "name": "site" },
  "module": { "root": ".", "package": "mantle2" },
  "workspace": ".drupflare/worker"
}
```

`--profile <name>` selects a named block inside either file; `--config-file <path>` replaces the
search. `drangler init` writes the file after asking at most five questions, and `drangler modify
init` writes the module half of it.

**The owner token never goes in `drangler.json`.** That file is committed. It lands in the global
config under `sites["<origin>"].ownerToken` at mode `0600`, and the commands that write it say where
it went.

These flags are inherited by every command:

| Flag                | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `--json`            | stdout is one JSON object, the same one the text is built from |
| `--quiet`, `-q`     | suppress progress on stderr; the report still prints           |
| `--verbose`, `-v`   | every subprocess argv and every request line, on stderr        |
| `--site <origin>`   | the site to act on, always an origin                           |
| `--site-name <n>`   | the Durable Object identity, when the site does not resolve it |
| `--profile <name>`  | which config block to read                                     |
| `--config-file <p>` | a config file, which replaces the search                       |
| `--yes`, `-y`       | consent for anything that writes to a live site                |
| `--dry-run`         | print the plan, execute nothing                                |
| `--timeout <ms>`    | per-request timeout                                            |
| `--token <token>`   | the owner token; also read from `DRUPFLARE_OWNER_TOKEN`        |

`--site` takes an origin and refuses a bare word by naming `--site-name`, which is the Durable
Object identity. It has no default. A site resolves its own identity from the host it was reached
on, and `/firstrun` ignores the parameter, so a name drangler supplied would put the claim and every
owner call after it on different objects.

---

## Site Lifecycle

What happens between a `deploy` and a site you can log in to. The same sequence runs for
`drangler dev`, the one-click Deploy to Cloudflare button, and `wrangler deploy` in a checkout.

### First Boot

A fresh site has an empty Durable Object, and the first request is what starts it. Until the packed
database has finished replaying, every request gets a 503 carrying `x-cfw-migrate` and
`x-cfw-migrate-state`; a browser sees a self-refreshing page and lands on the site by itself.

Measured on a deployed worker: 4 to 7 polls at 2 s, so 8 to 14 seconds from the first request to the
first 200. `health` calls that `warming` and exits `0`, and names the chunk it is on:

```sh
drangler health my-site.example --skip-edge
# verdict  warming
# notes
#   - replaying the database, chunk 31/62 (running); a fresh site does this once, and a 503
#     until it finishes is expected
```

`drangler site upgrade` polls that to completion and then runs the Drupal update chain, so a deploy
and the two things that follow it are one command.

### Claiming

The pack ships an **installed** database, so Drupal's `install.php` never runs and uid 1 carries a
hash no password matches. `/firstrun` is what sets the administrator password, and until it does,
whoever reaches the URL first can claim the site.

```sh
drangler site claim my-site.example --title "My Site" --save
# claimed         yes, by this run
# admin password  <shown once>
# owner token     <shown once>
# token saved to  ~/.config/drangler/config.json
```

The password goes in a JSON body. The route refuses `?pass=` outright, because a query string lands
in tail, in observability and in every intermediary between the terminal and the object. `--save`
writes the token to the global config; without it the token is printed and nothing is written, which
is the right answer in a pipe.

`site claim` exits `3` when the site was already claimed, so a script can tell "I claimed it" from
"somebody else did". `status` reports the same state before anything is spent:

```sh
drangler status my-site.example
# claimed  unclaimed
```

A site that answered `/firstrun` before drangler could ask reports `unknown` rather than `unclaimed`,
because "I could not tell" and "nobody has claimed it" are different answers.

### The Owner Token

Log in at `/user/login` as `admin` with the `adminPass`. That is the Drupal account.

**The `ownerToken` is a separate credential and is not a login.** It goes in an `Authorization:
Bearer` header and reaches the owner routes without exposing the diagnostic ones. Everything under
`drangler site`, `drangler heal` and `drangler modify` needs it, and so does `migrate export`:

```sh
export DRUPFLARE_OWNER_TOKEN=...
drangler migrate export --url my-site.example --out worker.sql
```

`secrets scan` knows the shape of both that token and a pasted `CF_EMAIL_TOKEN`, so a dump or a
`.env` carrying either is a finding rather than a surprise.

### Running Day to Day

| Question                                     | Command                             |
| -------------------------------------------- | ----------------------------------- |
| What is deployed, and has it been claimed?   | `drangler status <target>`          |
| Is it up, and which tier answered?           | `drangler health <target>`          |
| Is anything wrong with it?                   | `drangler heal <target>`            |
| Is it on the pack that ships today?          | `drangler reconcile <target>`       |
| How much of it has a stored page?            | `drangler sweep <target>`           |
| Is anything wrong with the VPS I am leaving? | `drangler doctor --source <target>` |
| Can this site move, and what breaks?         | `drangler migrate eligibility`      |
| Is my machine set up to work on it?          | `drangler doctor`                   |
| Will this config deploy?                     | `drangler config check <file>`      |
| Which optional levers does it declare?       | `drangler config levers <file>`     |
| Which Cloudflare credential am I using?      | `drangler cf whoami`                |
| Did a throwaway deploy leave anything?       | `drangler cf workers --compare <f>` |
| Is there a credential in this artifact?      | `drangler secrets scan <paths...>`  |
| Move to a newer Drupflare                    | `drangler update [worker]`          |
| Deploy and finish the upgrade                | `drangler site upgrade <target>`    |
| Clear a cache                                | `drangler site invalidate <target>` |
| Get my data out                              | `drangler migrate export`           |

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

## Modify

`drangler modify` develops a custom module against a deployed site. A revision is an immutable,
content-addressed manifest of one package's files, stored in that site's Durable Object: uploading a
one-file edit sends one file, and rolling back sends nothing at all.

```console
$ cd ~/work/mantle2
$ drangler modify init --site https://my-site.example
detected      module-project (/work/mantle2/mantle2.info.yml)
package       mantle2
mounts to     modules/custom/mantle2
files         412
site          https://my-site.example (claimed)
owner token   set

wrote
  /work/mantle2/drangler.json
  /home/me/.config/drangler/config.json (mode 0600)

$ drangler modify check --php php --deps
package     mantle2
mounts to   modules/custom/mantle2
files       412 kept, 1908 skipped
bytes       1.8 MB in 2 batch(es)
lint        412 of 412 ok (php 8.4.12)
paths       no collision inside this project

$ drangler modify upload --message "add the streak service"
package     mantle2
plan        412 files, 6 not on the site, 406 already there
rows        6
uploading   6 blob(s), 41.2 kB, 1 batch(es)
commit      rev 9f2c1ab4
verify      kernel booted

$ drangler modify rollback --yes
package   mantle2
active    rev 3d81ee07
verify    kernel booted
```

| Subcommand              | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `modify init [dir]`     | link a project to a site and write down where the answers went |
| `modify status`         | what is live on the site, against what is on this disk         |
| `modify diff`           | which files would be sent; exits 3 on a difference             |
| `modify check`          | everything knowable before bytes leave the machine             |
| `modify upload`         | send what the site is missing and make the result live         |
| `modify revisions`      | the stored revisions of a package, newest first                |
| `modify activate <rev>` | make a stored revision live, with no bytes on the wire         |
| `modify rollback`       | activate the revision before the active one                    |
| `modify drop <rev>`     | delete a stored revision and the blobs nothing else names      |
| `modify release --tag`  | upload from a tagged commit, refusing a dirty tree             |
| `modify require <name>` | install a package from a registry, and optionally turn it on   |
| `modify enable <name>`  | turn a module on, once its files are on the site               |
| `modify dev`            | `drangler dev --modify .`                                      |

**A commit is verified by a real kernel boot.** A module that installs cleanly and fatals on boot
would take the whole site down, so the site restores the previous file set and the upload exits `1`
saying so. A syntax check cannot see that: a missing service fails when the container is built, not
when the file is written.

Four project shapes are detected, and detection names the file it decided from. A module or theme
project, a Drupal source tree (`modules/custom/*`, `themes/custom/*`, `profiles/custom/*` only), a
bare module directory, and a directory of patches, which is refused by name. Applying a patch needs
the thing it patches, which lives on the site rather than on the developer's disk; patch the checkout
and upload the result, or use `composer-patches` in a source tree and upload the patched directory.

Contrib is not uploaded. A package with a registry entry belongs to the registry:

```sh
drangler modify require drupal/key drupal/redis --enable
```

`drangler dev --modify <dir>` mounts a local project into the local dev site and re-uploads on
change. The dev site's owner token is minted for the process and never written to disk.

---

## Healing

`drangler heal` reads the repair ladder, the tripwire findings, the health ledger and the rollback
decision, and exits `3` when a site is quarantined or a rollback is pending.

```sh
drangler heal my-site.example
# rung        quarantine
# code        bridge.asyncify_called
# strikes     3 of 3
# since       2026-09-08T04:12:09Z (48m)
# rollback    no -- quarantined 2880s of 1800s for bridge.asyncify_called
# advisories  current: nothing outstanding
# degraded    reduced (rows-written 0.83)
```

`--watch` re-reads until the site is clean or `--wait` runs out and writes nothing either way. A
quarantined site still serves; writes and the fill lane are what stop.

### Repairs

Every repair carries the class the worker documents for its route: **safe** changes nothing a visitor
sees, **rebuild** discards derived state that comes back on its own, **stateful** changes what the
site serves.

| repair                         | class    | gate                          | blast radius                            |
| ------------------------------ | -------- | ----------------------------- | --------------------------------------- |
| `--release` clear a quarantine | stateful | `--yes`                       | the site serves what quarantine stopped |
| `--replay` drive the replay    | stateful | `--yes`                       | none; the cursor only advances          |
| `--unpin <remote>`             | stateful | `--yes`                       | the poller owns the branch again        |
| `--armfill` re-arm a fill      | rebuild  | `--yes`, not while degraded   | the rows the drain writes               |
| `--invalidate <tags>`          | rebuild  | `--yes`, not while degraded   | the tagged pages re-render              |
| `--bump`                       | rebuild  | `--yes`, not while degraded   | **the whole site re-renders**           |
| `site updb --steps <n>`        | stateful | `--yes` + a snapshot decision | one site's schema                       |

A site already shedding load refuses the rebuild class with the driver named, because spending the
meter it is already shedding on is how a repair becomes the outage. A beat of the update chain needs
`--snapshot <dir>` or `--no-snapshot` on top of consent, and there is no default: `updbRollback()`
exists on the worker and no route reaches it, so the snapshot is the only rollback a CLI has.

`--unpin` reaches no network. `unpreview` re-syncs to the branch head and needs the remote to answer,
so a remote that is down holds its own pin in place while a pinned site takes no pushes and no polls.
Releasing without a sync leaves the site serving what it already serves and gives the poller the
branch back, so the next successful poll converges it.

`--auto` is the closest thing to unattended repair. It performs only the repairs that may run
unattended, still needs `--yes`, and stops at the first that may not:

```sh
drangler heal my-site.example --auto --yes
```

**A withdrawn replica lane is not on this list and does not need to be.** A lane that withdrew asks
the primary for a fresh copy itself and the primary queues it, so there is nothing to drive.
`/replica` stays diagnostic-only, and lane state is read through `/health` and `/serve-stats`.

Three things stay on the site by design. A rollback is a decision the object makes with a dwell timer
and a restore point it can see, and `heal` prints that decision and its reason without offering to
override it. Point-in-time recovery reaches a 30-day window with no undo and is diagnostic-only.
Recycling the interpreter has to happen between invocations, so a request that triggered one would
hold both allocations at once.

---

## Reconciling

The Drupal pack delivers at provisioning and never again, so a fix that lands in it reaches new sites
and no existing one. A site records which pack version it has reached; `drangler reconcile` reports
what it still owes and drives the steps it owes.

```console
$ drangler reconcile my-site.example
site         https://my-site.example
version      1 of 2 (1 behind)
outstanding  1 owed, 1 deferred, 0 failed

step                     since  state     detail
-----------------------  -----  --------  -----------------------------------------------
page-max-age             1      applied   page cache max_age
bake-clock               1      deferred  never claimed, so there is no real birthday yet
container-driver-digest  2      owed      driver digest moved; 4 container rows to drop

notes
  - the alarm chain drives one step per firing on its own; --run drives one now, --all drives until the site drives nothing
  - a deferred step cannot be decided yet and waiting is correct
```

The site's alarm chain already drives a step per firing, so an owed step is a site converging rather
than a fault, and the status view exits 0. `--run` drives one step now; `--all` drives until the site
answers that it drove nothing, or a step reports `failed`.

Each step is an observation of the site's end state, asked before the step runs and again after, so
a site provisioned after a fix is marked done without doing any work. Five states appear:

| state       | what it means                                    |
| ----------- | ------------------------------------------------ |
| `applied`   | the site ran it, or already matched              |
| `satisfied` | the end state matches and nothing has to run     |
| `owed`      | the site does not match yet                      |
| `deferred`  | it cannot be decided yet, and waiting is correct |
| `failed`    | it ran and left the site still owing it          |

A `deferred` step is not a problem: two of the shipped steps compare against the moment the site was
claimed, and an unclaimed site has no such moment. A `failed` step is, and it exits 3 with the site's
own detail. So does a run that asked for a step and got none while the site is still behind, which is
`reconcile-refused`: the site says why, and the two reasons are `RECONCILE` switched off and a replica
lane, which serves a copy and reconciles nothing.

The version a run reports is the version reached, not the version that ships. A step that has spent
its three attempts stops being retried and stays visible here instead of owning the alarm chain.

---

## Coverage

Page coverage is demand-driven: a URL renders when somebody asks for it, and that visitor waits. The
sweep enumerates the addressable space from the site's `router` and entity tables, ranks it by
observed views then recency then path depth, and queues the top of the list for the fill batch the
alarm already runs. It queues and never renders.

```console
$ drangler sweep my-site.example
site            https://my-site.example
sweep           on
coverage        120 of 500 addressable (24.0%), 380 pending
last step       refused
queued          0
bound by        daily-cap
reason          the sweep's 25% share of today is spent (12408 rows over 762 pages); resumes at 00:00 UTC
cost            0 rows, 0 DO request(s)
last queued at  2026-09-04T15:33:20.000Z
spent today     12408 rows over 762 pages

notes
  - the sweep's declared share of today is spent; it resumes at 00:00 UTC
  - the sweep queues and never renders; the fill batch the alarm already runs drains what it queued
```

`bound by` and `reason` come from the site's governor, so a step that queued nothing says which of
six bounds stopped it rather than reporting an empty result:

| bound       | what stopped it                                                   |
| ----------- | ----------------------------------------------------------------- |
| `floor`     | a daily meter is past the point where the quota ladder stops cron |
| `daily-cap` | the declared share of today is spent; it resumes at 00:00 UTC     |
| `remaining` | the share of what is left this step is spent                      |
| `batch`     | one step queues at most one fill batch                            |
| `backlog`   | the fill queue still has work, so the sweep yields to it          |
| `covered`   | every addressable path is stored, queued or proven unstorable     |

`floor` exits 3, because it is the one an operator acts on: the site is spending enough of a daily
meter that the ladder has already stopped cron, the queue and image regeneration. The other five are
the governor working and exit 0.

The sweep is off unless the site sets `SWEEP` to anything other than `0`, and it spends at most
`SWEEP_ROWS_FRACTION` of each daily meter, 0.25 by default and clamped to 0.01-0.5. The `sweep` line
reads the site's own switch, so a sweep that is off and one that is on with no step yet are two
different answers rather than one empty report.

`--run` forces a step off the interval the alarm chain waits out, and the report says whether it got
one: a forced call that took no step is showing you an earlier firing, and the site names the reason.

---

## Optional Levers

`drangler config levers <file>` reads the optional levers out of a wrangler config and reports the
state of each. Every one is off by default and the site is correct without it, so an unset lever is
reported rather than warned about; `config check` is where a deployment is scored.

```console
$ drangler config levers wrangler.jsonc --check
config  wrangler.jsonc

lever                declared               state
-------------------  ---------------------  ---------------------------------------------------------
FILES_PUBLIC_URL     https://files.example  mirrored public files are linked at https://files.example
ASSET_AGGREGATES     unset                  a stored page keeps the tags Drupal emitted
SWEEP                1                      on
SWEEP_ROWS_FRACTION  unset                  0.25 of each daily meter

files origin  https://files.example
answered      yes, HTTP 404

notes
  - any status counts as an answer here; an R2 bucket origin has no object at / and a 404 there is normal
```

**`FILES_PUBLIC_URL` is an option, not a recommendation.** Unset, every file is served through the
Worker, which is correct and costs one Worker request per file. Set to an R2 custom domain fronting
the `FILES` bucket, a public file that has already mirrored is linked at that origin and costs no
Worker request. A `private://` file never gets the external URL at any setting, and a public file
that has not mirrored yet keeps its Worker URL. Nothing else in drangler depends on it.

`--check` requests the configured origin and reports what answered. Any status counts as an answer: a
bucket origin holds no object at `/`, so a 404 there proves DNS, TLS and the custom domain are
working. An origin that does not answer is reported and the command still exits 0, because the site
serves those files through the Worker either way.

`ASSET_AGGREGATES` substitutes the build's per-library CSS and JS aggregates into a stored page, and
only the value `1` turns it on. It needs `bun run assets:agg` to have written `assets/agg/`; without
that manifest no library matches and the substitution changes nothing, which the report notes when
the lever is on and the manifest is not beside the assets directory.

Anything else in `vars` is echoed as declared, without a verdict. A var whose name looks like a
credential is reported as `set` and never printed.

**This reads the config, so it reports what a deployment declares.** `ASSET_AGGREGATES` is the one of
the four on the worker's `KV_OVERRIDABLE` list, so a `settings` key in the `CONFIG_KV` namespace can
turn it on or off on a running site without a redeploy, and that override wins over the value here.
The other three reach the site only as deployed vars.

---

## Eligibility

`drangler migrate eligibility` answers whether a site can move in a given direction today, and what
would have to change first. Four verdicts, and the fourth is why the exit set has four values.

| verdict           | means                                                             | exit |
| ----------------- | ----------------------------------------------------------------- | ---- |
| `GO`              | no blocker, no warning, and every criterion reached a measurement | `0`  |
| `GO WITH CHANGES` | no blocker, at least one warning, every criterion measured        | `3`  |
| `NO`              | at least one blocker                                              | `3`  |
| no verdict        | a criterion could not be measured at all                          | `1`  |

```sh
drangler migrate eligibility --survey survey.json
drangler migrate eligibility --to vps --survey survey.json --json
```

A criterion that could not be measured is exit `1`, never a `GO` with a caveat. `--assume-worst`
scores each one as a blocker and produces a `NO` with a reason, for a script that must have an
answer. **Every finding names the field it was read from**, so a verdict can be followed back to a
byte.

The `to vps` direction reads a real `/export` envelope: whether the route is reachable with the owner
token, whether the worker itself calls the dump replayable, which tables come back as schema, and how
many `cfw_file_chunk` rows are in it. It also emits the substitution table as data, because a user
changes every entry by hand:

| what the site runs on drupflare                    | what a VPS uses                        |
| -------------------------------------------------- | -------------------------------------- |
| `Drupal\drupflare\Cache\CfwCacheBackendFactory`    | `cache.backend.database`               |
| `Drupal\drupflare\Lock\CfwLockBackend`             | `Drupal\Core\Lock\DatabaseLockBackend` |
| `Drupal\drupflare\Plugin\Mail\CfwMail`             | `php_mail`, or the `smtp` module       |
| the `cfw_do_sqlite` driver block in `settings.php` | a real `$databases` entry              |

`drangler migrate eligibility --to vps --json` carries the whole list.

---

## Migrating Under Traffic

A migration that assumes a quiet source is a migration for a site nobody uses. What makes it safe is
a read-only window with a delta pass that narrows it, not a delta pass that removes it.

```sh
drangler migrate cutover --checklist
```

That prints the steps and ticks none of them. Every item is something only the person doing the
cutover can observe, and a checklist that ticks itself is one nobody reads.

The second dump carries the tables Drupal's own state inventory calls authoritative, minus the ones
that must never cross:

```sh
drangler migrate delta
```

`sessions` is dropped and everybody logs in again; rows minted on the source are signed against a
different `hash_salt`, so on the target they neither work nor fail visibly. `semaphore`, `flood`,
`queue` and `batch` go for their own reasons, each printed with the table.

**`sequences` is copied and then re-seeded.** That is the one arithmetic step in the procedure and
the one that fails silently if it is skipped: the first new node on the target collides with a row
the delta brought over, and nothing errors until the two meet. `migrate delta` prints the statement.

Three things no mechanism catches, and the checklist says so rather than implying otherwise: writes
the source accepted between the last dump read and maintenance mode, a visitor mid-form whose
`form_build_id` was minted against the source's salt, and anything the source's cron was part way
through.

### Resuming

Every long step records where it got to, in `.drangler/migration.json`:

```sh
drangler migrate survey --host deploy@old.example --root /var/www/html --out survey.json --resume
drangler migrate export --chunked --out worker.sql
drangler migrate export --resume --out rest.sql
drangler migrate install --db site.sqlite --resume
```

`export --chunked` pulls the dump through the worker's own cursor, so a dropped connection loses a
chunk rather than the dump. A resume against a checkpoint from a different migration exits `2` and
names both fingerprints; there is no `--force`, because two migrations spliced together produce a
database that looks whole and is not.

Every retry terminates on an OBSERVATION rather than on a count. An export chunk that comes back with
the cursor it was given is `export-stalled`; an updb beat that leaves the cursor where it was is
`updb-stalled`; ssh retries only a transport failure and stops the moment the step produced output.

---

## Diagnosing

`drangler doctor` is unchanged and looks at nothing on disk. Two flags widen it:

```sh
drangler doctor --source deploy@old.example --root /var/www/html
drangler doctor --site https://my-site.example
```

`--source` runs the same read-only survey `migrate survey` issues and scores what came back: a dead
PHP, an absent drush, a Drupal that did not bootstrap, a database that reported a driver and then
refused a connection, a files directory that is not there, and a root drush bootstrapped somewhere
else. None of them is auto-repairable, because drangler is read-only against a VPS by construction.

`--site` reads every owner route that reports a state and scores thirteen of them. **A check that did
not run gets its own block**: an owner route that did not answer and a check that passed are
different facts, and collapsing them is what makes a report a guess.

---

## Errors

Every error carries a code, an exit, whether a retry could work, and what to run next.

```sh
drangler status my-site.example --json
# {"ok":false,"error":{"code":"probe","message":"...","retryable":true,"next":null}}
```

Under `--json` stdout parses on the failure path too, so a CI step does not have to branch on the
exit code before it can parse. `retryable` is about the operation rather than the network: a 503 from
a warming site is retryable, a 401 is not. `next` is a command, never advice.

No stack traces. An exception that is not one drangler raised becomes `internal` with its message and
a line saying `--verbose` prints the rest.

---

## Commands

| Command                   | What it does                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `init`                    | Connect this machine to a site and write down where it went        |
| `build`                   | Clone `drupflare/worker` and build it into a deployable tree       |
| `validate`                | Everything that has to hold before `dev` or `deploy` will work     |
| `dev`                     | Build if needed, check, then run a local Drupal                    |
| `deploy`                  | Build if needed, check, then deploy to your Cloudflare account     |
| `update [worker]`         | Move a checkout to another version, and the worker running it      |
| `status <target>`         | What is deployed: plan, generation, claim state, diagnostics       |
| `doctor`                  | Preflight the toolchain, the credential and the config resolution  |
| `health <target>`         | Probe a deployed worker or a VPS Drupal and report what answered   |
| `heal <target>`           | Report the repair ladder, and perform the repairs a route allows   |
| `reconcile <target>`      | What a site still owes the shipping pack, and drive the steps      |
| `sweep <target>`          | Coverage of the addressable space, and what the governor decided   |
| `site claim <target>`     | Mint the administrator password and the owner token                |
| `site updb <target>`      | Read the Drupal update chain, and drive one beat of it             |
| `site invalidate`         | Purge a site cache, by tag or by bumping the generation            |
| `site upgrade <target>`   | Deploy, wait for the replay, then run the update chain             |
| `modify …`                | Develop a module against a site, one revision at a time            |
| `config check <file>`     | Score a wrangler config against known-bad deployments              |
| `config levers <file>`    | The optional levers a config declares, and the state of each       |
| `config where`            | Which file supplied each setting, and which files were searched    |
| `cf whoami`               | Which Cloudflare credential drangler would use                     |
| `cf workers`              | List the account workers, and compare against a saved baseline     |
| `cf cpu <capture>`        | Summarise a `wrangler tail` capture, refusing an untrustworthy one |
| `secrets scan <paths...>` | Find credentials in a dump or a tree, without printing them        |
| `migrate eligibility`     | Can this site move in this direction today, and what would change  |
| `migrate delta`           | The second dump table set, and the re-seed that fails silently     |
| `migrate cutover`         | The steps a human confirms, ticked by nobody                       |
| `migrate files`           | Write the managed files in a dump back onto a filesystem           |
| `migrate survey`          | Read a VPS Drupal over SSH: versions, database, modules, files     |
| `migrate plan`            | Score a survey and order the work, in either direction             |
| `migrate export`          | Pull a deployed site's database out through `/export`              |
| `migrate convert`         | Convert a SQL dump between MySQL and SQLite                        |
| `migrate install`         | Land a migrated database or asset in a workspace, with a backup    |
| `migrate restore`         | Put a backup set back where it came from                           |

Every command takes `--json` and prints the same object its text render is built from.

**What writes, and where.** `build`, `migrate install` and `update` write to a local workspace;
`dev` and `deploy` hand the terminal to your own `wrangler`. `site`, `heal --release`, `modify`,
`reconcile --run` and `sweep --run` write to a live site, each needs the owner token, and each one
that changes what visitors get needs `--yes` as well. Nothing in drangler deletes a file or a
directory.

`reconcile --run` and `sweep --run` are the two exceptions to the `--yes` rule, and both do exactly
what the site's own alarm chain does unattended: drive one reconciliation step, take one sweep step.
A consent flag on either would gate an operator out of accelerating work the site is already doing on
its own schedule.

---

## Workspaces

A workspace is a checkout of [`drupflare/worker`](https://github.com/drupflare/worker) with its
generated tree in place: the Drupal packs and the PHP interpreter, neither of which is in the
repository. `drangler build` produces one in four steps, of which `refresh` is opt-in.

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

## Validation

`drangler validate` runs five checks against a workspace. Each one reports a fix, and a check that
could not be made is reported as such rather than as a pass.

| Check       | What it proves                                                            | Runs for    |
| ----------- | ------------------------------------------------------------------------- | ----------- |
| `workspace` | `package.json` names `@drupflare/worker`                                  | dev, deploy |
| `artifacts` | every generated path is on disk, interpreter included                     | dev, deploy |
| `config`    | the wrangler config carries none of the blockers this project has shipped | dev, deploy |
| `scrub`     | the per-file pack carries no seeded secret                                | deploy      |
| `bundle`    | `wrangler deploy --dry-run` fits the Worker size limit                    | deploy      |

**`dev` gates on three of them and `deploy` on all five**, because `wrangler dev` bundles locally and
never uploads: the size ceiling does not apply to it and it publishes no pack. `--only` runs a
subset; `--skip-validate` on `dev` or `deploy` bypasses the gate entirely.

The size figure is the one `wrangler deploy` prints, not a local gzip. The interpreter list is read
out of the config's own `php-binary` alias and the seam it points at, so a checkout whose alias
resolves to the fallback binary is reported rather than deployed. The pack check runs the checkout's
own `assets:scrub:check`; drangler does not open the pack.

Exit `3` means a check ran and found something, and `1` means a check could not run. A CI step can
read the status instead of grepping the output.

---

## Migrating to Workers

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
| `incompatible-modules`  | blocker  | Memcache, MongoDB and ImageMagick: a daemon or a process spawn        |
| `service-modules`       | warning  | Redis, Solr, Backup & Migrate: runnable, nothing provisions them      |
| `php-version`           | warning  | the source runs older than the interpreter the destination runs       |
| `ext-archive`           | warning  | the source loads `zip` or `Phar`; the wasm build has neither          |
| `image-transforms`      | warning  | styles times files against a 5,000/month Cloudflare Images cap        |
| `files-payload`         | warning  | public files exceed the 25 MiB per-asset ceiling the pack is built to |
| `database-size`         | warning  | large enough to meet the 100,000-character statement ceiling          |
| `regeneration-ceiling`  | varies   | nodes against the free plan's rows-written budget                     |
| `drush-absent`          | warning  | without drush most of the survey is blank and the plan scores nothing |
| `shellout-undetectable` | note     | a module calling `exec()` cannot be found from a survey               |
| `cron`                  | note     | system cron becomes a `*/5` Cron Trigger                              |

Fields the survey did not measure are listed under **NOT MEASURED** rather than scored as passes.

**The destination's PHP version is stated on every plan, with where it came from.** Only `/php`
reports it and that route is diagnostic-gated, so on a correctly configured deployment it cannot be
read and the plan says `assumed`. `--target-php <version>` states it; `--site <origin>` reads it from
a deployment that does expose it. A figure that was not measured is never printed as though it was.

---

## Migrating Back to a VPS

```sh
drangler migrate plan --to vps
drangler migrate export --url drupflare.example --out worker.sql
drangler migrate convert --from sqlite --to mysql --in worker.sql --out vps.sql
```

`migrate export` reads `/export?body=1`, which is `dumpDatabase()` in `drupflare/worker`. Four things
about that path are worth knowing before relying on it:

- **`/export` needs the site owner token.** It sits on the owner tier: pass `--token`, or set
  `DRUPFLARE_OWNER_TOKEN`. The token is minted per site and returned once by `drangler site claim`.
  Without one the route answers 401 with a `WWW-Authenticate: Bearer` challenge, and drangler reports
  that as a missing credential rather than a missing route. `/restore` and `/sql` remain
  diagnostic-only, which is why there is no import counterpart to this command.
- **Some tables come back as schema with no rows.** Which ones is reported in the envelope's
  `structureOnly` field and printed verbatim; drangler does not restate the rule. `--all` includes
  their rows, and the worker answers 409 when that produces a dump it knows cannot be replayed.
- **Managed files are not in the export.** User uploads live outside the database and outside the
  Drupal pack; copy them separately.
- **The hash salt does not travel.** The shipped tree assigns an empty `$settings['hash_salt']` and
  the object mints one per site. A restored VPS needs its own, and links minted by the worker stop
  validating.

---

## Installing a Migrated Site

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

## Dialect Conversion

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

## Cloudflare Access

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

## Exit Codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | ok                                                            |
| `1`  | the check could not run                                       |
| `2`  | bad input                                                     |
| `3`  | the check ran and found something: blockers, secrets, a drift |

---

## Out of Scope

- **It does not delete.** No command removes a file, a directory, a worker or a remote object.
  `build --force` re-runs the build steps and never re-clones; a workspace holding something other
  than a worker checkout is refused rather than cleared.
- **It does not hold a Cloudflare deploy credential.** `deploy` runs your `wrangler`, which uses the
  login you already have. drangler never reads it.
- **It does not force a rollback.** A site refuses one far more often than it agrees, and every
  refusal names its mechanism. `heal` prints the decision and stops there.
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

## Testing

Two lanes. The gate is hermetic; the integration lane needs Docker.

```sh
bun run typecheck
bun run test # no network, no daemon
bun run test:coverage

bun run test:e2e       # against a real Drupal
bun run test:e2e:clone # the clone lane alone; no Docker, about ten seconds
bun run e2e:down       # remove the containers and their volumes
```

The gate covers argument parsing, config resolution, workspace resolution, step ordering, every
check's verdict and every command's report, with every external effect behind an injected seam: the
terminal, the filesystem, subprocesses, `fetch`, and the environment. No gate test opens a socket,
reaches a VPS, contacts Cloudflare, or clones a repository.

The integration lane boots MariaDB and a real Drupal 11 in Docker, runs the survey over a real SSH
connection, and drives a real Durable Object under `wrangler dev`. Both migration directions are
asserted byte for byte, and the comparator reads hex through a different path from the one that moved
the data. Alongside it, the clone lane builds a workspace out of the published `drupflare/worker`
with the real runner and the real filesystem, and the modify lane uploads a module into a site
running under `wrangler dev` and reads it back. `tests/e2e/README.md` covers the topology, the seed
corpus and its gaps, and the planted defects that prove the lane can fail.

Each lane skips when what it needs is absent and fails when the lane declares it: `REQUIRE_DOCKER=1`
for the Drupal half, `REQUIRE_CLONE=1` for the clone and modify halves, `REQUIRE_SIBLINGS=1` for the
checks that read `drupflare/worker`'s source beside this one.

---

## Related Repositories

| Repository                                                          | What it is                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)           | Drupal 11 on Cloudflare Workers; the thing this migrates to |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge)     | running a blocking interpreter inside a Durable Object      |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb)     | the measured limits of Durable Object SQLite                |
| [`drupflare/untarl`](https://github.com/drupflare/untarl)           | tar and tar.gz extraction with no Node APIs                 |
| [`drupflare/stream-http`](https://github.com/drupflare/stream-http) | an `https://` stream wrapper for PHP builds with no sockets |

---

## License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
