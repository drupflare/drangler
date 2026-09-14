#!/usr/bin/env bash
# Boots the same Drupal as entrypoint.sh, then plants ONE fault named by $DRANGLER_FAULT.
#
# The sshd is brought up exactly the way the healthy arm does and stays healthy in every fault. A
# container that refused ssh would test TransportError, which the unit lane already covers with a
# scripted exit 255; what it cannot test is a reachable host whose Drupal is broken, which is what a
# support call looks like.
#
# EVERY FAULT IS PLANTED IN THE CONTAINER, never by patching drangler. Making runSurvey() return an
# error tests that the error branch formats, not that the survey notices.
set -euo pipefail

READY=/opt/drangler-broken-ready
rm -f "$READY"

log() { echo "[drangler-broken] $*"; }

if [ -z "${SSH_PUBLIC_KEY:-}" ]; then
	log "SSH_PUBLIC_KEY is empty."
	log "tests/e2e/helpers/stack.ts mints a throwaway keypair and exports DRANGLER_E2E_SSH_PUBKEY."
	exit 1
fi

FAULT="${DRANGLER_FAULT:-none}"
log "fault: $FAULT"

# #region packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server mariadb-client > /dev/null
# #endregion

# #region sshd
SSH_USER="${SSH_USER:-tester}"
id -u "$SSH_USER" > /dev/null 2>&1 || useradd -m -s /bin/bash "$SSH_USER"
install -d -m 700 -o "$SSH_USER" -g "$SSH_USER" "/home/$SSH_USER/.ssh"
printf '%s\n' "$SSH_PUBLIC_KEY" > "/home/$SSH_USER/.ssh/authorized_keys"
chmod 600 "/home/$SSH_USER/.ssh/authorized_keys"
chown "$SSH_USER:$SSH_USER" "/home/$SSH_USER/.ssh/authorized_keys"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
mkdir -p /run/sshd
ssh-keygen -A > /dev/null
/usr/sbin/sshd
log "sshd listening for $SSH_USER"
# #endregion

# #region a working site, first
cd /opt/drupal
if [ ! -x vendor/bin/drush ]; then
	log "installing drush"
	COMPOSER_ALLOW_SUPERUSER=1 composer require --no-interaction --quiet drush/drush
fi
ln -sf /opt/drupal/vendor/bin/drush /usr/local/bin/drush
chown -R "$SSH_USER:$SSH_USER" /opt/drupal/web/sites/default || true

if ! drush --root=/opt/drupal/web status --field=bootstrap 2> /dev/null | grep -qi successful; then
	log "installing Drupal against ${DRUPAL_DB_HOST}"
	chmod u+w /opt/drupal/web/sites/default
	COMPOSER_ALLOW_SUPERUSER=1 drush --root=/opt/drupal/web site:install standard \
		--yes \
		--account-name=admin \
		--account-pass=e2epassword \
		--site-name='drangler broken' \
		--db-url="mysql://${DRUPAL_DB_USER}:${DRUPAL_DB_PASSWORD}@${DRUPAL_DB_HOST}/${DRUPAL_DB_NAME}"
fi
mkdir -p /opt/drupal/web/sites/default/files
chown -R "$SSH_USER:$SSH_USER" /opt/drupal/web/sites/default/files || true
SETTINGS=/opt/drupal/web/sites/default/settings.php
# #endregion

# #region the fault
case "$FAULT" in
	db-unreachable)
		# the driver is reported and the connection is refused, which is the pair `SELECT 1` exists
		# to separate from "no driver reported"
		chmod u+w "$SETTINGS"
		sed -i "s/'password' => '[^']*'/'password' => 'wrong-on-purpose'/" "$SETTINGS"
		;;
	files-missing)
		rm -rf /opt/drupal/web/sites/default/files
		;;
	php-broken)
		# an interpreter that exits non-zero on every invocation, so every step below it goes with
		# it. This was an unloadable extension in a php.ini, which PHP reports as a startup WARNING
		# and then runs anyway: `php -v` exited 0 and the fault was never planted at all
		mv /usr/local/bin/php /usr/local/bin/php.real
		printf '#!/bin/sh\necho "PHP Startup: Unable to load dynamic library" >&2\nexit 1\n' \
			> /usr/local/bin/php
		chmod +x /usr/local/bin/php
		;;
	drush-absent)
		rm -f /usr/local/bin/drush /opt/drupal/vendor/bin/drush
		;;
	bootstrap-fail)
		chmod u+w "$SETTINGS"
		printf '<?php\n' > "$SETTINGS"
		;;
	none) ;;
	*)
		log "unknown DRANGLER_FAULT: $FAULT"
		exit 1
		;;
esac
# #endregion

log "ready"
touch "$READY"

exec docker-php-entrypoint apache2-foreground
