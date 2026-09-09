import { UsageError } from '../errors';
import type { Severity } from '../migrate/rules';
import type { WorkersPlan } from './api';

export interface ConfigFinding {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
}

/**
 * Strips `//` and block comments from JSONC, leaving string contents alone.
 *
 * A regex would eat the `//` in every `https://` in the file, and wrangler configs are full of them.
 */
export function stripJsonComments(text: string): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i] as string;
		if (ch === '"') {
			out += ch;
			i++;
			while (i < text.length) {
				const c = text[i] as string;
				out += c;
				i++;
				if (c === '\\') {
					if (i < text.length) {
						out += text[i] as string;
						i++;
					}
					continue;
				}
				if (c === '"') break;
			}
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		out += ch;
		i++;
	}
	// a trailing comma left by a stripped comment line is legal jsonc and not legal json
	return out.replace(/,(\s*[}\]])/g, '$1');
}

export interface WranglerConfig {
	name?: unknown;
	main?: unknown;
	compatibility_date?: unknown;
	compatibility_flags?: unknown;
	vars?: Record<string, unknown>;
	alias?: Record<string, unknown>;
	assets?: { directory?: unknown; binding?: unknown };
	durable_objects?: { bindings?: { name?: unknown; class_name?: unknown }[] };
	migrations?: { tag?: unknown; new_classes?: unknown; new_sqlite_classes?: unknown }[];
	triggers?: { crons?: unknown };
}

export function parseWranglerConfig(text: string): WranglerConfig {
	try {
		const parsed = JSON.parse(stripJsonComments(text)) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('not an object');
		}
		return parsed as WranglerConfig;
	} catch (e) {
		throw new UsageError(
			`not a wrangler config: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

/** The interpreter alias `drupflare/worker` needs; the extension in the key is load-bearing there. */
export const PHP_BINARY_ALIAS = './runtime/php-binary.js';

/**
 * Checks a wrangler config against the failures this project has actually shipped.
 *
 * Not a schema validator -- wrangler has one, and duplicating it would go stale on the next release.
 * Every rule here is a deployment that went out wrong: diagnostics public by default, a Durable Object
 * migrated without SQLite, and the interpreter alias resolving to the fallback binary with nothing
 * failing but the size.
 */
export interface AccountFacts {
	/**
	 * What the account is really entitled to.
	 *
	 * Supplied by the caller rather than read here, because this function is pure and because the
	 * lookup needs a Cloudflare token that a config check should not require.
	 */
	workersPlan?: WorkersPlan;
}

/**
 * The `PLAN` var against the account it will run on.
 *
 * This check lives here rather than in the worker because the worker cannot make it: a Worker has
 * no way to ask which plan its own account is on, so `PLAN` is a config var somebody sets by hand
 * and nothing verifies. A wrong value is silent in both directions -- `free` on a paid account
 * turns on degradations nobody is paying to need, and `paid` on a free one disables the very
 * budgeting that keeps the site inside the daily quotas.
 *
 * An `unknown` reading is reported as a note, never as a pass: a check that could not be made must
 * not look like one that succeeded.
 */
function planFinding(config: WranglerConfig, facts: AccountFacts): ConfigFinding | null {
	const declared = config.vars?.['PLAN'];
	const stated = typeof declared === 'string' ? declared.toLowerCase() : null;
	const actual = facts.workersPlan;
	if (actual === undefined) return null;
	if (actual === 'unknown') {
		return {
			id: 'plan-unknown',
			severity: 'note',
			title: 'the account plan could not be read',
			detail: `\`PLAN\` says \`${stated ?? 'unset'}\` and the subscription list carried no Workers rate plan to compare it against, so this was not checked rather than passed`
		};
	}
	if (stated === null) {
		return {
			id: 'plan-unset',
			severity: 'warning',
			title: `no \`PLAN\` var, and the account is on the ${actual} plan`,
			detail: 'the worker reads `PLAN` to decide whether to spend the paid tiers; unset, it takes the free path on an account that may be paying for more'
		};
	}
	if (stated === actual) return null;
	return {
		id: 'plan-mismatch',
		severity: 'warning',
		title: `\`PLAN\` says \`${stated}\` and the account is on the ${actual} plan`,
		detail:
			actual === 'paid'
				? 'the worker will take the free path -- skipping the KV page tier and budgeting authenticated renders -- on an account already paying for neither limit to apply'
				: 'the worker will take the paid path on a free account, so the daily Worker-request and rows-written quotas stop being budgeted for and the site fails when they run out'
	};
}

