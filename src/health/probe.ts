import { ProbeError, UsageError } from '../errors';

/** The one network seam. Specs pass a function returning a `Response`; nothing else is stubbed. */
export type FetchLike = typeof fetch;

export type SiteKind = 'worker' | 'vps' | 'unknown';

export type Verdict = 'ok' | 'warming' | 'degraded' | 'unreachable' | 'not-drupflare';

/** how much load a site is shedding, and on which meter; `ops/degrade.ts` bands it */
export interface Degradation {
	/** `reduced` at 0.8 of a daily budget, `read-only` at 0.95 */
	level: string;
	/** the meter that drove it: rows written or DO requests */
	driver: string;
	/** how far into the budget, as a fraction */
	fraction: number | null;
}

/** `x-cfw-degrade*` off any response; absent headers mean the site is running normally */
export function readDegradation(cfw: Record<string, string>): Degradation | null {
	const level = cfw['x-cfw-degrade'];
	if (level === undefined || level === '') return null;
	const fraction = Number(cfw['x-cfw-degrade-at']);
	return {
		level,
		driver: cfw['x-cfw-degrade-driver'] ?? 'unknown',
		fraction: Number.isFinite(fraction) ? fraction : null
	};
}

/**
 * The `x-cfw-v` contract version this build reads.
 *
 * The worker bumps it only when a header is RENAMED or REMOVED, never when one is added, so a
 * higher number is the only signal that a field read by name here may have moved. Without it a
 * renamed header is indistinguishable from a header the response did not set.
 *
 * **v2 is `x-cfw-plan` losing its third meaning.** It carried an edge-plan provenance, a compiled
 * plan tier and the account's Workers plan, and the last of those moves to
 * `x-cfw-account-plan`. A v1 worker sends neither the new header nor the new version, so
 * {@link ProbeResult.accountPlan} reads null there and nothing else changes.
 */
export const KNOWN_HEADER_VERSION = 2;

export interface ProbeOptions {
	/** origin to probe, with or without a scheme; `https` is assumed */
	target: string;
	/** the Drupal path, which on a worker becomes `?path=` and on a VPS becomes the URL path */
	path?: string;
	/** worker site identity; null or absent lets the site resolve its own from the host */
	site?: string | null;
	kind?: 'auto' | 'worker' | 'vps';
	/** bypass the edge tier so the probe reaches the object; `/serve?edge=0` */
	skipEdge?: boolean;
	timeoutMs?: number;
	/** also try `/stats`, which is PW_DIAGNOSTICS-gated and normally answers 404 */
	diagnostics?: boolean;
}

export interface ProbeResult {
	target: string;
	requested: string;
	kind: SiteKind;
	verdict: Verdict;
	status: number | null;
	/** WALL CLOCK around the fetch, never cpuTime; RULE 0 forbids reading this as a CPU figure */
	wallMs: number;
	tier: string | null;
	edgeTier: string | null;
	generation: number | null;
	renderMs: number | null;
	serveMs: number | null;
	workerMs: number | null;
	phpBooted: boolean | null;
	queueDepth: number | null;
	/**
	 * `x-cfw-v`, the header contract version.
	 *
	 * Bumped by the worker only on a RENAME or a REMOVAL, never on an addition, so a version this
	 * probe does not know about means a header it reads by name may have moved. Null means a worker
	 * old enough to predate the marker, which is a different thing from a renamed contract.
	 */
	headerVersion: number | null;
	/**
	 * `x-cfw-plan`, which is the EDGE-PLAN verdict and never the account's Workers plan.
	 *
	 * The worker sets it in three places with two meanings: a provenance when a compiled plan
	 * answered, and a tier string such as `skip:set-cookie` saying why one did not. drangler used to
	 * map it to a field called `plan` and print it in a row labelled `plan`, so a site whose plan
	 * tier read `skip:set-cookie` reported that as its billing plan. Null when a cache tier answered,
	 * because those responses carry no such header.
	 */
	planTier: string | null;
	/**
	 * `x-cfw-account-plan`: `free` or `paid`, read from the Worker's own `PLAN` binding.
	 *
	 * Null on a worker at contract v1, which sent the account plan on `x-cfw-plan` and therefore
	 * cannot be distinguished from a plan tier. Unknown is the honest reading there, not `free`.
	 */
	accountPlan: string | null;
	/**
	 * `x-cfw-degrade`, `x-cfw-degrade-driver` and `x-cfw-degrade-at`.
	 *
	 * Null when the site is running normally, because the worker sets none of the three off
	 * `normal`. A site in `read-only` answers 503 to every non-GET, so a verdict that read that as a
	 * plain failure would report an outage where the object is deliberately shedding load; the
	 * driver names which meter it is shedding on.
	 */
	degraded: Degradation | null;
	/** whichever Drupal cache headers a plain host sets, when probing a VPS */
	drupalCache: string | null;
	drupalDynamicCache: string | null;
	generator: string | null;
	/** 'off' when not asked for, 'gated' on a 404, 'open' when the route answered */
	diagnostics: 'off' | 'gated' | 'open';
	/** every `x-cfw-*` header verbatim, because those headers ARE the measurement */
	cfw: Record<string, string>;
	notes: string[];
}

