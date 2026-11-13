import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { formFields, pngBytes, verifyWorkflow } from '../src/commands/preview-workflow';
import { fakeFetch, testContext } from './helpers';

const LOGIN = { name: 'admin', password: 'pw' };

describe('pngBytes', () => {
	it('writes a PNG with the signature, a 2x2 header and a pixel of the colour asked for', () => {
		const png = pngBytes(200, 30, 30);
		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(png.readUInt32BE(16)).toBe(2);
		expect(png.readUInt32BE(20)).toBe(2);
		const idat = png.indexOf('IDAT');
		const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
		expect([...raw.subarray(0, 4)]).toEqual([0, 200, 30, 30]);
		expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
	});

	it('gives two colours two different files', () => {
		expect(pngBytes(200, 30, 30).equals(pngBytes(30, 30, 200))).toBe(false);
	});
});

describe('formFields', () => {
	const html = `<form id="a"><input type="hidden" name="form_id" value="a_form"><input name="x" value="1"></form>
<form id="node-page-form"><input data-drupal-selector="e" type="hidden" name="form_id" value="node_page_form" />
<input type="hidden" name="form_build_id" value="form-abc&amp;d" />
<input type="text" name="title[0][value]" value="" />
<input type="checkbox" name="status[value]" value="1" checked="checked" />
<input type="checkbox" name="promote[value]" value="1" />
<input type="radio" name="r" value="a" /><input type="radio" name="r" value="b" checked />
<textarea name="body[0][value]">
hello &lt;b&gt;</textarea>
<select name="format"><option value="x">X</option><option value="y" selected="selected">Y</option></select>
<select name="first"><option value="p">P</option><option value="q">Q</option></select>
<input type="submit" name="op" value="Save" /><input type="file" name="files[f]" /></form>`;

	it('reads what a browser would send for the named form, and nothing from another form', () => {
		const fields = formFields(html, 'node_page_form')!;
		expect(Object.fromEntries(fields)).toEqual({
			form_id: 'node_page_form',
			form_build_id: 'form-abc&d',
			'title[0][value]': '',
			'status[value]': '1',
			r: 'b',
			'body[0][value]': 'hello <b>',
			format: 'y',
			first: 'p'
		});
	});

	it('answers null for a form the page does not carry', () => {
		expect(formFields(html, 'user_login_form')).toBeNull();
	});
});

describe('verifyWorkflow', () => {
	const ctx = (handler: Parameters<typeof fakeFetch>[0]) =>
		testContext({ fetch: fakeFetch(handler) });

	// matching 503s: the same status on both ends says nothing about whether anyone can sign in
	it('fails at the login when every page answers 503', async () => {
		const result = await verifyWorkflow(
			ctx(() => new Response('unavailable', { status: 503 })),
			'http://dup.test',
			LOGIN
		);
		expect(result.steps).toEqual([
			{ step: 'login', ok: false, detail: 'the login page answered 503' }
		]);
		expect(result.failed).toMatchObject({ code: 'workflow' });
		expect(result.failed?.message).toContain('login did not work');
	});

	// a 200 for everything is what a cached or stand-in page returns, and it carries no login form
	it('fails at the login when every page is the same 200 page', async () => {
		const result = await verifyWorkflow(
			ctx(() => new Response('<html><title>Home</title></html>', { status: 200 })),
			'http://dup.test',
			LOGIN
		);
		expect(result.steps.map((s) => [s.step, s.ok])).toEqual([['login', false]]);
		expect(result.steps[0]!.detail).toContain('no login form');
	});

	it('fails when the login form is accepted but no session starts', async () => {
		const form = `<form><input type="hidden" name="form_id" value="user_login_form"><input type="hidden" name="form_build_id" value="b"></form>`;
		const result = await verifyWorkflow(
			ctx((url, init) =>
				init?.method === 'POST'
					? new Response('', { status: 303, headers: { location: '/user/login' } })
					: new Response(form, { status: 200 })
			),
			'http://dup.test',
			LOGIN
		);
		expect(result.steps[0]).toMatchObject({ step: 'login', ok: false });
		expect(result.steps[0]!.detail).toContain('no session cookie');
	});
});
