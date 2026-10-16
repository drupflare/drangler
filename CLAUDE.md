# drupflare/drangler

The CLI for starting, maintaining and migrating a drupflare site. Built with `commander`, run under
bun, and headed for a single raw binary via `bun build --compile`.

## Mission

**Migration is the product, and it is BIDIRECTIONAL.** A user moving a Drupal site from a VPS onto
Cloudflare Workers, and a user moving one back off. Off-boarding matters as much as on-boarding: it
is the property that makes the on-boarding safe to accept.

Everything else here exists to serve that: `status` and `doctor` before you start, `health` while
you are part-way through with two hosts to compare, `secrets scan` on the artifacts a migration
produces, `cf` for the account the destination lives in.

## Every command must work on a USER's machine

The user is somebody who deployed a drupflare site. They have a Worker on Cloudflare and possibly a
VPS. **They do not have a checkout of anything**, and nothing in the default surface may assume they
do.

`status` used to scan nine sibling git checkouts of the drupflare source and `doctor` folded that
scan in. Both were maintainer tooling wearing a user command's name, `status` was FIRST in the help
output, and the health check someone runs when they are already confused failed on their laptop. The
mechanism was fine and its target was wrong: "report what is here and what version it is" is exactly
the right question pointed at the wrong machine.

So `status` now reads a DEPLOYED site over one public request -- plan, generation, header contract
version, whether the diagnostic routes are open -- and `doctor` looks at nothing on disk at all. A
local `wrangler.jsonc` is read only if it happens to be in the working directory, and its absence is
never a failure.

Before adding a command, ask what it does on a machine that has only ever run `bun add -g`.

**`build`, `validate`, `dev` and `deploy` pass that test by building the checkout themselves.** They
are the only commands that need one, and none of them assumes the user has one: `build` clones it,
and the other three build first when the workspace is not there. A workspace is resolved as the
flag, then `DRANGLER_WORKSPACE`, then the working directory when it IS a `@drupflare/worker`
checkout, then `.drupflare/worker` under the working directory. The environment sits above the
working directory on purpose -- an explicit setting outranks an inference from where the shell is.

## Never COPY code out of `../worker`; MOVE it or invoke it

`drupflare/worker` is the deployable product and this CLI reads its behaviour, never its source.
Most of `worker/scripts/*` is build pipeline the worker itself imports -- `scrub-pack-secrets.ts`
alone has four referencing files, including the release credential gate -- and a second copy of the
pack format here is exactly the drift that workspace has already spent a session deleting.

The rule bans a second COPY. It does not ban a single implementation living here, and there are now
three dispositions rather than one. Each piece of `worker/scripts/*` gets exactly one:

| disposition | when                                                              | example                                 |
| ----------- | ----------------------------------------------------------------- | --------------------------------------- |
| **move**    | it is validation, it is pure, and a user needs it before a deploy | the size ceiling, the interpreter files |
| **invoke**  | it needs a format or a tree only the worker owns                  | `bun run assets:scrub:check`            |
| **leave**   | it is a maintainer step, or it needs bytes a user does not have   | `backup:verify`, `release:payload`      |

**What moved**, and it is the whole of what moved:

- `FREE_CEILING` / `PAID_CEILING`, `parseWranglerGzipBytes()` and `ceilingVerdict()` into
  `src/workspace/bundle.ts`, out of `release-payload.ts` and `measure/bundle-size.ts`.
- `interpreterFiles()` into `src/workspace/artifacts.ts`, out of `release-payload.ts`. It is the
  check that catches the alias resolving to the fallback seam at 710,410 bytes over the ceiling.
- `PAYLOAD_ASSETS` + `PAYLOAD_RECORDS` + `PRODUCED_BY`, folded into one `REQUIRED_ARTIFACTS` table.
  "What is missing and what do I run" is a deployer's question, not a release engineer's.

The worker is **proposed** to import those back rather than keep a copy. Until it does, two files
exist, so `tests/workspace-artifacts.spec.ts` reads the sibling's source and fails when the two
disagree -- the same skip-without / fail-under-`REQUIRE_SIBLINGS=1` shape as
`tests/target-runtime.spec.ts`.

**The clone is the compromise, and it was chosen over three alternatives.** `drangler build` clones
the worker and runs that checkout's own `bun install` and `bun run hydrate`; `validate` runs its
`assets:scrub:check`; `dev` and `deploy` wrap its wrangler. The trade-off, stated rather than
implied:

- **What it costs.** A network and a `git` on first run, a second copy of the tree on disk, and a
  version skew surface -- a drangler that is newer than the checkout it drives. `--source` takes a
  local path so the skew is inspectable, and every step names the command it ran.
- **What it buys.** One implementation of the pack format, the payload manifest, the asset plan and
  the sqlite chunker, in the repository that owns the artifacts they describe.
- **Rejected: vendoring the pipeline.** It is the drift this section exists to prevent, at
  4 scripts and ~1,400 lines.
- **Rejected: a published npm package of the pipeline.** The worker publishes no package on purpose
  (`PUBLISHING.md`: "This repository publishes a deployable application, not a package") and the
  pipeline's inputs are 3.9 GB of untracked tree.
- **Rejected: reading the release payload directly.** drangler would then own the manifest format
  and the tarball layout, which is the same drift with an extra network hop.

Two specifics, both still settled:

- **`src/secrets/patterns.ts` stays drangler's own list.** It is a superset: it scans VPS
  filesystems and config, which the worker never does. Three entries overlap
  `worker/scripts/release-payload.ts`'s `CREDENTIAL_PATTERNS` and are duplicated **on purpose** --
  see the docblock there for what drift would cost. Not a TODO, and not a package.