/** Normalises `example.com`, `https://example.com/` and `https://example.com/sub/` to an origin. */
export function normaliseTarget(target: string): string {
	const raw = target.trim();
	if (raw === '') throw new UsageError('a target host or URL is required');
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new UsageError(`not a URL: ${target}`);
	}
	if (url.hostname === '') throw new UsageError(`not a URL: ${target}`);
	return url.origin + url.pathname.replace(/\/+$/, '');
}

/** `/stats`, which is PW_DIAGNOSTICS-gated; a probe reads its status rather than its body */
function statsUrl(origin: string, site: string | null): string {
	const url = new URL(`${origin}/stats`);
	if (site !== null && site !== '') url.searchParams.set('site', site);
	return url.toString();
}

/**
 * The URL a worker probe issues: the public `/serve` route, never a diagnostic one.
 *
 * A null site is the normal case; see {@link OwnerTarget.site} for why naming one drangler invented
 * splits a claim from the owner calls after it.
 */
export function serveUrl(
	origin: string,
	path: string,
	site: string | null,
	skipEdge: boolean
): string {
	const url = new URL(`${origin}/serve`);
	url.searchParams.set('path', path);
	if (site !== null && site !== '') url.searchParams.set('site', site);
	if (skipEdge) url.searchParams.set('edge', '0');
	return url.toString();
}

function num(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** Collects every `x-cfw-*` header, which is how a worker reports what tier answered and why. */
export function collectCfw(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		if (name.toLowerCase().startsWith('x-cfw-')) out[name.toLowerCase()] = value;
	});
	return out;
}

/**
 * Classifies a response.
 *
 * `warming` is its own verdict rather than a failure: a 503 from the fill queue means the object took
 * the request and refused to gamble a visitor on a cold render, which is the designed behaviour and
 * not an outage. Reporting it as `degraded` would train a user to ignore the one verdict that means
 * the site is actually broken.
 *
 * `x-cfw-migrate` is the same verdict for a different reason and was MISSING, which made the first
 * command a user runs after a deploy report a healthy site as broken. A fresh Durable Object replays
 * its database in chunks and answers 503 with that header until the cursor is done; the response
 * carries neither `x-cfw-queued` nor `x-cfw-cache`, so it fell through to the 5xx branch for the
 * whole of the normal first-deploy window.
 */
export function classify(status: number, cfw: Record<string, string>, kind: SiteKind): Verdict {
	if (kind === 'worker' && Object.keys(cfw).length === 0) return 'not-drupflare';
	if (
		status === 503 &&
		(cfw['x-cfw-queued'] === '1' ||
			cfw['x-cfw-cache'] === 'MISS' ||
			cfw['x-cfw-migrate'] !== undefined)
	) {
		return 'warming';
	}
	// a site off `normal` is shedding load on purpose and says which meter drove it. Reading its
	// 503 as a plain failure reports an outage where the object is refusing writes by design, and
	// the header is on every response it sends off `normal`
	if (cfw['x-cfw-degrade'] !== undefined && cfw['x-cfw-degrade'] !== '') return 'degraded';
	if (status >= 500) return 'degraded';
	if (status >= 400) return 'degraded';
	return 'ok';
}

