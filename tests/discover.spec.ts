import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import {
	chooseSiteDir,
	discoverLayout,
	discoveryCommands,
	drushPrefix,
	looksLikeDocroot,
	parseApacheVhosts,
	parseNginxServers,
	parseWebUser,
	sourceId
} from '../src/migrate/discover';
import { readOnlyTransport, refuseRemote } from '../src/migrate/preview';
import type { Transport } from '../src/migrate/transport';

// the earth-app box's two enabled vhosts, as the survey read them
const DRUPAL_CONF = `<VirtualHost *:443>
    ServerName api.earth-app.com

    DocumentRoot /var/www/drupal/web

    <Directory /var/www/drupal/web>
        AllowOverride All
        Require all granted
    </Directory>

    SSLEngine on
    ErrorLog \${APACHE_LOG_DIR}/drupal_error.log
</VirtualHost>
`;
const INSTALL_PROGRESS_CONF = `<VirtualHost *:80>
	ServerName _
	DocumentRoot /var/www/html
</VirtualHost>
<VirtualHost *:443>
	ServerName _
	DocumentRoot /var/www/html
	SSLEngine on
</VirtualHost>
`;
const DOCROOT_LISTING = [
	'/var/www/drupal/web/index.php',
	'/var/www/drupal/web/autoload.php',
	'/var/www/drupal/web/update.php',
	'/var/www/drupal/web/robots.txt'
].join('\n');

/** answers from a table; an unscripted command is a path that is not there */
function host(table: Record<string, string>): { transport: Transport; calls: string[] } {
	const calls: string[] = [];
	const transport: Transport = {
		label: 'fake',
		async exec(command) {
			calls.push(command);
			const out = table[command];
			return out === undefined
				? { code: 2, stdout: '', stderr: 'No such file or directory' }
				: { code: 0, stdout: out, stderr: '' };
		},
		async download() {
			throw new Error('discovery downloads nothing');
		}
	};
	return { transport: readOnlyTransport(transport), calls };
}

const EARTH_APP: Record<string, string> = {
	'id -u': '0\n',
	'ls /etc/apache2/sites-enabled': 'drupal.conf\ninstallProgress.conf\n',
	'cat /etc/apache2/sites-enabled/drupal.conf': DRUPAL_CONF,
	'cat /etc/apache2/sites-enabled/installProgress.conf': INSTALL_PROGRESS_CONF,
	'find /var/www/drupal/web -maxdepth 1 -type f': DOCROOT_LISTING,
	'find /var/www/html -maxdepth 1 -type f': '/var/www/html/index.html\n',
	'cat /etc/apache2/envvars':
		'export APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=www-data\n',
	'ls /var/www/drupal/vendor/bin': 'drush\nphpunit\n',
	'ls /var/www/drupal/web/sites':
		'README.txt\ndefault\ndevelopment.services.yml\nexample.settings.local.php\nexample.sites.php\n'
};

describe('vhost parsing', () => {
	it('reads the apache blocks the earth-app box serves, and ignores the catch-all name', () => {
		const vhosts = [
			...parseApacheVhosts(DRUPAL_CONF, 'drupal.conf'),
			...parseApacheVhosts(INSTALL_PROGRESS_CONF, 'installProgress.conf')
		];
		expect(vhosts).toEqual([
			{
				names: ['api.earth-app.com'],
				docroot: '/var/www/drupal/web',
				tls: true,
				file: 'drupal.conf'
			},
			{ names: [], docroot: '/var/www/html', tls: false, file: 'installProgress.conf' },
			{ names: [], docroot: '/var/www/html', tls: true, file: 'installProgress.conf' }
		]);
	});

	it('reads aliases, quoted roots and comments', () => {
		const [v] = parseApacheVhosts(
			[
				'<VirtualHost 10.0.0.1:80>',
				'  ServerName a.example # primary',
				'  ServerAlias b.example *.c.example',
				'  DocumentRoot "/srv/drupal/web"',
				'</VirtualHost>'
			].join('\n')
		);
		expect(v).toMatchObject({
			names: ['a.example', 'b.example', '*.c.example'],
			docroot: '/srv/drupal/web',
			tls: false
		});
	});

	it('reads nginx server blocks at their own depth, not a nested location root', () => {
		const [v] = parseNginxServers(
			[
				'server {',
				'  listen 443 ssl;',
				'  server_name d.example www.d.example;',
				'  root /srv/d/web;',
				'  location /static {',
				'    root /srv/static;',
				'  }',
				'}'
			].join('\n')
		);
		expect(v).toMatchObject({
			names: ['d.example', 'www.d.example'],
			docroot: '/srv/d/web',
			tls: true
		});
	});
});

