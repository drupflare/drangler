#!/usr/bin/env bash
# usage: fixture.sh up [negative] | down | ssh [cmd...] | check | negative 503|wrong-site|empty-db
set -euo pipefail

cd "$(dirname "$0")"
STATE=.state
KEY=$STATE/id_ed25519
HTTP=http://127.0.0.1:8280
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
LAUNCHER=/opt/drupal/vendor/bin/drush
ROOT=/opt/drupal/web

compose() { FIXTURE_SSH_PUBKEY="$(cat "$KEY.pub" 2> /dev/null || true)" docker compose "$@"; }
fx_ssh() { local port="$1"; shift; ssh "${SSH_OPTS[@]}" -p "$port" www-data@127.0.0.1 "$@"; }
get() { curl -sS -m 20 --resolve "$1:8280:127.0.0.1" "http://$1:8280$2" "${@:3}"; }
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

case "${1:-}" in
up)
	mkdir -p "$STATE"
	[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY"
	profile=()
	[ "${2:-}" = negative ] && profile=(--profile negative)
	compose ${profile[@]+"${profile[@]}"} up -d --build --wait --wait-timeout 600
	;;
down)
	compose --profile negative down -v --remove-orphans
	rm -f "$KEY" "$KEY.pub"
	;;
ssh)
	shift
	fx_ssh 2280 "$@"
	;;
check)
	for h in site-a alias-a site-b; do
		{ get "$h.fixture.localhost" / | grep -o '| Fixture [AB]<' || true; } | head -1 | sed "s/^/$h -> /"
	done
	[ "$(get alias-a.fixture.localhost / | grep -c '| Fixture A<')" -gt 0 ] && ok "alias serves site A" || bad "alias"
	[ "$(get site-b.fixture.localhost / | grep -c '| Fixture B<')" -gt 0 ] && ok "site-b serves site B" || bad "site-b"
	loc=$(get other.fixture.localhost / -o /dev/null -w '%{redirect_url}')
	case "$loc" in *install.php*) ok "unmapped host lands on the installer" ;; *) bad "unmapped host: $loc" ;; esac
	[ -z "$(fx_ssh 2280 'command -v drush || true')" ] && ok "no drush on PATH over ssh" || bad "drush on PATH"
	fx_ssh 2280 "$LAUNCHER --version" | grep -q 'Drush Commandline' && ok "app-local launcher runs" || bad "launcher"
	for s in a b; do
		out=$(fx_ssh 2280 "cd /opt/drupal && $LAUNCHER --root=$ROOT --uri=http://site-$s.fixture.localhost status --fields=bootstrap,db-driver,db-name --format=json")
		echo "site-$s: $out"
		case "$out" in *Successful*) ok "site-$s bootstraps" ;; *) bad "site-$s bootstrap" ;; esac
	done
	fx_ssh 2280 'mysqldump --no-tablespaces -h mysql -udrupal -pdrupalpass site_a node_field_data' | grep -q 'CREATE TABLE' \
		&& ok "mysqldump reads site_a over ssh" || bad "mysqldump"
	fx_ssh 2280 'PGPASSWORD=drupalpass pg_dump -h postgres -U drupal site_b -t node_field_data' | grep -q 'CREATE TABLE' \
		&& ok "pg_dump reads site_b over ssh" || bad "pg_dump"
	if docker compose -p drangler-fixture exec -T drupal curl -sS -m 4 -o /dev/null https://example.com 2> /dev/null; then
		bad "egress is open"
	else ok "no egress from the drupal container"; fi
	exit "$fail"
	;;
negative)
	case "${2:-}" in
	503)
		echo "source:      127.0.0.1:8281"
		echo "destination: 127.0.0.1:8282"
		for p in 8281 8282; do curl -sS -m 5 -i "http://127.0.0.1:$p/user/login" | head -n 1; done
		;;
	wrong-site)
		for h in site-a site-b; do
			uuid=$(fx_ssh 2280 "cd /opt/drupal && $LAUNCHER --root=$ROOT --uri=http://$h.fixture.localhost config:get system.site uuid --format=string")
			echo "$h uuid=$uuid"
		done
		echo "expected identity is site-a's; point the tool at site-b.fixture.localhost (or other.fixture.localhost, an unmapped host)"
		;;
	empty-db)
		echo "needs: fixture.sh up negative"
		get empty.fixture.localhost / -o /dev/null -w 'empty site http=%{http_code} redirect=%{redirect_url}\n'
		echo "drush bootstrap: '$(fx_ssh 2281 "cd /opt/drupal && $LAUNCHER --root=$ROOT status --field=bootstrap" || true)'"
		;;
	*) echo "usage: fixture.sh negative 503|wrong-site|empty-db" >&2; exit 2 ;;
	esac
	;;
*)
	sed -n 2p "$0" >&2
	exit 2
	;;
esac