function emptyResult(target: string, requested: string, kind: SiteKind): ProbeResult {
	return {
		target,
		requested,
		kind,
		verdict: 'unreachable',
		status: null,
		wallMs: 0,
		tier: null,
		edgeTier: null,
		generation: null,
		renderMs: null,
		serveMs: null,
		workerMs: null,
		phpBooted: null,
		queueDepth: null,
		headerVersion: null,
		planTier: null,
		accountPlan: null,
		degraded: null,
		drupalCache: null,
		drupalDynamicCache: null,
		generator: null,
		diagnostics: 'off',
		cfw: {},
		notes: []
	};
}

export interface ProbeDeps {
	fetch: FetchLike;
	now?: () => number;
}

async function get(
	deps: ProbeDeps,
	url: string,
	timeoutMs: number
): Promise<{ response: Response; wallMs: number }> {
	const now = deps.now ?? Date.now;
	const t0 = now();
	try {
		const response = await deps.fetch(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs)
		});
		return { response, wallMs: now() - t0 };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		throw new ProbeError(`${url}: ${reason}`);
	}
}

/**
 * Probes one site and reports what answered.
 *
 * `auto` issues the worker probe first and falls back to the plain path only when the origin returns
 * no `x-cfw-*` header at all -- a drupflare worker sets them on every `/serve` response including its
 * refusals, so their absence is the discriminator and the status code is not.
 */
export async function probeSite(deps: ProbeDeps, opts: ProbeOptions): Promise<ProbeResult> {
	const origin = normaliseTarget(opts.target);
	const path = opts.path ?? '/';
	const site = opts.site ?? null;
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const wanted = opts.kind ?? 'auto';

	if (wanted === 'vps') return await probeVps(deps, origin, path, timeoutMs);

	const url = serveUrl(origin, path, site, opts.skipEdge ?? false);
	const { response, wallMs } = await get(deps, url, timeoutMs);
	const cfw = collectCfw(response.headers);

	if (Object.keys(cfw).length === 0 && wanted === 'auto') {
		const fallback = await probeVps(deps, origin, path, timeoutMs);
		fallback.notes.push(
			`no x-cfw-* headers on ${url}; re-probed as a plain Drupal host at the same origin`
		);
		return fallback;
	}

	const result: ProbeResult = {
		...emptyResult(origin, url, 'worker'),
		status: response.status,
		wallMs,
		cfw,
		tier: response.headers.get('x-cfw-cache'),
		edgeTier: response.headers.get('x-cfw-edge'),
		generation: num(response.headers, 'x-cfw-generation'),
		renderMs: num(response.headers, 'x-cfw-render-ms'),
		serveMs: num(response.headers, 'x-cfw-serve-ms'),
		workerMs: num(response.headers, 'x-worker-ms'),
		phpBooted:
			response.headers.get('x-cfw-php-booted') === null
				? null
				: response.headers.get('x-cfw-php-booted') === '1',
		queueDepth: num(response.headers, 'x-cfw-queue-depth'),
		headerVersion: num(response.headers, 'x-cfw-v'),
		planTier: response.headers.get('x-cfw-plan'),
		accountPlan: response.headers.get('x-cfw-account-plan'),
		generator: response.headers.get('x-generator'),
		degraded: readDegradation(cfw),
		verdict: classify(response.status, cfw, 'worker')
	};

	if (result.verdict === 'not-drupflare') {
		result.notes.push(
			'no x-cfw-* headers: this origin answered /serve but is not a drupflare worker'
		);
	}
	if (result.tier === 'EDGE') {
		result.notes.push(
			'answered by the edge cache; re-run with --skip-edge to reach the object'
		);
	}
	if (result.phpBooted === false && result.tier !== 'EDGE') {
		result.notes.push('the object has no interpreter booted; a MISS here pays a cold boot');
	}
	if (cfw['x-cfw-migrate'] !== undefined) {
		// the header's own value, never a duration: how long a replay takes is measured in the
		// worker repository and would be a figure this CLI could only copy and let rot
		result.notes.push(
			`replaying the database, chunk ${cfw['x-cfw-migrate']} (${cfw['x-cfw-migrate-state'] ?? 'unknown'}); a fresh site does this once, and a 503 until it finishes is expected`
		);
	}
	if (result.degraded !== null) {
		result.notes.push(
			`shedding load at the ${result.degraded.level} level, driven by ${result.degraded.driver} at ${result.degraded.fraction ?? '?'} of its daily budget; it clears at the UTC reset`
		);
	}
	if (result.headerVersion === null) {
		result.notes.push(
			'no x-cfw-v: this worker predates the header contract marker, so a field reported as `-` may be a rename rather than an absence'
		);
	} else if (result.headerVersion > KNOWN_HEADER_VERSION) {
		result.notes.push(
			`x-cfw-v is ${result.headerVersion} and this drangler knows ${KNOWN_HEADER_VERSION}; the version bumps only on a rename or a removal, so a field reported as \`-\` is probably a header that moved`
		);
	}

	if (opts.diagnostics) {
		const stats = await get(deps, statsUrl(origin, site), timeoutMs);
		result.diagnostics = stats.response.status === 404 ? 'gated' : 'open';
		if (result.diagnostics === 'open') {
			result.notes.push(
				'/stats answered: PW_DIAGNOSTICS is set on this deployment, which exposes /sql and /restore'
			);
		}
	}
	return result;
}