- **The per-file pack format** (`{p, o, c, l, m, s}` into one blob) is NOT reimplemented here and
  must not be. It has one implementation, in the worker; `validate` runs `assets:scrub:check` in the
  checkout rather than opening `core.pf.bin`, which is what "invoke" means in the table above.

**`backup:verify` was considered for `validate` and rejected.** It checks that 35 hand-built php-wasm
binaries and `site.sqlite` are intact in the `drupflare-cdn` R2 bucket. A user has no `vendor/`, no
bucket, and no way to act on a failure; it is the definition of a maintainer step wearing a user
command's name, which is the mistake `status` already made once.

## Every external effect goes through a seam

Five, all on `Context` in `src/context.ts`: `io`, `files`, `runner`, `fetch`, `env`/`cwd`/`now`.
Commands take a context and nothing else.

- **No test contacts a network, a VPS or Cloudflare.** `tests/helpers.ts` substitutes all five.
- SSH is `Transport` in `src/migrate/transport.ts`, with three implementations: real `ssh` through
  the runner, a recorded transcript, and one that refuses everything for `--dry-run`.
- Subprocesses are `CommandRunner` in `src/host/exec.ts`. `git`, `ssh`, `bun` and `wrangler` all use
  it.
- `execFile`, never a shell, so no argument is word-split. `parseTarget()` and `normaliseRoot()`
  validate anything that becomes argv or remote command text.

**`run` captures, `spawn` inherits, and which one a call takes is decided by what the OUTPUT is
for.** `run` when the caller parses it: `git status --porcelain`, wrangler's `gzip:` line, the
scrubber's exit code. `spawn` when the user needs to watch it: a clone, a `bun install`, a hydrate
downloading 15 MB, and `wrangler dev`, which never exits on its own and would deadlock filling a
64 MB buffer behind a 60-second timeout. Both land in one ordered `calls` ledger on
`scriptedRunner`, tagged `mode`, so a spec asserts step order across the two.

**`FileHost` holds BYTES.** `readBytes`/`writeBytes` exist because a site database and a per-file
pack are not text, and `memoryFiles` stores `Uint8Array` rather than encoding on read -- so
`size()` and `readBytes().length` agree for the same reason they agree on a real disk. A fixture
that stored the string and encoded per call would read a binary member back as something else.

## The e2e lane is where the converter is actually tested

`tests/e2e/` holds two requirements, not one: `workspace-clone.spec.ts` needs the network and a
readable `drupflare/worker`, everything else needs Docker. They are separate CI jobs behind
`REQUIRE_CLONE` and `REQUIRE_DOCKER` so a red one names which requirement failed. Read
`tests/e2e/README.md` before changing anything in it. Three rules that are load-bearing:

- **The comparator must not share a mechanism with the mover.** Both sides read hex -- `HEX()` in
  MySQL, `hex()` in SQLite, `/rows` rather than `/export` in the object -- and both are compared
  against a third reading, the literal hex in `helpers/seed.ts`. This is `pack-sql.ts`'s recorded
  failure: source and replay read through the same truncating API and agreed at 117 of 1,697 bytes.
- **Plant defects in the DATA, never by patching the converter.** `detector.spec.ts` proves the
  checker notices; breaking the mover would only prove the mover can be broken.
- **Seven converter bugs shipped past a green unit suite** and were found the first time converted
  SQL met a real database: a table-level `COMMENT` with parens breaking paren matching, `INTEGER`
  narrowing to 32-bit MySQL `INT`, `NUMERIC` losing its scale, TEXT/BLOB keys without a prefix
  length, a two-word type regex eating `PRIMARY`, `CAST(x'..' AS TEXT)` having no MySQL equivalent,
  a missing `SET NAMES utf8mb4`, and `0x` as an empty hex literal. A string assertion cannot catch
  any of them. **If you change `src/migrate/convert.ts`, run the e2e lane.**

## A version is a value with a provenance, never a constant

`LIMITS.interpreter` was the string `'8.3'` while the worker shipped 8.5. It had been correct when
written; the world moved and nothing noticed, because a wrong version is plausible. The same class
of bug as a hardcoded metadata URL.

Two things made it worse than a stale string, and both are the lesson:

- **The same fact was asserted twice.** The display constant said 8.3 and the rule's comparison
  independently hardcoded `minor >= 3`. The comparison is what decided the verdict, so a source on
  8.4 was passed silently. **If a fact appears in a message and in a condition, they must read the
  same value.**
- **It was presented as measured.** `src/migrate/target-runtime.ts` now carries a `TargetRuntime`
  with `source: 'probed' | 'stated' | 'assumed'`, and every message says which. `assumed` is the
  NORMAL case: only `/php` reports the interpreter version and it is diagnostic-gated, so a correctly
  configured site cannot be read. `x-cfw-v` does not help -- that is the header CONTRACT version.

`tests/target-runtime.spec.ts` reads the `./runtime/php-binary.js` alias out of
`../worker/wrangler.jsonc` and fails when the fallback drifts from it. **It skips when the sibling is
absent and fails under `REQUIRE_SIBLINGS=1`**, so on drangler-only CI it is worth nothing and earns
its place on the machine where a version bump is actually made. A test comparing the constant to a
literal would pass forever; that is what let the drupal.org path rot twice.

## `modify` is a per-site revision table, and the SITE is what verifies a commit

`drangler modify` uploads a module tree that exists only on a developer's disk. A revision is an
immutable, content-addressed manifest of one package's files stored in ONE site's Durable Object --
per-site state, never Worker code -- so `plan` / `blobs` / `commit` sends a one-file edit as one file
and `activate` sends nothing at all.

