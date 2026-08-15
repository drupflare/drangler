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

## Read-only apart from four commands that say so, and nothing anywhere deletes

The blanket "nothing here deploys" is gone: `deploy` deploys, because a one-line path to a live
Drupal on the user's own account is the product. What replaces it is narrower and stricter.

**Four commands write, and the description names all four.** `build` and `migrate install` write to
a local workspace; `dev` and `deploy` hand the terminal to wrangler. Everything else is unchanged:

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
bun run typecheck
bun run test # 531 assertions across 18 specs
bun run test:coverage
bunx prettier --check .
bun run build:binary # bun build --compile into dist/drangler
```

**Re-measure that count before quoting it.** It has been stale once already, and a number copied
forward from a previous session is not a measurement.

## What the workspace lane covers, and the one half that waits on a release

`drupflare/worker` is public, and `tests/e2e/workspace-clone.spec.ts` builds a workspace out of it
with the real runner and the real filesystem. What each lane is worth:

- **The gate** covers argument parsing, workspace resolution, step ordering, the resume decision,
  the gate sets and every check's verdict, against a scripted runner and a memory filesystem.
- **The clone lane** covers what only exists off this machine: that a `git clone` lands a tree whose
  `package.json` names `@drupflare/worker`, that `bun install` resolves it from npm, that
  `interpreterFiles()` reads the alias the worker ships rather than the one in a fixture, that
  `validate` names all nine missing artifacts on a clean checkout and exits 3, and that a second
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