describe('layout values', () => {
	it('tells a Drupal docroot from a static one by the files only the scaffold ships', () => {
		expect(looksLikeDocroot(DOCROOT_LISTING)).toBe(true);
		expect(looksLikeDocroot('/var/www/html/index.html\n/var/www/html/index.php')).toBe(false);
	});

	it('follows Drupal multisite order: sites.php, then the host, then each suffix, then default', () => {
		expect(chooseSiteDir('api.earth-app.com', ['default'], null)).toBe('default');
		expect(chooseSiteDir('api.earth-app.com', ['default', 'earth-app.com'], null)).toBe(
			'earth-app.com'
		);
		expect(
			chooseSiteDir(
				'api.earth-app.com',
				['default', 'earth-app.com', 'api.earth-app.com'],
				null
			)
		).toBe('api.earth-app.com');
		expect(
			chooseSiteDir(
				'api.earth-app.com',
				['default', 'sites.php'],
				"$sites['earth-app.com'] = 'app';"
			)
		).toBe('app');
		expect(chooseSiteDir(null, ['x'], null)).toBe('default');
	});

	it('names the web user with its source, and says when it is only assumed', () => {
		expect(parseWebUser('export APACHE_RUN_USER=www-data\n', null)).toEqual({
			name: 'www-data',
			source: 'apache envvars'
		});
		expect(parseWebUser(null, 'user nginx;\nworker_processes auto;')).toEqual({
			name: 'nginx',
			source: 'nginx.conf'
		});
		expect(parseWebUser(null, null)).toEqual({ name: 'www-data', source: 'assumed' });
	});

	it('hashes host, composer root, docroot and site directory, so any one of them splits the id', () => {
		const base = sourceId('earth-app', '/var/www/drupal', '/var/www/drupal/web', 'default');
		expect(base).toMatch(/^[0-9a-f]{8}$/);
		expect(sourceId('earth-app', '/var/www/drupal', '/var/www/drupal/web', 'default')).toBe(
			base
		);
		for (const other of [
			sourceId('other', '/var/www/drupal', '/var/www/drupal/web', 'default'),
			sourceId('earth-app', '/var/www/other', '/var/www/drupal/web', 'default'),
			sourceId('earth-app', '/var/www/drupal', '/var/www/drupal/docroot', 'default'),
			sourceId('earth-app', '/var/www/drupal', '/var/www/drupal/web', 'second')
		]) {
			expect(other).not.toBe(base);
		}
	});

	it('runs the project drush as the web user, and a global one only when there is none', () => {
		expect(
			drushPrefix({
				docroot: '/var/www/drupal/web',
				drush: { bin: '/var/www/drupal/vendor/bin/drush', user: 'www-data' },
				uri: 'https://api.earth-app.com'
			})
		).toBe(
			'runuser -u www-data -- /var/www/drupal/vendor/bin/drush --root=/var/www/drupal/web --uri=https://api.earth-app.com'
		);
		expect(drushPrefix({ docroot: '/var/www/html', drush: null, uri: null })).toBe(
			'cd /var/www/html && drush'
		);
	});
});

