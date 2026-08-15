import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPlanCommand, runSurveyCommand } from '../../src/commands/migrate';
import { defaultContext } from '../../src/context';
import { nodeFiles } from '../../src/host/files';
import { bufferIo } from '../../src/io';
import { buildPlan } from '../../src/migrate/plan';
import type { SiteSurvey } from '../../src/migrate/survey';
import { dockerGate, sh } from './helpers/docker';
import { DRUPAL_ROOT, KEY_PATH, SSH_HOST, SSH_PORT, SSH_USER, stackUp } from './helpers/stack';

const skip = await dockerGate();

const HOST = `${SSH_USER}@${SSH_HOST}:${SSH_PORT}`;

/**
 * The survey over a real ssh transport, against a real Drupal.
 *
 * The unit lane drives the same code over a recorded transcript, which proves the parsers read the
 * shapes the fixtures contain. It cannot prove the fixtures resemble drush, that `BatchMode=yes`
 * actually keeps a keyless host from hanging, or that the ten commands are ones a real host answers.
 * That is what this is for.
 */
describe.skipIf(skip)('survey over ssh', () => {
	let scratch: string;
	let surveyPath: string;

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-sv-'));
		surveyPath = join(scratch, 'survey.json');
		await stackUp();
		// the container's host key changes whenever the stack is recreated, and a stale entry is a
		// hard ssh failure rather than a prompt under BatchMode
		await sh('ssh-keygen', ['-R', `[${SSH_HOST}]:${SSH_PORT}`], { timeoutMs: 30_000 });
	}, 900_000);

	it('reads a real Drupal over a real ssh connection', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io, files: nodeFiles() };
		await runSurveyCommand(ctx, {
			host: HOST,
			root: DRUPAL_ROOT,
			identity: KEY_PATH,
			out: surveyPath
		});

		const survey = JSON.parse(readFileSync(surveyPath, 'utf8')) as SiteSurvey;
		expect(survey.errors, JSON.stringify(survey.errors)).toEqual([]);
		expect(survey.php.version).toMatch(/^8\.\d+\.\d+/);
		expect(survey.php.extensions).toContain('pdo_mysql');
		expect(survey.drupal.version).toMatch(/^11\./);
		expect(survey.drupal.profile).toBe('standard');
		expect(survey.database.driver).toBe('mysql');
		expect(survey.database.name).toBe('drupal');
		expect(survey.drush).toMatch(/^\d+\./);
		expect(survey.modules).toContain('node');
		expect(survey.modules.length).toBeGreaterThan(20);
		expect(survey.nodes).toBeGreaterThanOrEqual(1);
		expect(survey.files.kb).toBeGreaterThanOrEqual(0);
	});

	/**
	 * `drush status --format=json` returns `db-password` in the clear.
	 *
	 * The survey is written to disk and shared, so anything it carries leaves the host with it. This
	 * asserts the parser's field list is a whitelist in practice and not only in intent -- a survey
	 * that quietly gained a `raw` field would fail here rather than in somebody's support thread.
	 */
	it('never writes the database password into the survey it saves', () => {
		const written = readFileSync(surveyPath, 'utf8');
		expect(written).not.toContain('drupalpass');
		expect(written).not.toContain('db-password');
		expect(written).not.toContain('rootpass');
	});

	it('plans from the real survey and reaches the same verdicts offline', async () => {
		const survey = JSON.parse(readFileSync(surveyPath, 'utf8')) as SiteSurvey;
		const plan = buildPlan(survey, 'to-worker');

		// a stock Drupal on MySQL: convertible, drush present, nothing incompatible installed
		expect(plan.findings.find((f) => f.id === 'db-driver')?.severity).toBe('note');
		expect(plan.findings.find((f) => f.id === 'drush-absent')).toBeUndefined();
		expect(plan.findings.find((f) => f.id === 'incompatible-modules')).toBeUndefined();
		expect(plan.counts.blocker).toBe(0);
		// everything the survey measured is off the unknowns list
		expect(plan.unknowns).not.toContain('database.driver');
		expect(plan.unknowns).not.toContain('modules');
		expect(plan.unknowns).not.toContain('nodes');

		const io = bufferIo();
		await runPlanCommand(
			{ ...defaultContext(), io, files: nodeFiles() },
			{ survey: surveyPath, to: 'workers' }
		);
		expect(io.text()).toContain(HOST);
	});

	it('a dry run prints the plan and opens no connection', async () => {
		const io = bufferIo();
		// a host that does not resolve: a dry run that reached the network would fail here
		await runSurveyCommand(
			{ ...defaultContext(), io },
			{ host: 'no-such-host.invalid', root: '/var/www/html', dryRun: true }
		);
		expect(io.text()).toContain('nothing was executed');
		expect(io.text()).toContain('drush status --format=json');
	});

	it('fails without a usable key rather than hanging on a prompt', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io, files: nodeFiles() };
		await runSurveyCommand(ctx, {
			host: HOST,
			root: DRUPAL_ROOT,
			identity: join(scratch, 'not-a-key'),
			out: join(scratch, 'broken.json')
		});
		const survey = JSON.parse(readFileSync(join(scratch, 'broken.json'), 'utf8')) as SiteSurvey;
		// every step reports a transport failure; BatchMode is what stops this being a hung prompt
		expect(survey.errors.length).toBeGreaterThan(0);
		expect(survey.errors.map((e) => e.detail).join(' ')).toMatch(/could not connect|exit/i);
		expect(survey.php.version).toBeNull();
	}, 120_000);

	it('leaves the scratch directory behind and nothing else', () => {
		rmSync(scratch, { recursive: true, force: true });
		expect(true).toBe(true);
	});
});
