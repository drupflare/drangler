# e2e specs

**e2e means "needs something this machine cannot fake".** The unit lane proves the code agrees with
its fixtures; this one proves the fixtures resemble MySQL, SQLite, ssh, workerd and the published
`drupflare/worker`.

Two requirements, two gates, two CI jobs:

| specs                     | needs                         | gate             |
| ------------------------- | ----------------------------- | ---------------- |
| `workspace-clone.spec.ts` | the network and a public repo | `REQUIRE_CLONE`  |
| everything else           | a Docker daemon               | `REQUIRE_DOCKER` |

```sh
bun run e2e:up # boots MariaDB and a real Drupal 11; the first run installs the site
bun run test:e2e
bun run test:e2e:clone # the clone lane alone; no Docker, about 10 seconds
bun run e2e:down       # removes the containers and their volumes
```

`test:e2e` brings the stack up itself, so `e2e:up` is only for keeping it warm between runs.

## The Split

**The VPS half is Docker**, because a real Drupal on a real MariaDB is the half that cannot be
faked. Two services, in `docker/compose.yml`:

| service  | what it is                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| `db`     | MariaDB, utf8mb4, `STRICT_TRANS_TABLES`, published on `127.0.0.1:33306`         |
| `drupal` | `drupal:11-apache` plus drush and an sshd, published on `:8180` and ssh `:2222` |

**The Worker half is not Docker**, because workerd is already available without one.
`helpers/worker.ts` boots the fixture worker under `wrangler dev` on a scratch `--persist-to` and
deletes that directory afterwards, which is the approach `drupflare/worker`'s
`scripts/e2e-lifecycle.ts` takes and for its reason: a Durable Object namespace persists, was
measured at 970 MB there, and state surviving a run makes the next run's assertions meaningless.

`fixture-worker/` speaks the worker's HTTP contract -- `/serve`, `/export` with the owner tier,
`x-cfw-*` headers -- against a real Durable Object SQLite. It is **not** a copy of the worker's
`dumpDatabase()`, and this lane does not claim to test that; the real worker's dump has its own
suite in its own repository. What is proven here is that drangler reads a real envelope off a real
socket, that its converted SQL is accepted by a real Durable Object, and that the bytes survive.

`worker/scripts/pack-sql.ts` records the failure this rule exists for: the first version of its
fidelity test compared source against replay **through the same NUL-truncating API**, both sides
read 117 of 1,697 bytes, and the digests matched.

| role            | how it reads                                                            |
| --------------- | ----------------------------------------------------------------------- |
| **the mover**   | `mysqldump` / `/export` -> `convertDump()` -> a client load             |
| **the checker** | `SELECT HEX(col)` in MySQL, `hex(col)` in SQLite, `/rows` in the object |

Neither engine's client can mangle a hex string, so a NUL, a raw newline and a byte that is not
valid UTF-8 all survive the comparison itself. `/rows` is a separate route from `/export` for the
same reason.

There is a **third** reading: `helpers/seed.ts` declares every value as hex in TypeScript, and both
sides are compared against it rather than against each other. Two agreeing readings can share a bug;
three, one of which is a literal, cannot hide one.

## Seed Coverage

Five rows, fifteen values, in `helpers/seed.ts`. Inserted with `0x` literals so the seed shares no
escaping code with the converter under test.

| covered                                         | why                                 |
| ----------------------------------------------- | ----------------------------------- |
| NUL, raw newline, `0x1A`, a high byte in a blob | the classic truncating reads        |
| a NUL inside TEXT                               | ends a SQLite string literal        |
| a single quote and a semicolon in text          | quoting and the statement splitter  |
| backslashes                                     | a MySQL escape and a SQLite literal |
| 4-byte utf8mb4 and a Greek final sigma          | connection charset and case folding |
| `2^53 + 1`, `-2^53 - 1`, `BIGINT` max           | integers a double cannot hold       |
| a zero-length blob and an empty string          | neither is NULL                     |
| text that looks like `--` and `#` SQL comments  | a line-oriented parser would eat it |