**The Workers Versions API cannot serve this and the refusal is a platform one.** Cloudflare's own
docs: preview URLs are not generated for Workers that implement a Durable Object, and a version that
changes a Durable Object class lifecycle cannot be uploaded at all. It is also the wrong artifact: a
Worker version is code shared by every site in the namespace, so previewing one customer's module
change would put it in front of every site.

**A commit is verified by a REAL KERNEL BOOT, on the worker, and that is not a syntax check.** A
module with a missing service fails when the container is built rather than when the file is written,
so a route that wrote the files and answered ok would report success on a site that can no longer
render. The site restores the previous file set and answers 409; `modify upload` exits **1** for that
rather than 3, because nothing the caller asked for happened.

Four things the routes decide that drangler must not re-derive:

- **The blob hash is sha256 of the UTF-8 bytes and the site re-computes it** before storing. Bytes
  that do not hash to the name they were sent under are a 422, which is a security property rather
  than a consistency check: a manifest names files by hash, so storing chosen bytes under a chosen
  hash would let a later `activate` mount content that was never reviewed.
- **The revision id is sha256 over the manifest sorted by path**, `<path>\0<hash>` per line joined
  by `\n`. `manifestRev()` computes the same thing locally, which is what lets `modify status` say
  `clean` without asking the site to hash anything. **The separator is a NUL**, which is what makes
  it unambiguous where a path cannot help; this section said a space for two sessions, and so did
  `manifestRev()` and the fake site in `tests/modify.spec.ts`, so all three agreed with each other
  and none of them agreed with `hashManifest()` in the worker. `modify status` could not answer
  `clean` on any real site. `tests/modify-rev.spec.ts` now reads the separator out of the sibling's
  template literal rather than restating it.
- **`commit` applies immediately.** The route has no store-without-activating mode, so there is no
  `--no-activate`; going back is `activate` against an earlier revision.
- **Five revisions per package are retained**, and dropping one frees only the blobs no surviving
  manifest names.

**THE MOUNT FILTER IS COPIED AND THAT IS DELIBERATE.** `KEEP`, `DROP` and `RECORD_CAP` in
`src/modify/detect.ts` are the worker's, from `src/ops/package-install.ts`. The selection happens on
a local disk the site cannot see and `/modify` takes MOUNTED paths, so there is nothing to invoke;
`tests/modify-detect.spec.ts` reads the sibling's source and fails when the two disagree, which is
the `REQUIRE_SIBLINGS` shape `tests/workspace-artifacts.spec.ts` already uses. `QUARANTINE_STRIKES`
and `RUNGS` in `src/health/repair.ts` carry the same guard in `tests/heal.spec.ts`.

**Three things the plan asked for, and which of them the ROUTES can answer.** This block said that no
route returns a stored manifest. That was wrong: `/modify?action=manifest` has been there since
v1.0.3 (`src/do/modify.ts`, `manifestOf()`), and it was never read. Corrected 2026-10-16:

- **A path-level added/modified/removed diff** is possible and is not built. `plan` still counts
  against only the files whose blobs the site already holds, so a modified file is counted as REMOVED
  there, and `modify diff` reports the have/want split, which is exact, plus the paths that would be
  sent. A path-level diff reads `action=manifest` and compares it with `manifestRev()`'s inputs.
- **`modify diff --against <rev>`** is the same read, with the revision named. Not built.
- **A collision with a package on the SITE, checked before the upload.** Only `commit` knows, and it
  refuses with a 409 naming both packages. `modify check` checks the collision this machine can see:
  two packages in one project wanting one mount.

**`--deps` asks the registry about EVERY dependency, including the ones that look like core.** The
project half of a `project:module` dependency is not a core marker: mantle2 declares `json_field`,
`key`, `smtp` and `redis` -- all contrib -- under the `drupal:` prefix, so reading that as "core"
would call four contrib modules core and ask about none of them. A core module has no project of its
own on drupal.org, so `not-found` is what core looks like from here.

## `dev --modify` runs ALONGSIDE wrangler, and `modify dev` is an alias

One command, because `dev` already clones the worker, hydrates the packs and hands the terminal to
`wrangler dev`, and mounting a module needs all of that first. Two commands would mean two
workspaces, two hydrates and two wrangler processes on one port.

The mount cannot run before the spawn -- the object does not exist until the server is up -- so it is
started as a background task and stopped when wrangler exits. Two consequences:

- **A `--modify` directory is resolved BEFORE the spawn**, so a directory that is no module project
  is refused while there is still a terminal to read the refusal on.
- **Watching POLLS the manifest** rather than subscribing to the filesystem. A watcher would be a
  sixth seam on `Context`, and the poll answers the same question. `--interval 0` is what makes a
  spec run it at the speed of the microtask queue; `pause()` in `src/owner.ts` is the only wait.

**Nothing here sends `?site=`, and the dev site used to.** `resolveSite()` on the worker honours the
parameter only on a route that is not public, and `/firstrun` is public -- so a claim naming a site
mints the token on the object the HOST resolves to while every owner call after it addresses the one
it was told, and a valid token answers 401. `DEV_SITE = 'dev'` and a config default of `'site'` both
did that; the default worked against `wrangler dev` on localhost, whose host derives to the same
`FALLBACK_SITE`, and broke every deployment. `--site-name` is now an explicit override with no
default, and `ownerUrl()` omits the parameter when there is none.

The dev site's owner token is minted by `POST /firstrun` and held in memory for the process. It is
never written to disk: a local dev credential in a config file outlives the server it belonged to.

## Every error carries a code, an exit, a retry verdict and a next command

`src/errors.ts` holds ONE table and `DranglerError` reads its exit, its `retryable` and its `next`
out of it, so two `throw` sites cannot disagree about what `export-unauthorized` means. A call site
may override any of the three where the answer is specific to the call; `build-step`'s next step
depends on which step failed.

