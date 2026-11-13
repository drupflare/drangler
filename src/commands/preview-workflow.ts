import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Context } from '../context';
import { FindingError } from '../errors';

export interface WorkflowLogin {
	name: string;
	password: string;
}

export interface WorkflowStep {
	step: 'login' | 'create' | 'edit' | 'upload' | 'logout';
	ok: boolean;
	detail: string;
}

export interface WorkflowResult {
	steps: WorkflowStep[];
	failed: FindingError | null;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	out.set(data, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** a valid 2x2 PNG of one colour, so two uploads differ in content and not only in name */
export function pngBytes(r: number, g: number, b: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(2, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.from([0, r, g, b, r, g, b]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const decode = (text: string): string =>
	text
		.replaceAll('&amp;', '&')
		.replaceAll('&quot;', '"')
		.replaceAll('&#039;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>');

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return m === null ? null : decode(m[2] ?? m[3] ?? '');
}

/**
 * The fields a browser would send for the form with this `form_id`: hidden inputs, text inputs,
 * checked boxes and radios, textareas and the selected option of each select. Buttons are left out;
 * the caller names the one it presses.
 */
export function formFields(html: string, formId: string): Map<string, string> | null {
	const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]);
	const form = forms.find((f) =>
		new RegExp(`name=["']form_id["'][^>]*value=["']${formId}["']`, 'i').test(f)
	);
	if (form === undefined) return null;
	const fields = new Map<string, string>();
	for (const [tag] of form.matchAll(/<input\b[^>]*>/gi)) {
		const name = attr(tag, 'name');
		const type = (attr(tag, 'type') ?? 'text').toLowerCase();
		if (name === null || ['submit', 'button', 'image', 'file', 'reset'].includes(type))
			continue;
		if ((type === 'checkbox' || type === 'radio') && !/\schecked(\s|=|\/|>)/i.test(tag))
			continue;
		fields.set(name, attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : ''));
	}
	for (const m of form.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
		const name = attr(m[1]!, 'name');
		if (name !== null) fields.set(name, decode(m[2]!.replace(/^\n/, '')));
	}
	for (const m of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
		const name = attr(m[1]!, 'name');
		if (name === null) continue;
		const options = [...m[2]!.matchAll(/<option\b[^>]*>/gi)].map((o) => o[0]);
		const chosen = options.find((o) => /\sselected(\s|=|\/|>)/i.test(o)) ?? options[0];
		if (chosen !== undefined) fields.set(name, attr(chosen, 'value') ?? '');
	}
	return fields;
}

/** a cookie jar and a redirect follower over the injected fetch, so every request is observable */
class Session {
	private jar = new Map<string, string>();
	constructor(
		private readonly ctx: Context,
		readonly origin: string,
		private readonly headers: Record<string, string> | undefined
	) {}

