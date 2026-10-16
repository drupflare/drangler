import { DatabaseSync } from 'node:sqlite';
import { unserialize } from './credentials';

/** the mail plugin the worker provides, which hands a message to its own transport */
export const WORKER_MAIL_PLUGIN = 'cfw_mail';

/**
 * The sender the Mail System module routes every message through, or null when the site has none
 * or already names the worker's plugin.
 *
 * `mailsystem.settings` outranks `system.mail`, and a sender such as `SMTPMailSystem` opens its own
 * socket, which a Worker cannot do: the message is lost with "Unable to find the socket transport"
 * before the worker's mail layer sees it. Measured on a clone of a site with `smtp` and
 * `mailsystem`: pointing the sender at the worker's plugin queued every message.
 */
export function readMailSender(path: string): string | null {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const row = db
			.prepare(
				"SELECT data FROM config WHERE collection = '' AND name = 'mailsystem.settings'"
			)
			.get() as { data: Uint8Array | string } | undefined;
		if (row === undefined) return null;
		const text =
			typeof row.data === 'string' ? row.data : Buffer.from(row.data).toString('latin1');
		const settings = unserialize(text) as { defaults?: { sender?: unknown } };
		const sender = settings.defaults?.sender;
		return typeof sender === 'string' && sender !== '' && sender !== WORKER_MAIL_PLUGIN
			? sender
			: null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/** the `$config` override that moves the Mail System sender onto the worker's plugin */
export const MAIL_SENDER_OVERRIDE = {
	'mailsystem.settings': { defaults: { sender: WORKER_MAIL_PLUGIN } }
};
