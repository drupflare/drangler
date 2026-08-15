/**
 * Credential shapes drangler refuses to let a migration carry.
 *
 * EVERY PATTERN MATCHES A VALUE, NEVER AN IDENTIFIER. A scan keyed on the word `password` fires on
 * every form definition in a Drupal tree, and a gate that always fires is the same as no gate.
 */
export interface CredentialPattern {
	id: string;
	kind: string;
	re: RegExp;
	/** what a hit actually costs, so a report can be acted on rather than dismissed */
	risk: string;
}

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
	{
		id: 'bcrypt',
		kind: 'password hash',
		// the whole crypt string, not the `$2y$` prefix: 53 characters of salt and digest
		re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,
		risk: 'a user password hash; offline-crackable once the dump leaves the host'
	},
	{
		id: 'hash-salt',
		kind: 'Drupal hash_salt',
		// an assignment of a NON-EMPTY literal, so a scrubbed settings.php passes
		re: /\$settings\['hash_salt'\]\s*=\s*'[^']+'/,
		risk: 'signs one-time login links and form tokens; holding it is enough to mint a password reset'
	},
	{
		id: 'private-key',
		kind: 'system.private_key',
		re: /system\.private_key[\s\S]{0,120}s:\d{2,}:/,
		risk: 'Drupal signs internal tokens with it'
	},
	{
		id: 'db-password',
		kind: 'database password',
		// the $databases array in settings.php, and the same shape a dump of it carries
		re: /'password'\s*=>\s*'[^']+'/,
		risk: 'the source database credential; a migration artifact is the usual way it escapes'
	},
	{
		id: 'database-url',
		kind: 'database URL with a password',
		re: /\b(mysql|mariadb|pgsql|postgres(ql)?):\/\/[^:@\s/]+:[^@\s/]+@/i,
		risk: 'a full connection string, user and password included'
	},
	{
		id: 'pem',
		kind: 'private key',
		re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
		risk: 'a private key in the clear'
	},
	{
		id: 'aws-key',
		kind: 'AWS access key id',
		re: /\bAKIA[0-9A-Z]{16}\b/,
		risk: 'an AWS key id; the secret is usually in the same file'
	},
	{
		id: 'cf-token',
		kind: 'Cloudflare API token',
		re: /\bCLOUDFLARE_API_TOKEN\s*[=:]\s*['"]?[A-Za-z0-9_-]{30,}/,
		risk: 'deploys and deletes workers on the account it belongs to'
	}
];