**Gaps, stated rather than implied:**

- Only the corpus table is byte-compared. The surrounding Drupal tables are compared by row count.
- No TEXT holding bytes that are not valid UTF-8; a utf8mb4 column refuses them, so that path is
  unit-tested only.
- Nothing above `BIGINT` max, which MySQL cannot store.
- The 2,199,995-byte record cap is not exercised at its boundary. The 100,000-character statement
  ceiling **is**, by a real `cache_container` row.
- No multi-site, no non-`standard` install profile, no contrib modules.

## Proving the Lane Can Fail

`detector.spec.ts` plants a defect and asserts the comparator goes red. Every case is planted in the
**data**, never by patching the converter: breaking the mover would prove the mover can be broken,
not that the checker notices.

| planted                                | what it stands for                                 |
| -------------------------------------- | -------------------------------------------------- |
| a table loaded with schema and no rows | a migration that skips a table and reports success |
| one row dropped from the middle        | the same, past a spot check on the first row       |
| a value truncated at its first NUL     | the `pack-sql.ts` failure, exactly                 |
| a blob missing its trailing bytes      | a silent width loss                                |
| a row the source never had             | why the comparison runs in both directions         |
| a row count disagreeing with the rows  | the reported-versus-actual check                   |
| a multi-byte value mangled by latin1   | a lossy conversion that still looks like a string  |

## The Clone Lane

`workspace-clone.spec.ts` builds a workspace out of the published `drupflare/worker` with the real
runner and the real filesystem: `git clone`, `bun install`, then `bun run hydrate`. The gate lane
drives the same functions against a scripted runner whose steps land the files they really produce,
which proves the step order, the resume decision and every verdict. Three things only exist off this
machine:

- a `git clone` of the repository lands a tree whose `package.json` names `@drupflare/worker`
- `bun install` resolves the worker's dependencies from npm
- `interpreterFiles()` reads the alias the worker actually ships, and the seam it points at

A clean checkout is asserted **before** it is hydrated, because the window between `git clone` and
`bun run hydrate` is where a user reads drangler's report. There is no `--no-hydrate` flag and there
should not be; the spec filters the plan it would have run instead of adding a flag to the product.

**The hydrate half needs a payload**, which is a separate question from whether the clone works:

| resolved from                      | how                                         | what the lane then asserts                         |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `DRANGLER_E2E_PAYLOAD`             | a tarball from `bun run release:payload`    | every check reaches a verdict; `scrub` is reported |
| a release on the cloned repository | probed by tag, then downloaded by `hydrate` | the same, **and** every check passes               |

The two are not equivalent, so which one it was is carried rather than flattened. A hand-built
tarball proves the hydrate path and nothing about what is published; a release has passed
`release-payload.ts`'s credential gate and, in the Release workflow, `pack-secrets.spec.ts` over the
attached bytes. Asserting green on someone's local tarball would test the tarball.

No release exists yet, so the payload tests skip and say so. They start running on their own the
first time a release is cut -- no workflow edit. `REQUIRE_PAYLOAD=1` turns the absence into a
failure, which is what to set once a release is expected to always be there.

## Skip Locally, Fail When the Lane Declares It

`helpers/docker.ts` probes the daemon and `helpers/clone.ts` probes the remote with
`git ls-remote`. Missing and unset, they skip; missing **with** `REQUIRE_DOCKER=1` or
`REQUIRE_CLONE=1`, they throw and name what is missing.

Gated on those rather than on `CI`, which is the correction `drupflare/worker`'s `artifact-gate.ts`
had to make: gating on `CI` puts every requirement into every lane at once. `.github/workflows/e2e.yml`
runs the two as separate jobs, so a red one names which requirement failed -- the clone job takes
about a minute, the Docker job installs Drupal and takes tens of them.

## Why It Is Its Own Vitest Project

`bun run test` is the commit gate and must be hermetic. These specs need a daemon or a network, so
`vitest.config.ts` declares a second project and `bun run test` runs `--project=unit` only. A gate
that can be unavailable is not a gate.
