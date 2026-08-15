#!/usr/bin/env bash
# Boots a real Drupal 11 with drush and an sshd, then hands over to apache.
#
# Everything here happens at container start rather than in a Dockerfile so the compose file stays
# the only thing to read and no image has to be built or pushed. It costs a few minutes on the
# first boot, which is why this lane is nightly and dispatch-only.
set -euo pipefail

READY=/opt/drangler-ready
rm -f "$READY"

log() { echo "[drangler-e2e] $*"; }

if [ -z "${SSH_PUBLIC_KEY:-}" ]; then
	log "SSH_PUBLIC_KEY is empty."
	log "tests/e2e/helpers/stack.ts mints a throwaway keypair and exports DRANGLER_E2E_SSH_PUBKEY."
	log "Bring the stack up through it, or export that variable yourself."
	exit 1
fi

# #region packages
log "installing openssh-server and a mariadb client"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server mariadb-client > /dev/null
# #endregion

# #region sshd
# the survey reaches this host the way a real one is reached: a key, no password, no tty
SSH_USER="${SSH_USER:-tester}"
id -u "$SSH_USER" > /dev/null 2>&1 || useradd -m -s /bin/bash "$SSH_USER"
install -d -m 700 -o "$SSH_USER" -g "$SSH_USER" "/home/$SSH_USER/.ssh"
printf '%s\n' "$SSH_PUBLIC_KEY" > "/home/$SSH_USER/.ssh/authorized_keys"
chmod 600 "/home/$SSH_USER/.ssh/authorized_keys"
chown "$SSH_USER:$SSH_USER" "/home/$SSH_USER/.ssh/authorized_keys"
# PasswordAuthentication stays off: sshTransport passes BatchMode=yes, and a host that could
# prompt would hang a CLI that has already returned control
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
mkdir -p /run/sshd
ssh-keygen -A > /dev/null
/usr/sbin/sshd
log "sshd listening for $SSH_USER"
# #endregion

# #region drush
cd /opt/drupal
if [ ! -x vendor/bin/drush ]; then
	log "installing drush (this is the slow step)"
	COMPOSER_ALLOW_SUPERUSER=1 composer require --no-interaction --quiet drush/drush
fi
ln -sf /opt/drupal/vendor/bin/drush /usr/local/bin/drush
# the survey shells out as $SSH_USER, so it has to be able to read the tree and write the file dir
chown -R "$SSH_USER:$SSH_USER" /opt/drupal/web/sites/default || true
# #endregion

# #region site install
if ! drush --root=/opt/drupal/web status --field=bootstrap 2> /dev/null | grep -qi successful; then
	log "installing Drupal against ${DRUPAL_DB_HOST}"
	chmod u+w /opt/drupal/web/sites/default
	COMPOSER_ALLOW_SUPERUSER=1 drush --root=/opt/drupal/web site:install standard \
		--yes \
		--account-name=admin \
		--account-pass=e2epassword \
		--site-name='drangler e2e' \
		--site-mail="${DRUPAL_SITE_MAIL:-e2e@example.com}" \
		--db-url="mysql://${DRUPAL_DB_USER}:${DRUPAL_DB_PASSWORD}@${DRUPAL_DB_HOST}/${DRUPAL_DB_NAME}"
	# a node and an image style, so the survey's counts are non-zero and its rules have real input
	drush --root=/opt/drupal/web php:eval '
		$node = \Drupal\node\Entity\Node::create(["type" => "page", "title" => "e2e front"]);
		$node->save();
	'
fi
chown -R "$SSH_USER:$SSH_USER" /opt/drupal/web/sites/default/files || true
# #endregion

log "ready"
touch "$READY"

exec docker-php-entrypoint apache2-foreground