	cookies(): string {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	async send(
		path: string,
		init: { method?: string; body?: FormData | URLSearchParams } = {}
	): Promise<{
		status: number;
		location: string | null;
		text: string;
		bytes: Uint8Array;
		cache: string;
	}> {
		const res = await this.ctx.fetch(new URL(path, this.origin).toString(), {
			redirect: 'manual',
			...init,
			headers: {
				...(this.headers ?? {}),
				...(this.jar.size > 0 ? { cookie: this.cookies() } : {})
			}
		});
		for (const line of res.headers.getSetCookie?.() ?? []) {
			const [pair] = line.split(';');
			const at = pair!.indexOf('=');
			const name = pair!.slice(0, at).trim();
			const value = pair!.slice(at + 1).trim();
			if (
				value === '' ||
				/;\s*max-age=0\b/i.test(line) ||
				/expires=Thu, 01 Jan 1970/i.test(line)
			) {
				this.jar.delete(name);
			} else this.jar.set(name, value);
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		const location = res.headers.get('location');
		const cache = [
			['x-cfw-cache', res.headers.get('x-cfw-cache')],
			['x-drupal-dynamic-cache', res.headers.get('x-drupal-dynamic-cache')]
		]
			.filter(([, v]) => v !== null)
			.map(([k, v]) => `${k}: ${v}`)
			.join(', ');
		return {
			status: res.status,
			location: location === null ? null : this.local(location),
			text: new TextDecoder().decode(bytes),
			bytes,
			cache
		};
	}

	/** a redirect to the site's own address, as a path; a different origin stays whole */
	private local(location: string): string {
		const url = new URL(location, this.origin);
		return url.origin === new URL(this.origin).origin ||
			/^[a-z]+:\/\/[^/]*localhost/.test(location)
			? `${url.pathname}${url.search}`
			: location;
	}

	async get(
		path: string,
		hops = 5
	): Promise<{ status: number; path: string; text: string; bytes: Uint8Array; cache: string }> {
		let at = path;
		for (let i = 0; ; i++) {
			const got = await this.send(at);
			if (got.status >= 300 && got.status < 400 && got.location !== null && i < hops) {
				at = got.location;
				continue;
			}
			return {
				status: got.status,
				path: at,
				text: got.text,
				bytes: got.bytes,
				cache: got.cache
			};
		}
	}

	async post(
		path: string,
		fields: Map<string, string>,
		file?: { field: string; name: string; type: string; bytes: Uint8Array }
	) {
		const body = file === undefined ? new URLSearchParams() : new FormData();
		for (const [k, v] of fields) body.append(k, v);
		if (file !== undefined) {
			(body as FormData).append(
				file.field,
				new Blob([Buffer.from(file.bytes)], { type: file.type }),
				file.name
			);
		}
		return await this.send(path, { method: 'POST', body });
	}
}

class StepFailed extends Error {}

/** the content types an editor can add; Drupal skips the list when there is only one */
async function contentTypes(session: Session): Promise<string[]> {
	const add = await session.get('/node/add');
	const only = /^\/node\/add\/([a-z0-9_]+)$/.exec(add.path)?.[1];
	if (only !== undefined) return [only];
	return [...add.text.matchAll(/href="\/node\/add\/([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

function title(html: string): string {
	return decode(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
}

/**
 * Drives the duplicate the way an editor does: log in, create a node, edit it, upload two images in
 * separate saves, log out. Each step is checked against what the site then serves, never against the
 * status code of the request that made the change, because a site that answers every request with
 * the same page returns the same codes before and after.
 *
 * It writes content into the duplicate and nothing else, so it must never be pointed at the source.
 * A step that cannot be exercised fails the run; a run that skipped one has verified nothing.
 */
export async function verifyWorkflow(
	ctx: Context,
	origin: string,
	login: WorkflowLogin,
	headers?: Record<string, string>
): Promise<WorkflowResult> {
	const session = new Session(ctx, origin, headers);
	const steps: WorkflowStep[] = [];
	const tag = `drangler-workflow-${ctx.now().getTime()}`;
	const need = (ok: boolean, why: string): void => {
		if (!ok) throw new StepFailed(why);
	};
	const run = async (step: WorkflowStep['step'], body: () => Promise<string>) => {
		try {
			steps.push({ step, ok: true, detail: await body() });
			return true;
		} catch (e) {
			if (!(e instanceof StepFailed) && !(e instanceof Error)) throw e;
			steps.push({ step, ok: false, detail: e.message });
			return false;
		}
	};
	const finish = (): WorkflowResult => {
		const bad = steps.find((s) => !s.ok);
		return {
			steps,
			failed:
				bad === undefined
					? null
					: new FindingError(
							'workflow',
							`${bad.step} did not work on the duplicate: ${bad.detail}`
						)
		};
	};

	let uid = '';
	const loggedIn = await run('login', async () => {
		const form = await session.get('/user/login');
		need(form.status === 200, `the login page answered ${form.status}`);
		const fields = formFields(form.text, 'user_login_form');
		need(fields !== null, 'the login page carries no login form');
		fields!.set('name', login.name);
		fields!.set('pass', login.password);
		fields!.set('op', 'Log in');
		const posted = await session.post('/user/login', fields!);
		need(
			posted.status >= 300 && posted.status < 400,
			`the login form answered ${posted.status}, not a redirect`
		);
		need(session.cookies() !== '', 'the login set no session cookie');
		const me = await session.send('/user');
		const match = /\/user\/(\d+)/.exec(me.location ?? '');
		need(
			me.status >= 300 && me.status < 400 && match !== null,
			`/user did not lead to the account page (${me.status})`
		);
		uid = match![1]!;
		return `signed in as user ${uid}`;
	});
	if (!loggedIn) return finish();

	let nid = '';
	let nodeType = '';
	const created = await run('create', async () => {
		const types = await contentTypes(session);
		need(types.length > 0, 'no content type can be added by a signed-in user');
		nodeType = types.includes('page') ? 'page' : types[0]!;
		const page = await session.get(`/node/add/${nodeType}`);
		const fields = formFields(page.text, `node_${nodeType}_form`);
		need(fields !== null, `the ${nodeType} form was not served`);
		fields!.set('title[0][value]', `${tag} created`);
		fields!.set('op', 'Save');
		const posted = await session.post(`/node/add/${nodeType}`, fields!);
		need(
			posted.status >= 300 && posted.status < 400 && posted.location !== null,
			`the save answered ${posted.status}, not a redirect`
		);
		const shown = await session.get(posted.location!);
		nid =
			/\/node\/(\d+)/.exec(posted.location!)?.[1] ??
			/\/node\/(\d+)\/edit/.exec(shown.text)?.[1] ??
			'';
		need(nid !== '', 'the save did not lead to a node');
		need(
			title(shown.text).includes(`${tag} created`) || shown.text.includes(`${tag} created`),
			`node ${nid} does not show the title it was saved with`
		);
		return `${nodeType} node ${nid}`;
	});
	if (!created) return finish();

	const edited = await run('edit', async () => {
		const page = await session.get(`/node/${nid}/edit`);
		const fields = formFields(page.text, `node_${nodeType}_edit_form`);
		need(fields !== null, `the edit form for node ${nid} was not served`);
		need(
			fields!.get('title[0][value]') === `${tag} created`,
			'the edit form did not hold the saved title'
		);
		fields!.set('title[0][value]', `${tag} edited`);
		fields!.set('op', 'Save');
		const posted = await session.post(`/node/${nid}/edit`, fields!);
		need(
			posted.status >= 300 && posted.status < 400,
			`the edit answered ${posted.status}, not a redirect`
		);
		const shown = await session.get(`/node/${nid}`);
		need(
			shown.text.includes(`${tag} edited`),
			`the node page does not show the edited title (${shown.cache || 'no cache headers'})`
		);
		need(
			!shown.text.includes(`${tag} created`),
			`the node page still shows the title from before the edit (${shown.cache || 'no cache headers'})`
		);
		return `node ${nid} retitled`;
	});
	if (!edited) return finish();

	const uploaded = await run('upload', async () => {
		const types = await contentTypes(session);
		let host: { type: string; field: string; id: string } | null = null;
		for (const type of types) {
			const page = await session.get(`/node/add/${type}`);
			const field = /name="files\[(field_[a-z0-9_]+_0)\]"/.exec(page.text)?.[1];
			if (field !== undefined) {
				host = { type, field, id: `node_${type}_form` };
				break;
			}
		}
		need(host !== null, 'no content type has a file field, so an upload cannot be exercised');
		const seen: string[] = [];
		for (const [n, colour] of [
			[1, [200, 30, 30]],
			[2, [30, 30, 200]]
		] as const) {
			const bytes = pngBytes(colour[0], colour[1], colour[2]);
			const name = `${tag}-${n}.png`;
			const page = await session.get(`/node/add/${host!.type}`);
			const fields = formFields(page.text, host!.id);
			need(fields !== null, `the ${host!.type} form was not served for upload ${n}`);
			fields!.set('title[0][value]', `${tag} upload ${n}`);
			const button = `${host!.field}_upload_button`;
			const staged = new Map(fields!);
			staged.set('op', 'Upload');
			staged.set(button, 'Upload');
			const first = await session.post(`/node/add/${host!.type}`, staged, {
				field: `files[${host!.field}]`,
				name,
				type: 'image/png',
				bytes
			});
			need(first.status === 200, `staging upload ${n} answered ${first.status}`);
			const base = host!.field.replace(/_0$/, '');
			const withFile = formFields(first.text, host!.id);
			const fid = withFile?.get(`${base}[0][fids]`);
			need(
				withFile !== null && fid !== undefined && /^\d+$/.test(fid),
				`upload ${n} did not come back as a managed file`
			);
			withFile!.set(`${base}[0][alt]`, `${tag} ${n}`);
			withFile!.set('title[0][value]', `${tag} upload ${n}`);
			withFile!.set('op', 'Save');
			const saved = await session.post(`/node/add/${host!.type}`, withFile!);
			need(
				saved.status >= 300 && saved.status < 400 && saved.location !== null,
				`saving upload ${n} answered ${saved.status}, not a redirect`
			);
			const savedNid = /\/node\/(\d+)/.exec(saved.location!)?.[1];
			need(savedNid !== undefined, `saving upload ${n} did not lead to a node`);
			// the original file, as the node page or its edit form links it; a styled or delivery URL is a
			// derivative, so it cannot be compared with what was sent
			const pages = [
				(await session.get(`/node/${savedNid}`)).text,
				(await session.get(`/node/${savedNid}/edit`)).text
			];
			const href = pages
				.flatMap((html) => [...html.matchAll(/(?:href|src)="([^"]*\/files\/[^"]*)"/g)])
				.map((m) => decode(m[1]!))
				.find(
					(h) =>
						!h.includes('/styles/') &&
						!h.includes('/cfw-img/') &&
						new RegExp(`${tag}-${n}[^/]*\\.png`).test(h)
				);
			need(
				href !== undefined,
				`node ${savedNid} links no original file for ${name} (its display may use an image style)`
			);
			const served = await session.get(href!);
			need(served.status === 200, `the stored file ${href} answered ${served.status}`);
			need(
				sha(served.bytes) === sha(bytes),
				`the stored file for upload ${n} is not the file sent (${served.bytes.length} bytes back, ${bytes.length} sent)`
			);
			seen.push(`${savedNid}:${sha(bytes).slice(0, 8)}`);
		}
		need(
			new Set(seen.map((s) => s.split(':')[1])).size === 2,
			'the two uploads stored one file'
		);
		return `two uploads stored and served byte for byte (nodes ${seen.map((s) => s.split(':')[0]).join(', ')})`;
	});
	if (!uploaded) return finish();

	await run('logout', async () => {
		const stale = session.cookies();
		const out = await session.get('/user/logout');
		let page = out;
		if (out.status === 200) {
			const fields = formFields(out.text, 'user_logout_confirm');
			if (fields !== null) {
				fields.set('op', 'Log out');
				await session.post('/user/logout/confirm', fields);
			}
		}
		page = await session.get('/user');
		need(
			/\/user\/login/.test(page.path),
			`after logging out /user led to ${page.path}, not the login page`
		);
		const replay = new Session(ctx, origin, { ...(headers ?? {}), cookie: stale });
		const still = await replay.send('/node/add');
		need(
			still.status === 403 || (still.status >= 300 && still.status < 400),
			`the old session still opens /node/add (${still.status}) after logout`
		);
		return 'the session ended and its old cookie no longer opens /node/add';
	});
	return finish();
}
