import {
	CapabilityError,
	fromFiles,
	planFork,
	type Binding,
	type Capability,
	type ModuleSet,
	type WorkerSummary
} from '@drupflare/workforce';
import { target, type CloudflareTarget } from '../cloudflare/client';
import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import type { JsonOption } from './cf';

export interface WorkerOptions extends JsonOption {
	account?: string;
}

/** Reads a built Worker off disk through the file seam, so no command reaches the filesystem itself. */
export function readModules(ctx: Context, dir: string): ModuleSet {
	if (!ctx.files.exists(dir)) throw new UsageError(`no directory at ${dir}`);
	const files: Record<string, Uint8Array> = {};
	const walk = (path: string, prefix: string): void => {
		for (const entry of ctx.files.readDir(path)) {
			const full = `${path}/${entry.name}`;
			const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.directory) walk(full, name);
			else files[name] = ctx.files.readBytes(full);
		}
	};
	walk(dir, '');
	if (Object.keys(files).length === 0) throw new UsageError(`${dir} holds no files to upload`);
	return fromFiles(files);
}

export interface DeployOptions extends WorkerOptions {
	directory?: string;
	compatibilityDate?: string;
}

/** Uploads a built Worker. The upload is the whole module set; anything absent from it is gone. */
export async function runDeploy(ctx: Context, worker: string, opts: DeployOptions): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const source = readModules(ctx, opts.directory ?? 'dist');
	const result = await t.client.worker(worker).upload({
		source,
		metadata: {
			compatibility_date: opts.compatibilityDate ?? '2026-08-01'
		}
	});
	emit(ctx.io, opts.json === true, { worker, ...result }, () =>
		kv([
			['worker', worker],
			['account', t.account],
			['modules', String(source.size)],
			['version', result.versionId ?? '-'],
			['etag', result.etag ?? '-']
		])
	);
}

export async function runDelete(ctx: Context, worker: string, opts: WorkerOptions): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const handle = t.client.worker(worker);
	if (!(await handle.exists())) {
		throw new UsageError(`no worker named \`${worker}\` on account ${t.account}`);
	}
	await handle.delete();
	emit(ctx.io, opts.json === true, { worker, deleted: true }, () => [
		`deleted ${worker} from account ${t.account}`
	]);
}

export async function runSettings(
	ctx: Context,
	worker: string,
	opts: WorkerOptions
): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const settings = await t.client.worker(worker).settings();
	emit(ctx.io, opts.json === true, settings, () => [
		...kv([
			['worker', worker],
			['compatibility date', settings.compatibilityDate ?? '-'],
			['compatibility flags', settings.compatibilityFlags.join(', ') || '-'],
			['tags', settings.tags.join(', ') || '-'],
			['logpush', settings.logpush === null ? '-' : settings.logpush ? 'on' : 'off']
		]),
		'',
		...bindingLines(settings.bindings)
	]);
}

function bindingLines(bindings: readonly Binding[]): string[] {
	if (bindings.length === 0) return ['no bindings'];
	return table(
		['name', 'type'],
		bindings.map((b) => [b.name, b.type])
	);
}

export async function runBindings(
	ctx: Context,
	worker: string,
	opts: WorkerOptions
): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const settings = await t.client.worker(worker).settings();
	emit(ctx.io, opts.json === true, settings.bindings, () => bindingLines(settings.bindings));
}

export interface SecretOptions extends WorkerOptions {
	value?: string;
}

/** Lists, sets or removes one secret. The API never returns a value, so neither does this. */
export async function runSecret(
	ctx: Context,
	worker: string,
	action: string,
	name: string | undefined,
	opts: SecretOptions
): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const secrets = t.client.worker(worker).secrets;

	if (action === 'list') {
		const found = await secrets.list();
		emit(ctx.io, opts.json === true, found, () =>
			found.length === 0
				? ['no secrets']
				: table(
						['name', 'type'],
						found.map((s) => [s.name, s.type])
					)
		);
		return;
	}
	if (name === undefined) throw new UsageError(`\`cf secret ${action}\` needs a name`);

	if (action === 'put') {
		const value = opts.value ?? (await ctx.ask(`value for ${name}:`));
		if (value === null) {
			throw new UsageError(
				`no value for ${name}; pass --value, since there was nobody to ask`
			);
		}
		await secrets.put(name, value);
		emit(ctx.io, opts.json === true, { worker, name, set: true }, () => [
			`set ${name} on ${worker}`
		]);
		return;
	}
	if (action === 'delete') {
		await secrets.delete(name);
		emit(ctx.io, opts.json === true, { worker, name, deleted: true }, () => [
			`removed ${name} from ${worker}`
		]);
		return;
	}
	throw new UsageError(`\`cf secret\` takes list, put or delete, not \`${action}\``);
}