- **`retryable` is about the OPERATION, not the network.** A 503 from a warming site is retryable
  because the same request succeeds once the replay finishes; a 401 is not, even though it may also
  stop happening. Nothing here loops on it -- the flag exists so a wrapper does not pattern-match a
  message.
- **`next` is a COMMAND.** `drangler site claim https://...` is a next step; "check your
  credentials" is not, and is left out.
- **No stack traces.** Anything that is not a `DranglerError` is a bug here, so `run.ts` maps it to
  `internal` with the message and "re-run with --verbose for the stack". The stack was the DEFAULT
  path for every exception before this.
- **Under `--json`, stdout parses on the FAILURE path too.** The error object is the report there, so
  "stdout carries the report and nothing else" holds unchanged and a CI step does not branch on the
  exit code before it can parse. `build.ts` printed two prose lines to stdout before throwing, which
  broke `jq` on the one failure a new user is most likely to hit; that guidance is the error's `next`
  now.

## The repair vocabulary is the WORKER's, and a fourth one would be an invention

`worker/docs/configuration.md` classifies the repair surface as **safe** (changes nothing a visitor
sees), **rebuild** (discards derived state that comes back on its own) and **stateful** (changes what
the site serves). `src/health/repair.ts` and `src/health/site.ts` use those three words rather than a
parallel set of their own.

The class is the blast radius. What a repair needs on top of `--yes` is two flags of its own, because
two stateful repairs differ: clearing a quarantine re-quarantines after three more strikes, and a
`hook_update_N` has no rollback any route reaches.

- **`auto`** -- whether `--auto` may perform it unattended. True for `release` and `replay` only.
- **`needsSnapshot`** -- whether it needs an explicit `--snapshot <dir>` or `--no-snapshot`. True for
  `updb` alone, because `updbRollback()` exists on the worker with no route reaching it, so the
  snapshot is the only rollback a CLI has. There is no default; a default is a decision made
  silently.
- **The rebuild class is refused while the site is degraded**, with the driver named: spending the
  meter a site is already shedding on is how a repair becomes the outage.

`--bump` prints its blast radius on stderr BEFORE the request, because it re-renders the whole site
and reading that afterwards is reading it too late.

**`/git?action=unpin` rather than `unpreview`, and the difference is the network.** `unpreview`
re-syncs to the branch head, so it calls `gitRefs` and needs the remote to answer -- and a pin held
against a remote that is down or whose token expired is exactly the state being healed, while a
pinned site takes no pushes and no polls. `unpin` clears `git_previewof_<id>` and reaches nothing.
The site keeps serving the request's files; what changes is that the poller owns the branch again, so
the next successful poll converges it. Degraded rather than immediate, and it works at zero
connectivity.

**`/replica` IS NOT A REPAIR ROUTE and drangler must not reach it.** It is diagnostic-only for two
reasons: a lane that withdrew asks the primary for a fresh copy itself and the primary queues it and
arms an alarm, so there is nothing for an operator to drive; and the same route carries the path a
lane uses to commit a batch it executed speculatively, which belongs to the pool rather than to
whoever holds the owner token. `heal` had a `--readmit` and `doctor --site` had a
`site.replica-fenced`, and both are gone. Read lane state through `/health` and `/serve-stats`.

## `reconcile --all` terminates on `ran`, and the stall heuristic that preceded it is DELETED

`POST /reconcile` answers `{ran, last, skipped?, version, packVersion, steps}`. `ran` is THIS call's
outcome and null when the site drove nothing; the previous firing's payload is `last`. So the loop
stops when `ran` is null, and the version-plus-applied-count comparison that used to stand in for it
is gone rather than kept beside it.

**It existed for a defect that is fixed**, and it is worth knowing why it can go rather than assuming.
`ran` used to be `step ?? this.lastReconcile ?? null`, so a no-op answered with a payload from an
earlier firing and a loop reading it ran to its bound on every current site. With that gone, the only
way a post can leave the version unmoved is a step that ran and did not converge, which `recordStep`
writes as `failed` on the same reading `stuck` breaks on. `reconcile-stalled` was therefore
unreachable: every path into it passed through `stuck` first, which throws `reconcile-failed`.

What replaced it is narrower and is a different claim. **`reconcile-refused` fires when the site
drove nothing AND is still behind**, which is `RECONCILE=0` or a replica lane: an operator asked for a
fix and it did not arrive.

Three states an operator reads differently, and collapsing any two is the mistake:

- **`owed` is not a fault.** The alarm chain drives one step per firing on its own, so a status read
  that exited 3 on an owed step would report a fault on a site that is converging. Status exits 0.
- **`deferred` is correct.** Two shipped steps compare against the moment the site was claimed and an
  unclaimed site has no such moment, so they defer forever on a site nobody claims. The worker keeps a
  deferred step from blocking the ones after it; the report keeps it out of the owed count.
- **`failed` is the one to act on**, and exits 3 as `reconcile-failed`.

**`skipped` names one of four conditions and drangler classifies them, it does not re-derive them.**
`RECONCILE=0` and a replica lane mean a fix an operator asked for did not arrive, so `refusal()`
exits 3. `already at the shipping version` and a chain parked on a deferred step mean nothing was
owed, so both exit 0.

**`parked()` reads the STEPS, never the reason text.** Nothing owed, plus either a deferred step or a
`waiting` payload. The reason is written for a person and can be reworded; the states are the
report's own structure, and pattern-matching a message is the thing the error-code table exists to
avoid. A spec drives a deliberately reworded `skipped` to hold that line.