export function checkConfig(config: WranglerConfig, facts: AccountFacts = {}): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const push = (id: string, severity: Severity, title: string, detail: string) =>
		findings.push({ id, severity, title, detail });

	if (typeof config.main !== 'string' || config.main === '') {
		push('main', 'blocker', 'no `main`', 'wrangler has no entrypoint to bundle');
	}
	if (typeof config.compatibility_date !== 'string') {
		push(
			'compatibility-date',
			'blocker',
			'no `compatibility_date`',
			'the runtime picks its own, so the deployed behaviour changes without a diff'
		);
	}

	const flags = Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [];
	if (!flags.includes('nodejs_compat')) {
		push(
			'nodejs-compat',
			'warning',
			'no `nodejs_compat` flag',
			'the Drupal pack reader and the interpreter shim import node builtins; without the flag the bundle fails at module scope'
		);
	}

	if (config.vars?.['PW_DIAGNOSTICS'] === '1' || config.vars?.['PW_DIAGNOSTICS'] === 1) {
		push(
			'diagnostics-public',
			'blocker',
			'`PW_DIAGNOSTICS` is 1 in `vars`',
			'that opens /sql, /restore, /pitr and /php to anyone on the internet; the diagnostic routes fail closed for a reason and this reopens all of them. /firstrun is public and /export takes a per-site owner token, so neither is what the flag is for'
		);
	}

	const bindings = config.durable_objects?.bindings ?? [];
	const classes = bindings.map((b) => String(b.class_name ?? '')).filter((c) => c !== '');
	if (classes.length === 0) {
		push(
			'do-binding',
			'warning',
			'no Durable Object binding',
			'a drupflare site keeps its interpreter and its database in one object; without the binding there is nothing to serve from'
		);
	} else {
		const sqlite = new Set<string>();
		const plain = new Set<string>();
		for (const migration of config.migrations ?? []) {
			for (const c of asStrings(migration.new_sqlite_classes)) sqlite.add(c);
			for (const c of asStrings(migration.new_classes)) plain.add(c);
		}
		for (const c of classes) {
			if (sqlite.has(c)) continue;
			if (plain.has(c)) {
				push(
					'do-not-sqlite',
					'blocker',
					`\`${c}\` was migrated with \`new_classes\``,
					'that object gets the key-value backend, not SQLite; `ctx.storage.sql` is absent at runtime and the migration cannot be changed after the fact'
				);
				continue;
			}
			push(
				'do-unmigrated',
				'warning',
				`\`${c}\` has no migration`,
				'a Durable Object class needs a migration tag before it can be deployed'
			);
		}
	}

	const alias = config.alias ?? {};
	if (typeof config.main === 'string' && /site\.ts$/.test(config.main)) {
		if (alias[PHP_BINARY_ALIAS] === undefined) {
			push(
				'interpreter-alias',
				'warning',
				`no alias for \`${PHP_BINARY_ALIAS}\``,
				'the default seam bundles the fallback interpreter rather than the one the checkout built, so the deployed site runs a PHP nothing in this tree selected; nothing fails but the size'
			);
		}
		if (config.assets?.directory === undefined) {
			push(
				'assets',
				'warning',
				'no `assets.directory`',
				'the Drupal tree ships on the asset layer; without it the object has no site to mount'
			);
		}
	}

	if (config.triggers?.crons === undefined) {
		push(
			'cron',
			'note',
			'no Cron Trigger',
			'the fill window is what amortises a boot across a queue drain; without it every regeneration pays its own cold start'
		);
	}

	const plan = planFinding(config, facts);
	if (plan !== null) findings.push(plan);

	return findings;
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** one optional worker lever, as drangler reads it out of a config */
export interface Lever {
	name: string;
	describe: string;
	/** what the site does when nothing sets it */
	unset: string;
	/** what a declared value means, in the site's terms */
	state(value: string): string;
}

