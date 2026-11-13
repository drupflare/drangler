FROM drupal@sha256:d059fada2d2f9ebfcde8f8d3208007946d1ee843ee2dd9ed00b15ead0c282def

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update -qq \
	&& apt-get install -y -qq --no-install-recommends openssh-server mariadb-client postgresql-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /run/sshd \
	&& usermod -s /bin/bash www-data \
	&& COMPOSER_ALLOW_SUPERUSER=1 composer --working-dir=/opt/drupal require --no-interaction --quiet drush/drush:13.8.0 \
	&& test -x /opt/drupal/vendor/bin/drush \
	&& ! command -v drush

COPY sites.php /opt/drupal/web/sites/sites.php
COPY entrypoint.sh /opt/fixture/entrypoint.sh

ENTRYPOINT ["/bin/bash", "/opt/fixture/entrypoint.sh"]