export interface AssetsOptions extends WorkerOptions {
	directory?: string;
}

/**
 * Uploads a whole asset tree.
 *
 * There is no partial form. A manifest that omits a path carries it forward rather than deleting it,
 * so a tree is the only shape that can express a removal.
 */
export async function runAssets(ctx: Context, worker: string, opts: AssetsOptions): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const tree = readModules(ctx, opts.directory ?? 'public');
	const result = await t.client.worker(worker).assets.sync(tree);
	emit(ctx.io, opts.json === true, result, () =>
		kv([
			['worker', worker],
			['files', String(tree.size)],
			['uploaded', String(result.uploaded)],
			['token', result.completionToken === null ? '-' : 'issued']
		])
	);
}

export async function runVersions(
	ctx: Context,
	worker: string,
	opts: WorkerOptions
): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const versions = await versionsOf(t, worker).list();
	emit(ctx.io, opts.json === true, versions, () =>
		versions.length === 0
			? ['no versions']
			: table(
					['id', 'created', 'message'],
					versions.map((v) => [v.id, v.createdOn ?? '-', v.message ?? '-'])
				)
	);
}

export async function runRollback(
	ctx: Context,
	worker: string,
	version: string,
	opts: WorkerOptions
): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	await versionsOf(t, worker).rollback(version);
	emit(ctx.io, opts.json === true, { worker, version, rolledBack: true }, () => [
		`${worker} now serves ${version}`,
		'rollback re-points the deployment; it creates no new version'
	]);
}

function versionsOf(t: CloudflareTarget, worker: string) {
	try {
		return t.client.worker(worker).versions;
	} catch (e) {
		if (e instanceof CapabilityError) throw new FindingError('capability', e.message);
		throw e;
	}
}

export interface ForkOptions extends WorkerOptions {
	durableObjects?: string;
	directory?: string;
}

const DO_MODES = ['fresh', 'shared', 'transfer'];

export async function runFork(
	ctx: Context,
	source: string,
	destination: string,
	opts: ForkOptions
): Promise<void> {
	const mode = opts.durableObjects ?? 'fresh';
	if (!DO_MODES.includes(mode)) {
		throw new UsageError(`--durable-objects must be one of ${DO_MODES.join(', ')}`);
	}
	if (mode === 'transfer') {
		throw new UsageError(
			'`transfer` moves a Durable Object namespace and its data between Workers, which is not reversible; run it from the library with the confirmation flag'
		);
	}
	const t = await target(ctx, opts.account ?? null);
	const modules = readModules(ctx, opts.directory ?? 'dist');
	const settings = await t.client.worker(source).settings();
	const names = (await t.client.worker(source).secrets.list()).map((s) => s.name);
	const plan = planFork(
		{
			source,
			target: destination,
			modules,
			durableObjects: mode as 'fresh' | 'shared',
			metadata: {
				...(settings.compatibilityDate === null
					? {}
					: { compatibility_date: settings.compatibilityDate }),
				compatibility_flags: settings.compatibilityFlags,
				bindings: settings.bindings
			}
		},
		names
	);
	await t.client.plane.upload(destination, plan.upload);
	emit(ctx.io, opts.json === true, { ...plan, upload: undefined }, () =>
		kv([
			['from', source],
			['to', destination],
			['durable objects', plan.durableObjects],
			['modules', String(modules.size)],
			[
				'secrets not carried',
				plan.secretsNotCarried.join(', ') || 'none; the source had none'
			]
		])
	);
}

/** What this plane can and cannot do, with the reason attached to each refusal. */
export async function runPlane(ctx: Context, opts: WorkerOptions): Promise<void> {
	const t = await target(ctx, opts.account ?? null);
	const caps = t.client.capabilities;
	// maxTags sits alongside the capabilities as a number, so it is reported rather than tabulated
	const rows = Object.entries(caps)
		.filter((entry): entry is [string, Capability] => isCapability(entry[1]))
		.map(([name, c]) => [name, c.supported ? 'yes' : 'no', c.supported ? '' : c.reason]);
	emit(ctx.io, opts.json === true, { plane: t.client.plane.kind, capabilities: caps }, () => [
		...kv([
			['plane', t.client.plane.kind],
			['target', t.client.plane.target],
			['max tags', caps.maxTags === null ? 'no cap' : String(caps.maxTags)]
		]),
		'',
		...table(['capability', 'supported', 'reason'], rows)
	]);
}

function isCapability(value: unknown): value is Capability {
	return typeof value === 'object' && value !== null && 'supported' in value;
}

export function summaryLines(workers: readonly WorkerSummary[]): string[] {
	return table(
		['name', 'modified', 'tags'],
		workers.map((w) => [w.name, w.modifiedOn ?? '-', w.tags.join(', ') || '-'])
	);
}
