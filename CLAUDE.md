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

## Never copy code out of `../worker`

`drupflare/worker` is the deployable product and this CLI reads its behaviour, never its source.
Most of `worker/scripts/*` is build pipeline the worker itself imports -- `scrub-pack-secrets.ts`
alone has four referencing files, including the release credential gate -- and a second copy of the
pack format here is exactly the drift that workspace has already spent a session deleting.

Two specifics, both settled:

- **`src/secrets/patterns.ts` stays drangler's own list.** It is a superset: it scans VPS
  filesystems and config, which the worker never does. Three entries overlap
  `worker/scripts/release-payload.ts`'s `CREDENTIAL_PATTERNS` and are duplicated **on purpose** --
  see the docblock there for what drift would cost. Not a TODO, and not a package.
- **The per-file pack format** (`{p, o, c, l, m, s}` into one blob) is NOT reimplemented here and
  must not be. It has one implementation, in the worker. If drangler ever needs to read a pack that
  is a conversation to have then, not something to pre-build.

## Every external effect goes through a seam

Five, all on `Context` in `src/context.ts`: `io`, `files`, `runner`, `fetch`, `env`/`cwd`/`now`.
Commands take a context and nothing else.

- **No test contacts a network, a VPS or Cloudflare.** `tests/helpers.ts` substitutes all five.
- SSH is `Transport` in `src/migrate/transport.ts`, with three implementations: real `ssh` through
  the runner, a recorded transcript, and one that refuses everything for `--dry-run`.
- Subprocesses are `CommandRunner` in `src/host/exec.ts`. `git`, `ssh` and `wrangler` all use it.
- `execFile`, never a shell, so no argument is word-split. `parseTarget()` and `normaliseRoot()`
  validate anything that becomes argv or remote command text.

## The e2e lane is where the converter is actually tested

`tests/e2e/` needs Docker and is `workflow_dispatch` plus nightly, never the push gate. Read
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

## Read-only by default

Nothing in the default paths deploys, deletes or writes to a remote host.

- `cf workers` lists and compares; it does not create or delete.
- `migrate export` reads `/export`; there is no `migrate import` writing to `/restore`.
- The survey command plan in `src/migrate/survey.ts` is read-only by construction, and
  `tests/migrate-survey.spec.ts` asserts that no step matches a mutating verb.
- Any future teardown must refuse without `--yes` and must verify the worker list returns to its
  prior baseline -- which is what `cf workers --save` / `--compare` exists for.

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
  drift.

## Commands

```sh
bun run typecheck
bun run test # 310 assertions across 11 specs
bun run test:coverage
bunx prettier --check .
bun run build:binary # bun build --compile into dist/drangler
```