**Neither `reconcile --run` nor `sweep --run` takes `--yes`**, unlike every other live writer here.
Both drive exactly what the site's alarm chain drives unattended, so a consent gate would stop an
operator getting a fix sooner without stopping the write.

## A refusal and a no-op must not render the same

`GET /sweep` answers `{sweep, at, ran, enabled}` plus `skipped` when `run=1` drove nothing. Four
answers hide behind a `sweep` of null or an unchanged report, and each gets its own line:

| reading                        | what it means                                            |
| ------------------------------ | -------------------------------------------------------- |
| `enabled: false`               | `SWEEP` is off; the null report is not a symptom         |
| `enabled: true`, `sweep: null` | on, and no step has come due yet                         |
| `ran: true`                    | the report below IS the step this call forced            |
| `ran: false` after `run=1`     | the report is from an earlier firing; `skipped` says why |

**`enabled` is a READING, not an inference**, and it is what closed the old hedged sentence covering
an unset var and an interval that had not elapsed. Before it, both answered `{sweep: null}` and the
note had to name both.

**`floor` is the only bound that exits 3**: a daily meter is past the point where the quota ladder has
already stopped cron, the queue and image regeneration, which is a site to look at. `daily-cap`,
`remaining`, `batch`, `backlog` and `covered` are the governor working.

**`?run=1` now genuinely forces a step**, because `sweepBeat({force: true})` skips `sweepDue()` on the
operator path while the alarm chain still honours the interval. It does NOT override `sweepEnabled()`,
which is why `skipped` is `'SWEEP is off'` and nothing else today. **`at` is still the last step that
QUEUED something**, not the last step, because the object only moves `lastSweepAt` when `queued > 0`.

## `FILES_PUBLIC_URL` is an option and nothing may depend on it

Unset is the correct configuration: every file is served through the Worker at one Worker request
each. Set to an R2 custom domain, a public file that has already mirrored is linked there and costs
no Worker request. So `config levers` reads it and `--check` says whether the origin answers, and
that is the whole surface. No other command reads it, `config check` does not warn when it is absent,
and an origin that does not answer is reported rather than raised: the site serves those files
through the Worker either way.

**Any HTTP status counts as an answer.** A bucket origin holds no object at `/`, so a 404 there
proves DNS, TLS and the custom domain are working; asserting a 200 would fail every correctly
configured bucket.

**`LEVERS` in `src/cloudflare/config.ts` is short on purpose and must stay short.** A lever earns a
row when something in drangler acts on it: `FILES_PUBLIC_URL` has the reachability check, `SWEEP` and
`SWEEP_ROWS_FRACTION` drive `drangler sweep`, and `ASSET_AGGREGATES` needs a build artifact whose
absence makes the lever inert. Listing every var the worker reads would be a copy of
`worker/docs/configuration.md` that goes stale on the next one it adds; every other `vars` entry is
echoed as declared, without a verdict.

**`config levers` reads a CONFIG, so it reports the DECLARED value.** `ASSET_AGGREGATES` is on the
worker's `KV_OVERRIDABLE` list, so a `settings` key in `CONFIG_KV` flips it on a running site with no
redeploy and that override wins over anything here. `FILES_PUBLIC_URL`, `SWEEP` and
`SWEEP_ROWS_FRACTION` are not on that list and reach the site only as deployed vars. Do not describe
the reading as the site's live state.

`ASSET_AGGREGATES` is on that list because it shipped as a no-op: `assets/.assetsignore` never
allowed `/agg/`, so the substitution rewrote every asset tag to a URL the asset layer did not publish
and the page rendered with no CSS. The worker fixed the ignore file. What decides the state here is
the value AND the artifact, so `1` with no `agg/manifest.json` beside the assets directory reads as
on-and-inert rather than on.

## What the CLI copies from the worker, and what checks each copy

Four constants, one classification and one formula are repeated here because the work happens on a
local disk the site cannot see. Each one has a spec that reads the sibling's source and fails when
the two disagree, skipping without the sibling and failing under `REQUIRE_SIBLINGS=1`:

| copied here                            | from                        | checked by                    |
| -------------------------------------- | --------------------------- | ----------------------------- |
| `KEEP` / `DROP` / `RECORD_CAP`         | `ops/package-install.ts`    | `tests/modify-detect.spec.ts` |
| `RUNGS` / `QUARANTINE_STRIKES`         | `ops/repair.ts`             | `tests/heal.spec.ts`          |
| the three repair class words           | `docs/configuration.md`     | `tests/heal.spec.ts`          |
| `AUTHORITATIVE_TABLES`                 | `ops/state-inventory.ts`    | `tests/delta.spec.ts`         |
| the service classes in `SUBSTITUTIONS` | `drupflare/drupflare`'s src | `tests/eligibility.spec.ts`   |
| the revision id formula                | `ops/module-rev.ts`         | `tests/modify-rev.spec.ts`    |

**A `to-vps` rule that ignores its envelope is scoring a paragraph rather than a site.** All five of
them used to declare `evaluate()` with no parameters and return a constant, so the whole off-boarding
direction was fixed prose. `Rule.evaluate` takes an `ExportEnvelope` now and a rule with none returns
null, which reports as UNMEASURED rather than as a pass.

**Every `Finding` carries `evidence`** naming the survey field, the envelope key or the header it was
read from. A verdict whose evidence a reader cannot follow back to a byte is the class of claim this
workspace has been wrong about repeatedly.

## Two facts a survey error was not, and one it still is not

- **A survey error is a VERDICT.** `runSurvey()` records a failed required step and carries on, which
  is right, and nothing downstream turned that into a refusal: a source whose `php -v` exited
  non-zero and one that simply has no node count produced the same report, and both passed.
  `sourceFindings()` is that verdict and `migrate plan` treats any blocker in it as one.
