import { join } from 'node:path';
import type { FileHost } from '../host/files';

export interface WorkerGap {
	id: string;
	/** what a site on this worker does wrong, in terms a visitor or a client would see */
	symptom: string;
}

/** a file in the worker's source, and a string that proves the capability is in it */
const MARKERS = {
	integerBindings: 'src/db/integer-bindings.ts',
	moduleSettings: 'src/ops/deployment-env.ts',
	followMount: 'src/ops/git-sync.ts'
} as const;

/**
 * What the worker in a workspace cannot do yet, read from its own source.
 *
 * Read from the files rather than the version number, because a checkout can carry a fix a release
 * has not, and a version bump can lag the code it names. Each entry is a defect that left a real
 * copy of a real site wrong in a way no status code shows.
 *
 * `moduleSettings` and `followMount` are only asked about when the preview uses them, since a
 * worker without them costs nothing to a run that does not.
 */
export function workerGaps(
	files: FileHost,
	workspace: string,
	needs: { moduleSettings: boolean; followMount?: boolean }
): WorkerGap[] {
	const gaps: WorkerGap[] = [];
	if (!files.exists(join(workspace, MARKERS.integerBindings))) {
		gaps.push({
			id: 'integer-bindings',
			symptom:
				'this worker binds a PHP integer as a REAL, so a text column compared with an integer matches nothing and an integer stored in one becomes "5.0"; a module that keeps an enum in a string field lists no rows'
		});
	}
	if (needs.moduleSettings) {
		const file = join(workspace, MARKERS.moduleSettings);
		const reads = files.exists(file) && files.readText(file).includes('DRUPAL_SETTINGS');
		if (!reads) {
			gaps.push({
				id: 'module-settings',
				symptom:
					'this worker does not read DRUPAL_SETTINGS, so a module setting such as an API endpoint falls back to its default'
			});
		}
	}
	if (needs.followMount === true) {
		const file = join(workspace, MARKERS.followMount);
		const mounts = files.exists(file) && files.readText(file).includes('safeMount');
		if (!mounts) {
			gaps.push({
				id: 'follow-mount',
				symptom:
					'this worker mounts a followed repository under modules/custom, so the module it follows would land beside the carried copy at a second path instead of replacing it'
			});
		}
	}
	return gaps;
}
