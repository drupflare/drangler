import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../src/host/files';
import { workerGaps } from '../src/workspace/capabilities';

const WS = '/ws/worker';

function workspace(has: { integers?: boolean; settings?: 'reads' | 'ignores' | 'absent' }) {
	const files = memoryFiles();
	if (has.integers === true) files.writeText(`${WS}/src/db/integer-bindings.ts`, 'export {};\n');
	if (has.settings === 'reads') {
		files.writeText(
			`${WS}/src/ops/deployment-env.ts`,
			"export const SETTINGS_NAME = 'DRUPAL_SETTINGS';\n"
		);
	}
	if (has.settings === 'ignores') {
		files.writeText(
			`${WS}/src/ops/deployment-env.ts`,
			"export const CONFIG_NAME = 'DRUPAL_CONFIG';\n"
		);
	}
	return files;
}

describe('workerGaps', () => {
	it('reports nothing for a worker that has both fixes', () => {
		const files = workspace({ integers: true, settings: 'reads' });
		expect(workerGaps(files, WS, { moduleSettings: true })).toEqual([]);
	});

	it('names the integer binding defect when its module is absent', () => {
		const gaps = workerGaps(workspace({ settings: 'reads' }), WS, { moduleSettings: false });
		expect(gaps.map((g) => g.id)).toEqual(['integer-bindings']);
		expect(gaps[0]?.symptom).toContain('matches nothing');
	});

	it('asks about module settings only when the preview carried one', () => {
		const files = workspace({ integers: true, settings: 'ignores' });
		expect(workerGaps(files, WS, { moduleSettings: false })).toEqual([]);
		expect(workerGaps(files, WS, { moduleSettings: true }).map((g) => g.id)).toEqual([
			'module-settings'
		]);
	});

	it('treats a missing deployment-env file as not reading the setting', () => {
		const files = workspace({ integers: true, settings: 'absent' });
		expect(workerGaps(files, WS, { moduleSettings: true }).map((g) => g.id)).toEqual([
			'module-settings'
		]);
	});

	it('asks whether the worker can mount a followed repository only when one is followed', () => {
		const old = memoryFiles();
		old.writeText(`${WS}/src/db/integer-bindings.ts`, 'export {};\n');
		old.writeText(`${WS}/src/ops/git-sync.ts`, 'export function mountPlan() {}\n');
		expect(workerGaps(old, WS, { moduleSettings: false })).toEqual([]);
		expect(
			workerGaps(old, WS, { moduleSettings: false, followMount: true }).map((g) => g.id)
		).toEqual(['follow-mount']);
		const current = memoryFiles();
		current.writeText(`${WS}/src/db/integer-bindings.ts`, 'export {};\n');
		current.writeText(`${WS}/src/ops/git-sync.ts`, 'export function safeMount() {}\n');
		expect(workerGaps(current, WS, { moduleSettings: false, followMount: true })).toEqual([]);
	});

	it('reports both, in a stable order, for an old worker', () => {
		expect(workerGaps(workspace({}), WS, { moduleSettings: true }).map((g) => g.id)).toEqual([
			'integer-bindings',
			'module-settings'
		]);
	});
});