- **A missing FIELD is not a broken source.** Without drush every field below it is blank for one
  reason, so `sourceFindings()` stops there rather than reporting a bootstrap failure and an
  unreadable database on top of it. Three findings for one cause is how a report stops being read.
- **A check that did not RUN is still not a check that passed.** `doctor --site` puts every owner
  route that did not answer in its own `not checked` block, the way `migrate plan` already separates
  its unknowns.

## `/export` is an OWNER route, and two files here disagreed about it

`rules.ts` carried an `export-gated` BLOCKER saying `/export` sits in `DIAGNOSTIC_ROUTES` and 404s
without `PW_DIAGNOSTICS=1`. It is in `OWNER_ROUTES`, and `src/commands/migrate.ts` already said the
opposite in its own 404 message -- so two files in this repository contradicted each other and the
wrong one was what a user read before deciding whether they could leave at all.

**The managed file bytes DO leave.** `worker/src/db/file-store.ts` keeps `public://` and `private://`
in `cfw_file` and `cfw_file_chunk`, neither of which is in `REGENERABLE_TABLES`, so both are dumped
with rows. What did not exist is anything that writes them back, which is `migrate files --from-dump`
now. The old finding told a user to copy a files tree that was already in the dump they were holding.

**The chunked dump was already on the far side.** `/export?cursor=` walks a `DumpCursor` and answers
409 on a shape mismatch because two spliced dumps produce a file that looks whole and is not.
`migrate export` issued one unbounded request and held the whole thing in memory, so a dropped
connection lost everything and the mechanism that would not have was already built.

## `preview` is one command, and every choice in it can be answered three ways

Decisions made 2026-10-15 and 2026-10-16 while taking a real production box (an organisation-custom
layout: a flat `web/modules/mantle2`, two `$databases` blocks, Redis behind `extension_loaded`)
through to a working duplicate.

**Every decision has a flag, a `DRANGLER_PREVIEW_<NAME>` variable and a prompt.** `previewEnv()` fills
what a flag left open, a flag wins, lists are comma separated and switches are `1`. What is still open
is asked on a terminal and refused without one, so CI never hangs. A new option that is a decision
gets all three or it is not added. The reason: the product is "one command", and a decision with only
a prompt breaks a pipeline, while one with only a flag breaks a person.

**Layout is read from the host, never assumed.** `discoverLayout()` reads the Apache or nginx vhosts,
takes the docroot that looks like Drupal, finds the composer root, `vendor/bin/drush` (run as the web
user only when the ssh user is root; as the ssh user otherwise, which is what the e2e Drupal needs),
the site directory by Drupal's multisite order and a source id. A value it cannot read is `null` or
`assumed` and the evidence list names the command behind each. Gaps in a customer's layout are
drangler's problem: the customers are institutions with intermediate Drupal skill.

**Credentials in the database are blanked, not carried.** earth-app keeps its cloud admin key, Stripe
keys, FCM service account, SMTP login and OAuth secrets in Drupal config through the Key module's
`config` provider, so the dump carried keys that let a copy act as production: signup bumped a funnel
counter on the live cloud API with the admin key. `credentials.ts` finds every credential-bearing
value (Key `config` keys except a public certificate, any leaf named like a secret, password, token,
private key or API key, and `smtp_username`) and `preview` empties each one through the
`DRUPAL_CONFIG` override at RUNTIME. Nothing is rewritten in the database, the names are listed and
the values never are, and `--carry-key` restores one. Chosen over carrying everything locally and
blanking on deploy, because a stray scheduled event on a laptop is as live as one on Cloudflare.

**Aggregation is forced off in the carried config, and the module override alone is not enough.**
Measured 2026-10-16 on the earth-app copy: the administration theme's CSS aggregate was 3,327 bytes
and the script aggregates 73 and 71, so every admin page rendered unstyled. The source's `$config`
set `system.performance` `css.preprocess` and `js.preprocess` true, and `$config` outranks the
`config.factory.override` the drupflare module registers. `forceAggregationOff()` in
`src/migrate/platform.ts` writes both false into `DRUPAL_CONFIG` unconditionally. After a secret
change the live site kept serving aggregates until its object restarted, so a verdict needs a fresh
incarnation (`coldEncounters.incarnation` in `/serve-stats` drops when it has).

**Mail is moved onto the worker's layer.** `mailsystem.settings.defaults.sender` of `SMTPMailSystem`
opens a socket a Worker cannot, and `mailsystem` outranks the worker's `system.mail` override, so the
message was lost before the worker saw it. `mail-system.ts` points the sender at `cfw_mail`.
`--hold-mail` (local only, refused with `--deploy`) queues instead of sending, so a verification code
is read from `cfw_mail_queue`.

**A deploy is private or it does not happen.** `createGuard()` makes an Access app on the `workers.dev`
hostname before the first upload, deploys a data-free placeholder under that name, and
`waitGuarded()` must see the edge turn a visitor away from it before the real worker goes up; it
checks again after the real deploy, before a secret is sent or a claim is made. The check cannot come
before any script exists: a workers.dev name with no script answers a bare 404 and Access is not
consulted (measured 2026-10-16, a probe under a guarded name read 404 and then a 302 to the Access
login on the first answer from the script, never a 200). The placeholder makes that structural, so
data never goes up before enforcement is seen, and nothing here deletes a worker on failure. The copy also leaves the fleet: `leaveFleet()` drops the `FLEET_DB` binding from the preview's own
workspace config, because the binding names a D1 database by name and the name resolved to the user's
existing `drupflare-fleet`, where the first deploy registered itself and from which its cron warms the
other sites in the table (2026-10-16; the row was removed by hand). The copy holds real users' emails and
password hashes, so there is no public fallback. A token that can read Access but not write it
stops the run with the permission named and nothing created (measured: HTTP 403, code 1010 on the
service token POST, which needs Access: Service Tokens Edit as well as Access: Apps and Policies
Edit; an empty-body POST with the scope creates a token, so probe with a read).

