import { FindingError } from '../errors';
import {
	sourceDigest,
	sourceSiteId,
	type SourceSiteId,
	type SourceSiteInput
} from './source-identity';
import type { Transport } from './transport';

/** `system.site` is stored as one serialized array, and its `uuid` is what names the site */
export function parseSiteUuid(output: string): string | null {
	let text = output.trim();
	// PostgreSQL prints a bytea column as `\x` and hex
	if (/^\\x[0-9a-f]+$/i.test(text)) text = Buffer.from(text.slice(2), 'hex').toString('latin1');
	return (
		/s:4:"uuid";s:36:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(
			text
		)?.[1] ?? null
	);
}

/** the connection values of the default database, as settings.php spells them */
export function parseDatabase(settings: string): {
	driver: string | null;
	host: string | null;
	port: string | null;
	database: string | null;
	prefix: string;
} {
	const pick = (key: string): string | null =>
		new RegExp(`['"]${key}['"]\\s*=>\\s*['"]([^'"]*)['"]`).exec(settings)?.[1] ?? null;
	return {
		driver: pick('driver'),
		host: pick('host'),
		port: pick('port'),
		database: pick('database'),
		prefix: pick('prefix') ?? ''
	};
}

export interface SourceIdentity {
	input: SourceSiteInput;
	id: SourceSiteId;
	digest: string;
}

export interface IdentityOptions {
	/** the ssh destination as given, which is hashed and never stored */
	host: string;
	docroot: string;
	siteDir: string;
	uri: string | null;
	driver: string | null;
	/** the drush prefix the layout resolved, with `--root` and `--uri` already on it */
	drush: string;
	/** `sites/<dir>/settings.php` as read, or null when it could not be */
	settings: string | null;
	aliases?: string[];
}

/**
 * Reads the stable identity of one source site: its site UUID out of the database, and where that
 * database is.
 *
 * An empty or unreadable database has no `system.site` row, and a source with nothing in it is a
 * refusal rather than a zero-row success, so it is never given an identity that something could be
 * sealed under.
 */
export async function readSourceIdentity(
	transport: Transport,
	o: IdentityOptions
): Promise<SourceIdentity> {
	const got = await transport.exec(
		`${o.drush} sql:query "SELECT data FROM config WHERE name = 'system.site'"`
	);
	const uuid = got.code === 0 ? parseSiteUuid(got.stdout) : null;
	if (uuid === null) {
		throw new FindingError(
			'empty-source',
			`sites/${o.siteDir} has no system.site configuration in its database (${got.code === 0 ? 'no row' : `drush exited ${got.code}`}); an empty or unreadable source is not sealed`
		);
	}
	const db = parseDatabase(o.settings ?? '');
	const input: SourceSiteInput = {
		host: o.host,
		docroots: [o.docroot],
		siteDirectory: o.siteDir,
		siteUri: o.uri ?? `http://${o.siteDir}`,
		databaseEndpoint: `${db.driver ?? o.driver ?? '?'}://${db.host ?? '?'}:${db.port ?? ''}`,
		schema: db.database ?? '',
		prefix: db.prefix,
		siteUuid: uuid,
		...(o.aliases === undefined ? {} : { aliases: o.aliases })
	};
	const id = sourceSiteId(input);
	return { input, id, digest: sourceDigest(id) };
}
