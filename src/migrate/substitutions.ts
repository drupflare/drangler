/**
 * What a site running on drupflare uses, against what a VPS has to swap back.
 *
 * ENUMERATED rather than summarised, because a user changes every entry by hand. "Swap the service
 * overrides back" is not a step somebody can follow; a class name and the thing that replaces it is.
 *
 * Each `from` is a class or a settings key read out of `drupflare/drupflare` and the shipped
 * `settings.php`. `tests/eligibility.spec.ts` reads that sibling's source and fails when a class
 * named here is not in it, which is the same `REQUIRE_SIBLINGS` shape `tests/target-runtime.spec.ts`
 * uses.
 */

export type SubstitutionKind = 'service' | 'setting' | 'driver';

export interface Substitution {
	kind: SubstitutionKind;
	/** the class or settings key the site runs on drupflare */
	from: string;
	/** what a VPS uses instead */
	to: string;
	/** why it cannot simply be left in place */
	why: string;
}

export const SUBSTITUTIONS: readonly Substitution[] = [
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Cache\\CfwCacheBackendFactory',
		to: 'cache.backend.database',
		why: 'the factory writes into the Durable Object, which a VPS does not have'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Lock\\CfwLockBackend',
		to: 'Drupal\\Core\\Lock\\DatabaseLockBackend',
		why: 'the lock is held in host memory rather than in a table'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Logger\\CfwLogger',
		to: 'dblog or syslog',
		why: 'the logger hands entries to the host, which on a VPS is nothing'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Plugin\\Mail\\CfwMail',
		to: 'php_mail, or the smtp module',
		why: 'mail leaves through a Cloudflare binding that a VPS cannot bind'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Plugin\\ImageToolkit\\CfwImageToolkit',
		to: 'image.settings:toolkit back to gd',
		why: 'transforms run on Cloudflare Images rather than in the interpreter'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Search\\SolariumTransport',
		to: "Solarium's own transport",
		why: 'the transport parks a blocking socket, which needs the host loop'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Config\\MailInterfaceOverride',
		to: 'removed with the module',
		why: 'it only exists to point the mail interface at a plugin the module provides'
	},
	{
		kind: 'service',
		from: 'Drupal\\drupflare\\Http\\ParkFetchHandler',
		to: 'plain Guzzle',
		why: 'the handler yields to the host to perform the request; on a VPS the socket is real'
	},
	{
		kind: 'driver',
		from: 'the cfw_do_sqlite driver block in settings.php',
		to: 'a real mysql or sqlite $databases entry',
		why: 'the driver talks to Durable Object SQLite through the host, not to a database server'
	},
	{
		kind: 'setting',
		from: "$settings['drupflare.argon2']",
		to: 'removed',
		why: 'a VPS without the argon2 extension cannot verify a hash minted under it'
	},
	{
		kind: 'setting',
		from: "$settings['trusted_host_patterns']",
		to: 'rewritten for the VPS hostname',
		why: 'the shipped pattern names the workers hostname and rejects every other Host header'
	},
	{
		kind: 'setting',
		from: "$settings['hash_salt']",
		to: 'a locally generated salt',
		why: 'the pack ships it empty and the object mints one per site, so a restore has none'
	},
	{
		kind: 'setting',
		from: "$settings['config_sync_directory']",
		to: 'a real directory that survives a boot',
		why: 'the shipped path lives in a filesystem the interpreter rebuilds on every boot'
	}
];

/** the class names a spec checks against the sibling module's own source */
export function substitutionClasses(): string[] {
	return SUBSTITUTIONS.filter((s) => s.kind === 'service').map((s) => s.from);
}