**`--edge [branch]` is how a prerelease worker is built, and it asks the CHECKOUT, not the CDN.** An
unstated build pins the newest release tag, so a duplicate could not be built from a branch whose
version has no release yet (the 2026-10-16 run on `master` at 1.0.4 stopped at the `1.0.4` gate with
the tag not cut). `--edge` clones the branch and runs `bun run hydrate --dev=<branch>`; the worker's
`hydrate` resolves `payloads/dev-<branch>/` on the CDN, so the key layout and the fallback order
stay in one place. The flag exists on `build`, `dev`, `deploy` and `preview`, with
`DRANGLER_WORKER_EDGE` and `DRANGLER_PREVIEW_EDGE` beside it, and it refuses `--from`,
`--from-source` and a ref that names another branch. A checkout older than the worker's `--dev` flag
ignores the argument and resolves the ordinary way. A branch tip is not a release: the next push
replaces the bytes, and `PREVIEW_MIN_WORKER` still gates on the version it carries.

**A first boot is retried, and the cause is wrangler, not the worker.** On a 98 MB database `wrangler
dev` ended during the first boot with an empty error ("Network connection lost" in its proxy).
Measured 2026-10-16: the first render finishes, the alarm then boots a second interpreter for about
2.6 s, and a request arriving in that window ends the dev server (+0.2 s and +2 s die, +4 s and +12 s
pass). The same bundle driven through Miniflare directly answers the racing request after 3.5 s, a
minimal Durable Object with a 3.4 s synchronous alarm does too, and bisecting 4.127.1 to 4.151.0 puts
the fix at wrangler 4.129.1 (4.129.0 dies); its changelog entry is workers-sdk #15252. Ruled out on
the way: local observability, memory (workerd peaks near 318 MB, and a local workerd enforces no
limit), disk, the replay, and the worker's alarm code. `bootDuplicate()` still starts it again up to
five times and counts the site up after two answers in a row, because a workspace pinned to an older
checkout installs the old wrangler; only wrangler's own non-zero exit is retried. `WRANGLER_DEV_FIXED`
holds the version and `PREVIEW_MIN_WORKER` is 1.0.4, the first worker whose lock resolves past it.

**A path the source answers from Cloudflare Access is not compared.** The edge answered, not Drupal,
so `verify()` reports it as not compared and counts it apart.

**`--version` belongs to the root command.** commander reads it wherever it appears, so a subcommand
flag of that name printed drangler's version and installed nothing; `modify require` takes
`--constraint`, and `tests/cli.spec.ts` fails on any subcommand that declares `--version` again.

**The worker used to drop every request header except the cookie, `Accept`, the content type and the
client address.** A bearer-token route answered as anonymous, which no anonymous comparison could
show. Fixed in the worker (`forwardedHeaders()`), not here; the lesson for this repo is that
`verify` must check an authenticated call, not only anonymous GETs, before a copy is called working.

## Read-only apart from the commands that say so, and nothing anywhere deletes

The blanket "nothing here deploys" is gone: `deploy` deploys, because a one-line path to a live
Drupal on the user's own account is the product. What replaces it is narrower and stricter.

**Two groups write and the description names both.** `build`, `migrate install` and `update` write to
a local workspace; `dev` and `deploy` hand the terminal to wrangler. Then `site`, `heal --release` and
`modify` write to a LIVE site: each needs the owner token, and each one that changes what visitors get
needs `--yes` as well. Everything else is unchanged:

- **`heal` can fix exactly one thing**, and it is clearing a quarantine through `/health?clear=1`. A
  rollback stays on the site: `shouldRollback()` refuses far more often than it agrees and names its
  reason every time, so a `--force-rollback` would be a flag whose only job is defeating a guard.
  `/pitr` reaches a 30-day window with no undo and stays diagnostic-only. Recycling the interpreter
  has to happen BETWEEN invocations, so a request that triggered one would hold both allocations.
- **`modify upload` does not enable anything.** `/install` and `/enable` are separate on the worker
  because a package whose files have landed is not a module Drupal knows about, and folding them
  would hide an enable failure behind an upload success.
- `cf workers` lists and compares; it does not create or delete.
- `migrate export` reads `/export`; there is no `migrate import` writing to `/restore`.
- The survey command plan in `src/migrate/survey.ts` is read-only by construction, and
  `tests/migrate-survey.spec.ts` asserts that no step matches a mutating verb.
- Any future teardown must refuse without `--yes` and must verify the worker list returns to its
  prior baseline -- which is what `cf workers --save` / `--compare` exists for.

**There is no delete seam on `FileHost` and there must not be one.** Three consequences, all of them
deliberate: `build --force` re-runs install and hydrate and never re-clones, a workspace holding
something other than a `@drupflare/worker` checkout is refused rather than cleared, and `--refresh`
is `merge --ff-only` after a `status --porcelain` check rather than `reset --hard`. The honest answer
to "I want a fresh tree" is a different `--workspace`.

**Deploying goes through the user's wrangler, never through drangler's HTTP client.** The credential
is wrangler's own and is never read here. A REST deploy would need a token with write scope, which is
a strictly worse thing to ask for than the login they already have.

