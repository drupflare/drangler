#!/usr/bin/env bash
# starts sshd as www-data, installs the two fixture sites once, then hands over to apache.
# nothing here reaches outside the compose network: every package was installed at build time.
set -euo pipefail

READY=/opt/fixture-ready
ROOT=/opt/drupal/web
DRUSH=/opt/drupal/vendor/bin/drush
rm -f "$READY"

log() { echo "[fixture] $*"; }
as_web() { runuser -u www-data -- "$@"; }

# the ssh user is the web user, so drush and apache write the same files
if [ -n "${SSH_PUBLIC_KEY:-}" ]; then
	install -d -m 700 -o www-data -g www-data /var/www/.ssh
	printf '%s\n' "$SSH_PUBLIC_KEY" > /var/www/.ssh/authorized_keys
	chown www-data:www-data /var/www/.ssh/authorized_keys
	chmod 600 /var/www/.ssh/authorized_keys
	sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
	ssh-keygen -A > /dev/null
	/usr/sbin/sshd
	log "sshd up for www-data"
fi

install_site() {
	local dir="$1" uri="$2" dburl="$3" name="$4"
	chown www-data:www-data "$ROOT/sites/$dir"
	if as_web "$DRUSH" --root="$ROOT" --uri="$uri" status --field=bootstrap 2> /dev/null | grep -qi successful; then
		log "$dir already installed"
		return
	fi
	log "installing $dir"
	as_web "$DRUSH" --root="$ROOT" site:install standard --yes --sites-subdir="$dir" \
		--account-name=admin --account-pass=fixturepass --site-name="$name" \
		--site-mail=fixture@example.invalid --db-url="$dburl" > /dev/null
	as_web "$DRUSH" --root="$ROOT" --uri="$uri" php:eval '
		if (\Drupal\node\Entity\NodeType::load("page") === null) {
			\Drupal\node\Entity\NodeType::create(["type" => "page", "name" => "Basic page"])->save();
		}
		$node = \Drupal\node\Entity\Node::create(["type" => "page", "title" => "'"$name"' front"]);
		$node->save();
	'
}

# an image field on the page type, so a workflow check has an upload form to drive
add_image_field() {
	local uri="$1"
	as_web "$DRUSH" --root="$ROOT" --uri="$uri" php:eval '
		use Drupal\field\Entity\FieldConfig;
		use Drupal\field\Entity\FieldStorageConfig;
		if (FieldStorageConfig::loadByName("node", "field_image") !== null) {
			return;
		}
		FieldStorageConfig::create(["field_name" => "field_image", "entity_type" => "node", "type" => "image"])->save();
		FieldConfig::create([
			"field_name" => "field_image", "entity_type" => "node", "bundle" => "page", "label" => "Image",
			"settings" => ["alt_field_required" => true, "file_extensions" => "png jpg jpeg"],
		])->save();
		$repo = \Drupal::service("entity_display.repository");
		$repo->getFormDisplay("node", "page")->setComponent("field_image", ["type" => "image_image"])->save();
		$repo->getViewDisplay("node", "page")->setComponent("field_image", ["type" => "image", "settings" => ["image_style" => ""]])->save();
	'
}

if [ "${FIXTURE_ROLE:-main}" = "empty" ]; then
	# an unmapped host falls through to sites/default, which points at a database with no tables
	cat > "$ROOT/sites/default/settings.php" <<PHP
<?php
\$databases['default']['default'] = [
	'driver' => 'mysql',
	'host' => 'mysql',
	'database' => 'empty_db',
	'username' => 'drupal',
	'password' => 'drupalpass',
	'prefix' => '',
];
\$settings['hash_salt'] = 'fixture-empty';
PHP
	chown -R www-data:www-data "$ROOT/sites/default"
else
	install_site site-a http://site-a.fixture.localhost \
		"mysql://drupal:drupalpass@mysql:3306/site_a" "Fixture A"
	install_site site-b http://site-b.fixture.localhost \
		"pgsql://drupal:drupalpass@postgres:5432/site_b" "Fixture B"
	add_image_field http://site-a.fixture.localhost
	add_image_field http://site-b.fixture.localhost
fi

touch "$READY"
log "ready"
exec docker-php-entrypoint apache2-foreground
