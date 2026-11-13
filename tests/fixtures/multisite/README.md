# Multisite Fixture

A Drupal docroot that serves two sites on three hosts, over two database engines, with drush only
at `vendor/bin/drush`. Nothing in it reaches the network at run time.

| host                        | site   | database               |
| --------------------------- | ------ | ---------------------- |
| `site-a.fixture.localhost`  | site-a | MariaDB `site_a`       |
| `alias-a.fixture.localhost` | site-a | the same, an alias     |
| `site-b.fixture.localhost`  | site-b | PostgreSQL 17 `site_b` |

`sites.php` maps those three hosts. Any other host falls through to `sites/default`, which has no
settings and answers with the installer redirect.

Drupal lives in `/opt/drupal` with the docroot at `/opt/drupal/web`. drush 13.8.0 sits at
`/opt/drupal/vendor/bin/drush` and no `drush` is on `PATH`, over ssh or in the container. The ssh
user is `www-data`, so drush and apache write the same files.

## Start and Stop

```sh
tests/fixtures/multisite/fixture.sh up          # first run builds the image and installs both sites
tests/fixtures/multisite/fixture.sh up negative # adds the empty-database site
tests/fixtures/multisite/fixture.sh check       # assertions against the running fixture
tests/fixtures/multisite/fixture.sh ssh '<cmd>' # run a command as www-data on the drupal container
tests/fixtures/multisite/fixture.sh down        # removes containers, volumes and the throwaway ssh key
```

Ports, all on 127.0.0.1: `8280` http (routed by `Host`), `2280` ssh, `2281` ssh to the empty-database
site, `8281` and `8282` the 503 sources. Hosts under `.localhost` resolve to loopback without
`/etc/hosts` edits. The ssh key is minted in `.state/` (ignored by git) and deleted by `down`.
Logins are `admin` / `fixturepass`.

The image build downloads apt packages and drush from the network once. After that the containers sit
on a Docker `internal` network, and `check` asserts that the drupal container cannot resolve or reach
anything outside it. Only the `gate` nginx container is on a second, published network.

## Cost

Measured with `docker stats --no-stream` on a 8 GiB Docker VM, idle after install, then after 120 page
requests: drupal 93-96 MiB, MariaDB 144-148 MiB, PostgreSQL 36 MiB, gate 3 MiB. That is about 280 MiB
for the main fixture and about 50 MiB more for the empty-database site. The built image is 802 MB on
disk. Install takes under a minute on a warm image cache. Peak RAM under a workflow with uploads has
not been measured.

## Negative Controls

Each prints its coordinates with `fixture.sh negative <name>`.

| input        | what it is                                                                                             | what a correct drangler does                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `503`        | `127.0.0.1:8281` and `:8282` answer 503 with identical headers and body on every path                  | Does not report the pair as verified. Equal status codes are not evidence; the workflow fails |
| `wrong-site` | site-a's expected identity (site UUID) while pointed at `site-b.fixture.localhost` or an unmapped host | Refuses on the identity mismatch before sealing anything                                      |
| `empty-db`   | `empty.fixture.localhost` and ssh `2281`: a Drupal whose database exists and has no tables             | Refuses to seal or migrate it; an empty source is an error, not a zero-row success            |

## Limits

The "MySQL" database is MariaDB 11.8, the engine the existing e2e stack uses. A MySQL 8 or later server
rejects the Debian MariaDB client in this image: `caching_sha2_password` needs TLS trust or a server
key exchange, and drush passes `--defaults-file`, which skips any client config. MySQL proper is
therefore not covered here.
