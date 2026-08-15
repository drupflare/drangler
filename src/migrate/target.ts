import { UsageError } from '../errors';

/** Where the VPS half of a migration connects, and how. */
export interface SshTarget {
	user: string | null;
	host: string;
	port: number | null;
	/** private key path, passed as `-i`; never read by drangler itself */
	identity?: string | undefined;
	/** the Drupal document root on that host */
	root: string;
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9._-]+$/;

/**
 * Parses `[user@]host[:port]`.
 *
 * Validated rather than passed through, because the result becomes argv for `ssh`. A host that could
 * contain a leading `-` would be read by ssh as a flag, and one that could contain a space would need
 * a shell to get there at all.
 */
export function parseTarget(spec: string, root: string, identity?: string): SshTarget {
	const raw = spec.trim();
	if (raw === '') throw new UsageError('a host is required, as [user@]host[:port]');

	const at = raw.lastIndexOf('@');
	const user = at === -1 ? null : raw.slice(0, at);
	let rest = at === -1 ? raw : raw.slice(at + 1);
	if (user !== null && !USER.test(user)) throw new UsageError(`not a username: ${user}`);

	let port: number | null = null;
	const colon = rest.lastIndexOf(':');
	if (colon !== -1 && !rest.includes(']')) {
		const tail = rest.slice(colon + 1);
		if (!/^\d+$/.test(tail)) throw new UsageError(`not a port: ${tail}`);
		port = Number(tail);
		if (port < 1 || port > 65535) throw new UsageError(`port out of range: ${port}`);
		rest = rest.slice(0, colon);
	}

	if (!HOST.test(rest)) throw new UsageError(`not a hostname or address: ${rest}`);
	return { user, host: rest, port, identity, root: normaliseRoot(root) };
}

/**
 * Validates the remote Drupal root.
 *
 * Absolute, no `..`, and no shell metacharacter, because this string is interpolated into remote
 * command text. A relative root would also resolve against whatever directory the login shell picks,
 * which differs between `sh` and a user's configured shell.
 */
export function normaliseRoot(root: string): string {
	const raw = root.trim();
	if (raw === '') throw new UsageError('a remote Drupal root is required, as an absolute path');
	if (!raw.startsWith('/')) throw new UsageError(`the remote root must be absolute: ${raw}`);
	if (raw.split('/').includes('..'))
		throw new UsageError(`the remote root must not contain ..: ${raw}`);
	if (/[^A-Za-z0-9._\-/]/.test(raw)) {
		throw new UsageError(`the remote root must not contain shell metacharacters: ${raw}`);
	}
	return raw.replace(/\/+$/, '') || '/';
}

/** `user@host`, or `host` when no user was given, for display and for ssh's own destination arg. */
export function destination(target: SshTarget): string {
	return target.user === null ? target.host : `${target.user}@${target.host}`;
}
