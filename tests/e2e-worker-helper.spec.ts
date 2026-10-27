import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorker } from './e2e/helpers/worker';

interface Seen {
	method: string;
	url: string;
	remotePort: number | undefined;
	body: string;
}

let server: Server | undefined;

async function listen(status = 200, answer = '{"applied":2}') {
	const seen: Seen[] = [];
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			seen.push({
				method: req.method ?? '',
				url: req.url ?? '',
				remotePort: req.socket.remotePort,
				body: Buffer.concat(chunks).toString('utf8')
			});
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(answer);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { origin, seen };
}

afterEach(async () => {
	if (!server) return;
	server.closeAllConnections();
	await new Promise((resolve) => server!.close(resolve));
	server = undefined;
});

describe('seedWorker', () => {
	it('sends the statements as a JSON POST to /seed for the named site', async () => {
		const { origin, seen } = await listen();
		const applied = await seedWorker(origin, 'a site', [
			'CREATE TABLE t (a)',
			"INSERT INTO t VALUES ('x;\ny')"
		]);
		expect(applied).toBe(2);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.method).toBe('POST');
		expect(seen[0]!.url).toBe('/seed?site=a+site');
		expect(JSON.parse(seen[0]!.body)).toEqual([
			'CREATE TABLE t (a)',
			"INSERT INTO t VALUES ('x;\ny')"
		]);
	});

	it('names the status and the body when the object refuses', async () => {
		const { origin } = await listen(500, 'near "FROM": syntax error');
		await expect(seedWorker(origin, 's', ['x'])).rejects.toThrow(
			/\/seed answered 500: near "FROM"/
		);
	});

	it('does not reuse a pooled connection', async () => {
		// workerd closes an idle keep-alive socket 5s after a response, and fetch reuses it for the seed
		const { origin, seen } = await listen();
		await (await fetch(`${origin}/serve`)).text();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await seedWorker(origin, 's', ['x']);
		expect(seen).toHaveLength(2);
		expect(seen[1]!.remotePort).not.toBe(seen[0]!.remotePort);
	});

	it('carries a 6 MB seed intact', async () => {
		const { origin, seen } = await listen();
		const big = 'y'.repeat(6 * 1024 * 1024);
		await seedWorker(origin, 's', [big]);
		expect(JSON.parse(seen[0]!.body)).toEqual([big]);
	});
});
