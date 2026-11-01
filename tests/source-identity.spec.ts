import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import {
	assertUniqueDestinations,
	destinationKey,
	parseDeploymentReceipt,
	parseSourceSiteId,
	serializeDeploymentReceipt,
	serializeSourceSiteId,
	sourceDigest,
	sourceSiteId,
	workerName,
	type DeploymentReceipt,
	type SourceSiteInput
} from '../src/migrate/source-identity';

const source: SourceSiteInput = {
	host: 'www.example.edu',
	docroots: ['/var/www/html'],
	siteDirectory: 'sites/default',
	siteUri: 'https://www.example.edu',
	databaseEndpoint: 'db.internal:3306',
	schema: 'drupal_prod',
	prefix: 'cfw_',
	siteUuid: '7c1d2c4e-3f1a-4b8e-9d1a-2e6f0a1b2c3d',
	aliases: ['example.edu']
};

const other: SourceSiteInput = { ...source, host: 'www.other.edu', siteUuid: '1111' };

function key(site: SourceSiteInput, environment = 'prod') {
	return destinationKey({
		organisation: 'acme',
		plane: 'free',
		account: 'acct-1',
		source: sourceSiteId(site),
		environment
	});
}

describe('SourceSiteId', () => {
	it('round-trips through its serialised form', () => {
		const id = sourceSiteId(source);
		expect(parseSourceSiteId(serializeSourceSiteId(id))).toEqual(id);
	});

	it('keeps sensitive parts out of the serialised form', () => {
		const text = serializeSourceSiteId(sourceSiteId(source));
		expect(text).not.toContain('www.example.edu');
		expect(text).not.toContain('db.internal');
		expect(text).not.toContain('/var/www/html');
	});

	it('treats domain aliases as attributes, not identity', () => {
		const moreAliases = { ...source, aliases: ['example.edu', 'old.example.edu'] };
		expect(sourceSiteId(moreAliases)).toEqual(sourceSiteId(source));
	});

	it('rejects a malformed serialised form', () => {
		expect(() => parseSourceSiteId('{"host":"x"}')).toThrow();
	});
});

describe('DestinationKey', () => {
	it('is deterministic for the same source', () => {
		expect(key(source)).toEqual(key(source));
	});

	it('never produces one key for two different sources', () => {
		expect(key(source)).not.toEqual(key(other));
	});

	it('separates environments on the same source', () => {
		expect(key(source, 'prod')).not.toEqual(key(source, 'staging'));
	});

	it('derives a worker name from a label and a short deterministic suffix', () => {
		const k = key(source);
		const name = workerName('campus-www', k);
		expect(name).toMatch(/^campus-www-[0-9a-f]{8}$/);
		expect(workerName('campus-www', k)).toBe(name);
		expect(workerName('campus-www', key(other))).not.toBe(name);
	});

	it('rejects a duplicate destination', () => {
		expect(() => assertUniqueDestinations([key(source), key(other)])).not.toThrow();
		expect(() => assertUniqueDestinations([key(source), key(source)])).toThrow(UsageError);
	});
});

describe('DeploymentReceipt', () => {
	const receipt: DeploymentReceipt = {
		origin: 'https://campus-www-1a2b3c4d.example.workers.dev',
		source: sourceDigest(sourceSiteId(source)),
		epoch: 3,
		revision: 'rev-9',
		state: 'sealed',
		findings: [{ capability: 'blocking-outbound', status: 'present' }],
		expiresAt: 1_800_000_000_000
	};

	it('round-trips through its serialised form', () => {
		expect(parseDeploymentReceipt(serializeDeploymentReceipt(receipt))).toEqual(receipt);
	});

	it('refuses a state outside sealed, claimed and verified', () => {
		const bad = { ...receipt, state: 'deployed' };
		expect(() => parseDeploymentReceipt(JSON.stringify(bad))).toThrow();
	});
});