/** `SWEEP_MIN_FRACTION` and `SWEEP_MAX_FRACTION` in `ops/sweep.ts`; the site clamps to this range */
export const SWEEP_FRACTION_MIN = 0.01;
export const SWEEP_FRACTION_MAX = 0.5;

/**
 * The levers drangler has a command or a check for.
 *
 * Deliberately short. `worker/docs/configuration.md` documents every var the site reads, and a
 * second list of all of them here would be a copy that goes stale on the next one the worker adds.
 * A lever earns a row when something in drangler acts on it: `FILES_PUBLIC_URL` has a reachability
 * check, `SWEEP` and `SWEEP_ROWS_FRACTION` drive `drangler sweep`, and `ASSET_AGGREGATES` needs a
 * build artifact whose absence makes the lever inert.
 */
export const LEVERS: readonly Lever[] = [
	{
		name: 'FILES_PUBLIC_URL',
		describe: 'origin a mirrored public file is linked from',
		unset: 'every file is served through the Worker, at one Worker request each',
		state: (value) => `mirrored public files are linked at ${value}`
	},
	{
		name: 'ASSET_AGGREGATES',
		describe: "substitute the build's CSS and JS aggregates into a stored page",
		unset: 'a stored page keeps the tags Drupal emitted',
		state: (value) =>
			value === '1'
				? 'on; needs `bun run assets:agg` to have written assets/agg/'
				: `off; only \`1\` turns it on, and this says \`${value}\``
	},
	{
		name: 'SWEEP',
		describe: 'enumerate the addressable space and queue what has no stored page',
		unset: 'coverage stays demand-driven, so the first visitor to a URL waits for its render',
		state: (value) => (value === '0' ? 'off; `0` is the one value that switches it off' : 'on')
	},
	{
		name: 'SWEEP_ROWS_FRACTION',
		describe: "share of the day's rows and DO requests one sweep may spend",
		unset: '0.25 of each daily meter',
		state: (value) => {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0)
				return `unreadable as a number, so the site uses 0.25`;
			if (n < SWEEP_FRACTION_MIN) return `${value}, clamped up to ${SWEEP_FRACTION_MIN}`;
			if (n > SWEEP_FRACTION_MAX) return `${value}, clamped down to ${SWEEP_FRACTION_MAX}`;
			return `${n} of each daily meter`;
		}
	}
];

export interface LeverReading {
	name: string;
	/** what the config declares, or null when nothing does */
	value: string | null;
	/** the real state, which for an unset lever is what the site does without it */
	state: string;
	describe: string;
}

/** Reads each lever out of a config. An unset lever reports what the site does without it. */
export function readLevers(config: WranglerConfig): LeverReading[] {
	return LEVERS.map((lever) => {
		const raw = config.vars?.[lever.name];
		const value = raw === undefined || raw === null || String(raw) === '' ? null : String(raw);
		return {
			name: lever.name,
			value,
			state: value === null ? lever.unset : lever.state(value),
			describe: lever.describe
		};
	});
}

/** every other `vars` entry, echoed as declared; a credential is reported as set and never printed */
export function otherVars(config: WranglerConfig): { name: string; value: string }[] {
	const named = new Set(LEVERS.map((l) => l.name));
	return Object.entries(config.vars ?? {})
		.filter(([name]) => !named.has(name))
		.map(([name, value]) => ({
			name,
			value: /pass|secret|token|key/i.test(name) ? 'set' : String(value)
		}))
		.sort((a, b) => (a.name < b.name ? -1 : 1));
}
