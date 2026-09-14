import type { Context } from '../context';
import { DranglerError } from '../errors';
import { ownerCall, replyError, type OwnerReply, type OwnerTarget } from '../owner';
import { MAX_BODY_BYTES, type DetectedPackage, type PackageSelection } from './detect';

/** one file's bytes, under the hash the site will re-compute before it stores them */
export interface BlobEntry {
	hash: string;
	source: string;
}

/** a file as the client declares it, before its bytes have been sent */
export interface DeclaredFile {
	path: string;
	hash: string;
	bytes: number;
}

/** what the site already holds against what it still has to be sent */
export interface UploadPlan {
	have: string[];
	want: string[];
	wantBytes: number;
	counts: Record<string, number>;
	rowsWritten: number;
}

export interface UploadResult {
	package: string;
	mount: string;
	files: number;
	plan: UploadPlan;
	/** how many requests the blobs were split across */
	batches: number;
	stored: number;
	skipped: number;
	bytes: number;
	rev: string | null;
	applied: boolean;
	rolledBack: boolean;
	counts: Record<string, number>;
	changes: { path: string; kind: string; added?: number; removed?: number }[];
	error: string | null;
	notes: string[];
}

/** room left for the `{"blobs":[...]}` envelope and the commas between entries */
const ENVELOPE_BYTES = 1_024;

/**
 * Splits blobs into requests that fit the edge's body limit.
 *
 * The budget is measured on the ENCODED entry rather than on the file's byte count, because a
 * source full of quotes and newlines grows when it is JSON-encoded and a batch planned against the
 * raw size would be refused by the route that was meant to accept it.
 *
 * A single blob larger than the whole budget still gets its own request: `check` reports it as a
 * finding, and sending it alone is what makes the refusal come from the site with a reason rather
 * than from here with an empty batch.
 */