describe('discoverLayout', () => {
	it('resolves the earth-app box with no flag: docroot, composer root, project drush, web user', async () => {
		const { transport } = host(EARTH_APP);
		const layout = await discoverLayout(transport, { host: 'earth-app' });
		expect(layout).toMatchObject({
			docroot: '/var/www/drupal/web',
			composerRoot: '/var/www/drupal',
			siteDir: 'default',
			uri: 'https://api.earth-app.com',
			drush: { bin: '/var/www/drupal/vendor/bin/drush', user: 'www-data' },
			webUser: { name: 'www-data', source: 'apache envvars' }
		});
		expect(layout.id).toBe(
			sourceId('earth-app', '/var/www/drupal', '/var/www/drupal/web', 'default')
		);
		expect(layout.evidence.join('\n')).toContain('from /etc/apache2/sites-enabled/drupal.conf');
	});

	it('takes a docroot given by hand without scanning the web server config', async () => {
		const { transport, calls } = host(EARTH_APP);
		const layout = await discoverLayout(transport, {
			host: 'earth-app',
			root: '/var/www/drupal/web'
		});
		expect(layout.docroot).toBe('/var/www/drupal/web');
		expect(calls).not.toContain('ls /etc/apache2/sites-enabled');
		expect(layout.drush?.user).toBe('www-data');
	});

	// runuser needs root; a deploy user running the project's drush as itself is the common case
	// on a managed host, and the e2e Drupal is one
	it('runs the project drush as the ssh user when that user is not root', async () => {
		const { transport } = host({ ...EARTH_APP, 'id -u': '1001\n' });
		const layout = await discoverLayout(transport, { host: 'earth-app' });
		expect(layout.drush).toEqual({ bin: '/var/www/drupal/vendor/bin/drush', user: null });
		expect(layout.evidence.join('\n')).toContain('run as the ssh user');
		const prefix = drushPrefix(layout);
		expect(prefix).toBe(
			'/var/www/drupal/vendor/bin/drush --root=/var/www/drupal/web --uri=https://api.earth-app.com'
		);
		expect(refuseRemote(`${prefix} status --format=json`)).toBeNull();
		expect(refuseRemote(`${prefix} sql:query "DROP TABLE node"`)).not.toBeNull();
	});

	it('reads the user id and nothing else of id', () => {
		expect(refuseRemote('id -u')).toBeNull();
		expect(refuseRemote('id')).not.toBeNull();
		expect(refuseRemote('id -u root')).not.toBeNull();
	});

	it('assumes a global drush and says so when the project has no vendor/bin/drush', async () => {
		const { transport } = host({ ...EARTH_APP, 'ls /var/www/drupal/vendor/bin': 'phpunit\n' });
		const layout = await discoverLayout(transport, { host: 'earth-app' });
		expect(layout.drush).toBeNull();
		expect(layout.evidence.join('\n')).toContain('a global drush is assumed');
	});

	it('refuses to guess between two Drupal sites, and --site picks one', async () => {
		const second = DRUPAL_CONF.replace('api.earth-app.com', 'b.example').replace(
			'/var/www/drupal/web',
			'/var/www/b/web'
		);
		const table = {
			...EARTH_APP,
			'ls /etc/apache2/sites-enabled': 'drupal.conf\nb.conf\n',
			'cat /etc/apache2/sites-enabled/b.conf': second,
			'find /var/www/b/web -maxdepth 1 -type f': DOCROOT_LISTING
		};
		await expect(discoverLayout(host(table).transport, { host: 'h' })).rejects.toThrow(
			/2 Drupal docroots/
		);
		const layout = await discoverLayout(host(table).transport, {
			host: 'h',
			site: 'b.example'
		});
		expect(layout.docroot).toBe('/var/www/b/web');
		expect(layout.uri).toBe('https://b.example');
	});

	it('names the flag to pass when the config shows no Drupal at all', async () => {
		const err = await discoverLayout(host({}).transport, { host: 'h' }).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).next).toBe('drangler preview --host h --root /path/to/docroot');
	});
});

describe('the allow-list for discovery', () => {
	it('passes every command discovery can send', () => {
		for (const root of [null, '/var/www/drupal/web']) {
			for (const command of discoveryCommands(root)) {
				expect(refuseRemote(command), command).toBeNull();
			}
		}
	});

	it('runs drush as another user only for the project drush and only for the reads it names', () => {
		const drush = '/var/www/drupal/vendor/bin/drush';
		const lead = `runuser -u www-data -- ${drush} --root=/var/www/drupal/web --uri=https://api.earth-app.com`;
		expect(refuseRemote(`${lead} status --format=json`)).toBeNull();
		expect(refuseRemote(`${lead} sql:dump`)).toBeNull();
		expect(refuseRemote(`${lead} sql:query "SELECT 1"`)).toBeNull();
		expect(refuseRemote(`${lead} cache:rebuild`)).toMatch(/writes/);
		expect(refuseRemote(`${lead} sql:query "DELETE FROM node"`)).toMatch(/must SELECT/);
		expect(refuseRemote('runuser -u root -- /bin/sh')).toMatch(/only runs vendor\/bin\/drush/);
		expect(refuseRemote(`runuser -u www-data -- ${drush}-evil status`)).toMatch(/only runs/);
		expect(refuseRemote(`runuser -u www-data -- /tmp/vendor/bin/drush2 status`)).toMatch(
			/only runs/
		);
	});

	it('scans Redis key names and nothing else', () => {
		expect(refuseRemote('redis-cli --scan')).toBeNull();
		expect(refuseRemote('redis-cli flushall')).toMatch(/only scans/);
		expect(refuseRemote('redis-cli --scan --pattern "a*"')).toMatch(/only scans/);
		expect(refuseRemote('redis-cli get motd')).toMatch(/only scans/);
	});

	it('lists three kinds of directory and reads web server config only by plain file name', () => {
		expect(refuseRemote('ls /etc/apache2/sites-enabled')).toBeNull();
		expect(refuseRemote('ls /var/www/drupal/web/sites')).toBeNull();
		expect(refuseRemote('ls /var/www/drupal/vendor/bin')).toBeNull();
		expect(refuseRemote('ls /root/.ssh')).toMatch(/lists only/);
		expect(refuseRemote('ls /var/www/drupal/web/sites /root')).toMatch(/lists only/);
		expect(refuseRemote('cat /etc/apache2/sites-enabled/drupal.conf')).toBeNull();
		expect(refuseRemote('cat /etc/apache2/envvars')).toBeNull();
		expect(refuseRemote('cat /etc/shadow')).toMatch(/cat reads only/);
		expect(refuseRemote('cat /etc/apache2/sites-enabled/../../shadow')).toMatch(
			/cat reads only/
		);
		expect(refuseRemote('cat /etc/apache2/sites-enabled/a b')).not.toBeNull();
	});
});