/** Whether the site has an administrator password yet, and therefore whether anyone else can set one. */
export type ClaimState = 'claimed' | 'unclaimed' | 'unknown';

export interface ClaimReport {
	state: ClaimState;
	/** when the claim happened, as the site reports it; null on an unclaimed or older site */
	firstRunAt: number | null;
}

/**
 * Asks whether anybody has claimed this site.
 *
 * The pack ships an INSTALLED database, so Drupal's `install.php` never runs and uid 1 carries an
 * empty hash that no password matches until `/firstrun` mints one. The claim window is exactly that
 * state, and it is open to whoever reaches the URL first -- which makes "has this been claimed" a
 * question worth one extra request on the command whose job is reporting what is deployed.
 *
 * A bare `GET /firstrun` reports without configuring and is public, so no credential is spent.
 *
 * **Never throws.** A worker predating the route, an origin that is not drupflare and a network
 * failure are all `unknown`: "I could not tell" is a different report from "nobody has claimed it",
 * and reporting the second for the first would send a user to reclaim a site they already own.
 */
export async function probeClaim(
	deps: ProbeDeps,
	origin: string,
	site: string | null,
	timeoutMs: number
): Promise<ClaimReport> {
	const url = new URL(`${origin}/firstrun`);
	if (site !== null && site !== '') url.searchParams.set('site', site);
	let body: unknown;
	try {
		const { response } = await get(deps, url.toString(), timeoutMs);
		if (!response.ok) return { state: 'unknown', firstRunAt: null };
		body = await response.json();
	} catch {
		return { state: 'unknown', firstRunAt: null };
	}
	const parsed = body as { ok?: unknown; configured?: unknown; firstRunAt?: unknown };
	if (parsed?.ok !== true || typeof parsed.configured !== 'boolean') {
		return { state: 'unknown', firstRunAt: null };
	}
	return {
		state: parsed.configured ? 'claimed' : 'unclaimed',
		firstRunAt: typeof parsed.firstRunAt === 'number' ? parsed.firstRunAt : null
	};
}

/**
 * Probes a plain Drupal host: no `/serve`, no worker headers.
 *
 * Exists so the same command can answer "is the site I am migrating away from healthy" and "is the
 * site I migrated to healthy" -- an off-boarding user needs both numbers side by side, and a probe
 * that only understood the worker would make the comparison by hand.
 */
export async function probeVps(
	deps: ProbeDeps,
	origin: string,
	path: string,
	timeoutMs: number
): Promise<ProbeResult> {
	const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`;
	const { response, wallMs } = await get(deps, url, timeoutMs);
	const generator = response.headers.get('x-generator');
	const drupalCache = response.headers.get('x-drupal-cache');
	const drupalDynamicCache = response.headers.get('x-drupal-dynamic-cache');

	const result: ProbeResult = {
		...emptyResult(origin, url, 'vps'),
		status: response.status,
		wallMs,
		drupalCache,
		drupalDynamicCache,
		generator,
		verdict: classify(response.status, {}, 'vps')
	};
	if (generator === null && drupalCache === null && drupalDynamicCache === null) {
		result.kind = 'unknown';
		result.notes.push(
			'no x-generator and no x-drupal-cache header: cannot confirm this is Drupal'
		);
	}
	return result;
}