export function planBatches(
	blobs: readonly BlobEntry[],
	maxBodyBytes: number = MAX_BODY_BYTES
): BlobEntry[][] {
	const budget = Math.max(1, maxBodyBytes - ENVELOPE_BYTES);
	const batches: BlobEntry[][] = [];
	let current: BlobEntry[] = [];
	let size = 0;
	for (const blob of blobs) {
		const encoded = JSON.stringify(blob).length + 1;
		if (current.length > 0 && size + encoded > budget) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(blob);
		size += encoded;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export interface UploadOptions {
	/** the revision label, which is free text a person reads in `modify revisions` */
	label: string;
	/** a local path, a git sha or a tag; recorded on the revision */
	origin: string;
	dryRun?: boolean;
	/** how many blobs may go in one request, for a spec that wants two batches out of four files */
	maxBodyBytes?: number;
}

/**
 * Declare, send what the site is missing, commit.
 *
 * The negotiation is the whole reason an upload is not the entire module every time: a one-file
 * edit sends one file, and the plan step costs one DO request and writes nothing.
 *
 * `commit` applies immediately. The route has no store-without-activating mode, so there is no
 * `--no-activate` here either; `activate` against an earlier revision is how a live tree goes back.
 */
export async function uploadPackage(
	ctx: Context,
	owner: OwnerTarget,
	pkg: DetectedPackage,
	selection: PackageSelection,
	opts: UploadOptions
): Promise<UploadResult> {
	const declared = await declare(selection);
	const result: UploadResult = {
		package: pkg.name,
		mount: pkg.mount,
		files: declared.length,
		plan: { have: [], want: [], wantBytes: 0, counts: {}, rowsWritten: 0 },
		batches: 0,
		stored: 0,
		skipped: 0,
		bytes: 0,
		rev: null,
		applied: false,
		rolledBack: false,
		counts: {},
		changes: [],
		error: null,
		notes: []
	};
	if (declared.length === 0) {
		throw new DranglerError(
			'modify',
			`${pkg.name} has no mountable file, and a revision with no files would unmount the package`
		);
	}

	const planned = await ownerCall(ctx, owner, '/modify', {
		method: 'POST',
		params: { action: 'plan', package: pkg.name },
		body: { files: declared }
	});
	if (planned.status >= 400) {
		result.error = replyError(planned, 'the site refused the plan');
		return result;
	}
	result.plan = readPlan(planned);

	const wanted = new Set(result.plan.want);
	const outgoing = selection.files
		.map((file, index) => ({
			hash: (declared[index] as DeclaredFile).hash,
			source: file.source
		}))
		.filter((blob) => wanted.has(blob.hash));
	const batches = planBatches(outgoing, opts.maxBodyBytes);
	result.batches = batches.length;

	if (opts.dryRun === true) {
		result.notes.push('dry run: the plan was read and no bytes were sent');
		return result;
	}

	for (const batch of batches) {
		ctx.io.err(`uploading ${batch.length} blob(s)`);
		const sent = await ownerCall(ctx, owner, '/modify', {
			method: 'POST',
			params: { action: 'blobs', package: pkg.name },
			body: { blobs: batch }
		});
		if (sent.status >= 400) {
			result.error = replyError(sent, 'the site refused a blob');
			const rejected = sent.body['rejected'];
			if (Array.isArray(rejected) && rejected.length > 0) {
				result.notes.push(
					`${rejected.length} blob(s) did not hash to the name they were sent under`
				);
			}
			return result;
		}
		result.stored += Number(sent.body['stored'] ?? 0);
		result.skipped += Number(sent.body['skipped'] ?? 0);
		result.bytes += Number(sent.body['bytes'] ?? 0);
	}

	const committed = await ownerCall(ctx, owner, '/modify', {
		method: 'POST',
		params: {
			action: 'commit',
			package: pkg.name,
			label: opts.label,
			origin: opts.origin
		},
		body: { files: declared.map((file) => ({ path: file.path, hash: file.hash })) }
	});
	applyReply(result, committed);
	return result;
}

/** hashes every file once, in the order the selection walked them */
export async function declare(selection: PackageSelection): Promise<DeclaredFile[]> {
	return await Promise.all(
		selection.files.map(async (file) => ({
			path: file.path,
			hash: await sha256(file.source),
			bytes: file.bytes
		}))
	);
}

export async function sha256(source: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The revision id a manifest would get, computed the way the site computes it.
 *
 * sha256 over the manifest SORTED BY PATH, one `<path>\0<hash>` per line. Sorted so the same file
 * set walked in a different order is the same revision, which is what lets `modify status` compare
 * a local tree against a live one without asking the site to hash anything.
 *
 * **THE SEPARATOR IS A NUL AND A SPACE IS NOT CLOSE ENOUGH.** `hashManifest()` in the worker's
 * `ops/module-rev.ts` joins the two fields with `\0`, which a path cannot contain, and this
 * computed a space -- so every id disagreed with the site's, `modify status` could never answer
 * `clean`, and nothing on this machine could notice because the gate lane compares this function
 * against itself. `tests/modify-rev.spec.ts` reads the sibling's source instead.
 */
export async function manifestRev(files: readonly DeclaredFile[]): Promise<string> {
	const canonical = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\0${file.hash}`)
		.join('\n');
	return await sha256(canonical);
}

function readPlan(reply: OwnerReply): UploadPlan {
	return {
		have: asStrings(reply.body['have']),
		want: asStrings(reply.body['want']),
		wantBytes: Number(reply.body['wantBytes'] ?? 0),
		counts: (reply.body['counts'] as Record<string, number> | undefined) ?? {},
		rowsWritten: Number(reply.body['rowsWritten'] ?? 0)
	};
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads what a `commit` or an `activate` did.
 *
 * A rolled-back commit is a FAILURE to complete rather than a finding: the kernel refused to boot
 * against the new tree, the site put back what it had, and nothing the caller asked for happened.
 */
export function applyReply(result: UploadResult, reply: OwnerReply): void {
	result.rev = typeof reply.body['rev'] === 'string' ? reply.body['rev'] : null;
	result.applied = reply.body['applied'] === true;
	result.rolledBack = reply.body['rolledBack'] === true;
	result.counts = (reply.body['counts'] as Record<string, number> | undefined) ?? {};
	result.changes = Array.isArray(reply.body['changes'])
		? (reply.body['changes'] as UploadResult['changes'])
		: [];
	if (reply.body['ok'] === true) return;
	result.error = replyError(reply, 'the site refused the commit');
	const conflicts = reply.body['conflicts'];
	if (Array.isArray(conflicts) && conflicts.length > 0) {
		result.notes.push(
			`${conflicts.length} path(s) belong to another package on this site: ${conflicts
				.map((c) => JSON.stringify(c))
				.join(', ')}`
		);
	}
	const missing = reply.body['missing'];
	if (Array.isArray(missing) && missing.length > 0) {
		result.notes.push(`${missing.length} file(s) name a blob this site does not hold`);
	}
}

/** the short form a person reads and types back at `modify activate` */
export function shortRev(rev: string | null): string {
	return rev === null ? '-' : rev.slice(0, 8);
}