**Backups are taken before the first write, not before each one.** `src/workspace/copy.ts` snapshots
every destination it would overwrite, verifies each snapshot by digest, and only then writes
anything. Interleaving them leaves a failure part-way with half a tree replaced and half of it
unbacked, which is worse than either finishing or refusing. `migrate restore` verifies the whole set
before it writes, for the same reason. An identical file is a third verdict and gets neither a backup
nor a write -- a backup directory full of files that never changed is one nobody reads when it
matters.

## Measurement discipline, inherited from `../worker`

RULE 0 there says an absolute CPU figure comes only from a deployed worker, and that `wrangler tail`
has been measured **silently omitting every `durableObject` event**. Two consequences bind code here:

- `health` reports `wallMs` and labels it "wall clock, not cpuTime". It is not a CPU figure and must
  never be presented as one.
- `cf cpu` refuses a tail capture that holds stateless events and no durableObject event, and says
  to use the Workers Observability API instead. **That guard is the feature**; the arithmetic is not.

Platform figures the migration rules score against live in one table, `LIMITS` in
`src/migrate/rules.ts`. A rule never states a ceiling of its own.

## Exit codes are a closed set

`0` ok, `1` the check could not run, `2` bad input, `3` the check ran and found something. Collapsing
3 onto 1 is what makes a CI step grep output instead of reading a status.

## A release attaches its assets at CREATION, never after

`.github/workflows/release.yml` is the `cartridge` / `durabledb` shape -- a `release` job that tags
from `package.json`, then a `publish` job for npm and GitHub Packages -- plus a `binaries` job in
front of both. Two things about it are load-bearing rather than stylistic.

**The archives are handed to `softprops/action-gh-release` in its `files:`, so the release is
published complete.** The organisation turns on GitHub's immutable releases, which freeze a
published release's tag and assets: a workflow that creates the release and then uploads to it is
one that cannot upload. The same ordering is what `../worker` already does with its payload tarball,
and it also removes the state where a tag exists and its assets do not. `fail_on_unmatched_files`
holds it: a glob that matches nothing would otherwise publish an empty release quietly.

**Every target is cross-compiled on ONE runner.** `bun build --compile --target=bun-<os>-<arch>`
downloads the target runtime and emits a real binary for it -- measured from darwin-arm64, the
linux-x64 output is `ELF 64-bit LSB executable, x86-64` -- so five platforms cost one job rather
than a runner matrix. The runner then extracts its OWN target's archive and runs `--version` against
it, which is the only one of the five it can execute; the other four are checked by their build
exiting zero.

Two checks exist because drangler is the only sibling with a `bin`. `dist/cli.js` is gitignored and
produced by `prepublishOnly`, so the publish job builds it and runs it before publishing -- a
package whose entry point does not exist would otherwise publish clean.

## Conventions

- Tabs rendered 4 wide, 100-char lines, LF, ASCII only.
- **Internal relative imports carry no extension** (`from './commands/status'`). This differs from
  `../worker`, where `wrangler.jsonc` aliases an exact specifier string and the `.js` is
  load-bearing. There is no wrangler alias here. Matches `../cartridge`.
- `bunx`, never `npx`.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.
- No comments in config files or `.github/` workflows.
- Every command's `--json` prints the same object its text render is derived from, so the two cannot
  drift. **Stdout carries that object and nothing else**: progress goes to stderr, which is what
  `runPlan` got wrong -- each step's line landed in front of `build --json`'s object and broke `jq`
  on any build that did work. The resumed case ran no step, so the passing `--json` test could not
  see it.

## Commands

```sh
bun run typecheck # tsc over src/ AND tests/, then the e2e fixture worker
bun run test      # the gate: no network, no daemon
bun run test:coverage
bunx prettier --check .
bun run build:binary # bun build --compile into dist/drangler

REQUIRE_SIBLINGS=1 bun run test # also score the three checks that read ../worker's source
```

**Count it, do not quote it.** This block carried an assertion count for two sessions and it was
stale both times; a number copied forward from a previous session is not a measurement.

## What the workspace lane covers, and the one half that waits on a release

`drupflare/worker` is public, and `tests/e2e/workspace-clone.spec.ts` builds a workspace out of it
with the real runner and the real filesystem. What each lane is worth:

- **The gate** covers argument parsing, workspace resolution, step ordering, the resume decision,
  the gate sets and every check's verdict, against a scripted runner and a memory filesystem.
- **The clone lane** covers what only exists off this machine: that a `git clone` lands a tree whose
  `package.json` names `@drupflare/worker`, that `bun install` resolves it from npm, that
  `interpreterFiles()` reads the alias the worker ships rather than the one in a fixture, that
  `validate` names all eleven missing artifacts on a clean checkout and exits 3, and that a second
  plan re-clones and re-installs nothing.
- **The payload half waits on a release**, because no tag exists yet. It runs against a tarball
  named by `DRANGLER_E2E_PAYLOAD`, and it starts running against the real thing on its own the
  first time a release is cut -- `resolvePayload()` probes for the tag, so nothing needs editing.
  Set `REQUIRE_PAYLOAD=1` once a release is expected to always be there.

`--source` takes a local path precisely so all of this stays exercisable against a fork:
`git clone /path/to/worker` is an ordinary clone of a repository that happens to be on this disk.

**Only a release proves a payload is deployable, so only a release is asserted green.** A tarball
handed in by `DRANGLER_E2E_PAYLOAD` is whatever somebody built: the lane requires every check to
reach a verdict on it and reports `scrub` rather than asserting it. A published one has passed
`release-payload.ts`'s credential gate at pack time and `tests/node/pack-secrets.spec.ts` over the
attached bytes at release time. Measured while wiring this up: the tarball in the worker's local
`dist/` was built ten hours before its pack was scrubbed and still carries a `hash_salt`, which is
exactly the input that must not be allowed to pass as a release.
