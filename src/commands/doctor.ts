import { resolveAuth } from '../cloudflare/auth';
import type { Context } from '../context';
import { FindingError } from '../errors';
import { emit, table } from '../format';
import type { CommandRunner } from '../host/exec';

export interface ToolCheck {
	name: string;
	/** the command drangler runs that needs it */
	usedBy: string;
	required: boolean;
	present: boolean;
	version: string | null;
	install: string;
}

interface ToolSpec {
	name: string;
	args: string[];
	usedBy: string;
	required: boolean;
	install: string;
}

/**
 * What drangler shells out to, and which command needs each.
 *
 * `ssh` and `wrangler` are required because half the surface is unusable without them. `php` and
 * `drush` are not listed at all: they are needed on the VPS being surveyed, not on this machine.
 *
 * `git` was dropped when `status` stopped scanning source checkouts. Nothing here shells out to it
 * any more, and a preflight that demands a tool the CLI never runs is a false failure on a user's
 * machine -- which is the whole class of bug this command exists to avoid producing.
 */
export const TOOLS: readonly ToolSpec[] = [
	{
		name: 'ssh',
		args: ['-V'],
		usedBy: 'migrate survey',
		required: true,
		install: 'openssh-client'
	},
	{
		name: 'wrangler',
		args: ['--version'],
		usedBy: 'cf whoami, cf workers',
		required: true,
		install: 'bun add -g wrangler'
	},
	{
		name: 'bun',
		args: ['--version'],
		usedBy: 'running drangler from source',
		required: false,
		install: 'curl -fsSL https://bun.sh/install | bash'
	},
	{
		name: 'rsync',
		args: ['--version'],
		usedBy: 'the file copy step `migrate plan` prints',
		required: false,
		install: 'your distribution package'
	}
];

/** `ssh -V` writes to stderr, and `git --version` to stdout; both are read. */
export function parseVersion(stdout: string, stderr: string): string | null {
	const text = `${stdout} ${stderr}`;
	return /(\d+\.\d+(?:\.\d+)?[\w.]*)/.exec(text)?.[1] ?? null;
}

export async function checkTools(runner: CommandRunner): Promise<ToolCheck[]> {
	const out: ToolCheck[] = [];
	for (const spec of TOOLS) {
		const result = await runner.run(spec.name, spec.args);
		const present = result.code === 0;
		out.push({
			name: spec.name,
			usedBy: spec.usedBy,
			required: spec.required,
			present,
			version: present ? parseVersion(result.stdout, result.stderr) : null,
			install: spec.install
		});
	}
	return out;
}

export interface DoctorOptions {
	json?: boolean;
}

/**
 * Preflight: the tools and the Cloudflare credential, in one pass.
 *
 * Exists because every other command fails in its own way when one of these is missing, and the
 * failure names the symptom rather than the cause -- "ssh exited 127" is a worse first experience
 * than being told ssh is not installed before anything is attempted.
 *
 * **Looks at nothing on disk.** It used to also report a drupflare source workspace, which meant the
 * command someone runs when they are already confused failed on a machine that had never had one.
 * A health check that only passes on a maintainer's laptop is worse than no health check.
 */
export async function runDoctor(ctx: Context, opts: DoctorOptions): Promise<void> {
	const tools = await checkTools(ctx.runner);
	const auth = await resolveAuth(ctx.runner, ctx.env);

	const missing = tools.filter((t) => t.required && !t.present);
	const report = { tools, auth, missing: missing.map((t) => t.name) };

	emit(ctx.io, opts.json === true, report, () => {
		const lines = [
			...table(
				['tool', 'found', 'version', 'used by'],
				tools.map((t) => [
					t.name + (t.required ? '' : ' (optional)'),
					t.present ? 'yes' : 'NO',
					t.version ?? '-',
					t.usedBy
				])
			),
			'',
			`cloudflare: ${auth.authenticated ? `${auth.source}${auth.email === null ? '' : ` as ${auth.email}`}` : 'not authenticated'}`
		];
		if (missing.length > 0) {
			lines.push('', 'missing');
			for (const tool of missing) lines.push(`  ${tool.name}: ${tool.install}`);
		}
		if (auth.remedy !== null) lines.push('', `next: ${auth.remedy}`);
		return lines;
	});

	if (missing.length > 0) {
		throw new FindingError('tools', `${missing.length} required tool(s) missing`);
	}
}
