import { createHash } from 'node:crypto';
import { UsageError } from '../errors';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function canonical(value: object): string {
	return JSON.stringify(
		Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
	);
}

export interface SourceSiteInput {
	host: string;
	docroots: string[];
	siteDirectory: string;
	siteUri: string;
	databaseEndpoint: string;
	schema: string;
	prefix: string;
	siteUuid: string;
	/** attributes only; a domain alias never changes which site this is */
	aliases?: string[];
}

export interface SourceSiteId {
	hostFingerprint: string;
	docroots: string[];
	siteDirectory: string;
	siteUri: string;
	databaseEndpoint: string;
	schema: string;
	prefix: string;
	siteUuid: string;
}

/** the sensitive parts are hashed, so the serialised form names no host, path or endpoint */
export function sourceSiteId(site: SourceSiteInput): SourceSiteId {
	return {
		hostFingerprint: sha(site.host),
		docroots: site.docroots.map(sha).sort(),
		siteDirectory: sha(site.siteDirectory),
		siteUri: sha(site.siteUri),
		databaseEndpoint: sha(site.databaseEndpoint),
		schema: site.schema,
		prefix: site.prefix,
		siteUuid: site.siteUuid
	};
}

export function serializeSourceSiteId(id: SourceSiteId): string {
	return canonical(id);
}

export function parseSourceSiteId(text: string): SourceSiteId {
	const value: unknown = JSON.parse(text);
	const v = value as Partial<Record<keyof SourceSiteId, unknown>>;
	const strings = [
		'hostFingerprint',
		'siteDirectory',
		'siteUri',
		'databaseEndpoint',
		'schema',
		'prefix',
		'siteUuid'
	] as const;
	const valid =
		typeof value === 'object' &&
		value !== null &&
		Array.isArray(v.docroots) &&
		v.docroots.every((d) => typeof d === 'string') &&
		strings.every((k) => typeof v[k] === 'string');
	if (!valid) throw new UsageError('not a source site id');
	return v as SourceSiteId;
}

/** one digest per site; the destination key carries this, never the raw id */
export function sourceDigest(id: SourceSiteId): string {
	return sha(serializeSourceSiteId(id));
}

export interface DestinationInput {
	organisation: string;
	plane: string;
	account: string;
	source: SourceSiteId;
	environment: string;
}

export interface DestinationKey {
	organisation: string;
	plane: string;
	account: string;
	source: string;
	environment: string;
}

export function destinationKey(input: DestinationInput): DestinationKey {
	return {
		organisation: input.organisation,
		plane: input.plane,
		account: input.account,
		source: sourceDigest(input.source),
		environment: input.environment
	};
}

/** the label a reader sees, plus a suffix that changes when any part of the key changes */
export function workerName(label: string, key: DestinationKey): string {
	return `${label}-${sha(canonical(key)).slice(0, 8)}`;
}

export function assertUniqueDestinations(keys: readonly DestinationKey[]): void {
	const seen = new Set<string>();
	for (const key of keys) {
		const text = canonical(key);
		if (seen.has(text)) {
			throw new UsageError(
				`destination ${key.organisation}/${key.plane}/${key.account}/${key.environment} is listed twice`
			);
		}
		seen.add(text);
	}
}

export type ReceiptState = 'sealed' | 'claimed' | 'verified';

const RECEIPT_STATES: readonly string[] = ['sealed', 'claimed', 'verified'];

export interface CapabilityFinding {
	capability: string;
	status: 'present' | 'absent' | 'unknown';
}

export interface DeploymentReceipt {
	origin: string;
	source: string;
	epoch: number;
	revision: string;
	state: ReceiptState;
	findings: CapabilityFinding[];
	/** ms since the epoch */
	expiresAt: number;
}

export function serializeDeploymentReceipt(receipt: DeploymentReceipt): string {
	return JSON.stringify(receipt);
}

export function parseDeploymentReceipt(text: string): DeploymentReceipt {
	const v = JSON.parse(text) as Partial<DeploymentReceipt>;
	const valid =
		typeof v.origin === 'string' &&
		typeof v.source === 'string' &&
		Number.isInteger(v.epoch) &&
		typeof v.revision === 'string' &&
		typeof v.state === 'string' &&
		RECEIPT_STATES.includes(v.state) &&
		Array.isArray(v.findings) &&
		typeof v.expiresAt === 'number';
	if (!valid) throw new UsageError('not a deployment receipt');
	return v as DeploymentReceipt;
}
