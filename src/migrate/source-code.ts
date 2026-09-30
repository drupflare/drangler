import type { FileHost } from '../host/files';
import { CODE_DIRS, codeTree, parseSettings, settingsReport, type SettingsReport } from './preview';

/** What the source's own files say, read from a code tree that was streamed or is on disk. */
export interface SourceCode {
	files: { path: string; text: string }[];
	/** the source's composer.lock, when one was read */
	lock: string | null;
	settings: SettingsReport | null;
}

// #region drupal 11 compatibility

/** Whether a `core_version_requirement` admits Drupal 11: `^10.3 || ^11` does, `^10` does not. */
export function allowsDrupal11(requirement: string): boolean {
	return requirement.split('||').some((clause) => {
		const tokens = clause
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean);
		return (
			tokens.length > 0 &&
			tokens.every((token) => {
				const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.[\dx*]+)*$/.exec(token);
				if (m === null) return false;
				const major = Number(m[2]);
				switch (m[1] ?? '=') {
					case '>=':
						return major <= 11;
					case '>':
						return major < 11;
					case '<':
						return major > 11;
					case '<=':
						return major >= 11;
					default:
						return major === 11;
				}
			})
		);
	});
}

/** `core_version_requirement` out of an `.info.yml`, or null when the file does not set one. */
export function coreRequirement(info: string): string | null {
	const m = /^core_version_requirement:\s*(.+?)\s*(?:#.*)?$/m.exec(info);
	if (m === null) return null;
	return m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim();
}

/**
 * Enabled modules whose code is in the tree and does not admit Drupal 11.
 *
 * A module with no info file in the tree is core or unstreamed, and is left out rather than guessed
 * at. A module whose info file sets no requirement predates the key, so it does not admit 11.
 */
export function modulesWithout11(
	modules: readonly string[],
	files: readonly { path: string; text: string }[]
): { name: string; requirement: string | null }[] {
	const enabled = new Set(modules);
	const out: { name: string; requirement: string | null }[] = [];
	for (const file of files) {
		const m = /(?:^|\/)([A-Za-z0-9_]+)\.info\.yml$/.exec(file.path);
		if (m === null || !enabled.has(m[1]!) || out.some((o) => o.name === m[1])) continue;
		const requirement = coreRequirement(file.text);
		if (requirement === null || !allowsDrupal11(requirement)) {
			out.push({ name: m[1]!, requirement });
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

// #endregion

// #region extensions

export interface ExtensionCalls {
	/** how the build answers for it: absent, or a stand-in covering part of it */
	build: 'absent' | 'partial';
	/** regex source for the function names; a call is `name(` */
	functions: string;
	/** regex source for the class names; a use is `new Name` or `Name::` */
	classes?: string;
}

/**
 * The extensions whose absence the plan cares about, and the names that call each one.
 *
 * A name table and no parser, so a call through a variable or an alias is not seen. `sodium` is
 * partial because the driver installs stand-ins for the generichash and xchacha20 families.
 */
export const EXTENSION_CALLS: Record<string, ExtensionCalls> = {
	bcmath: { build: 'absent', functions: 'bc(?:add|sub|mul|div|mod|pow|sqrt|comp|scale|powmod)' },
	calendar: {
		build: 'absent',
		functions:
			'cal_(?:days_in_month|to_jd|from_jd|info)|(?:gregorian|julian|jewish|french)tojd|jdto(?:gregorian|julian|jewish|french|unix)|jd(?:dayofweek|monthname)|unixtojd|easter_(?:date|days)'
	},
	exif: { build: 'absent', functions: 'exif_(?:read_data|imagetype|thumbnail|tagname)' },
	gd: {
		build: 'absent',
		functions:
			'image(?:create|createtruecolor|createfrom(?:jpeg|png|gif|webp|string)|png|jpeg|gif|webp|destroy|copyresampled|copyresized)'
	},
	geos: {
		build: 'absent',
		functions: 'geos_\\w+',
		classes: 'GEOS(?:Geometry|WKTReader|WKBReader|WKTWriter|WKBWriter)'
	},
	intl: {
		build: 'absent',
		functions: '(?:numfmt|collator|transliterator|msgfmt)_\\w+|intl_get_error_(?:code|message)',
		classes:
			'NumberFormatter|Collator|IntlDateFormatter|MessageFormatter|Transliterator|ResourceBundle|IntlChar'
	},
	phar: { build: 'absent', functions: 'phar_\\w+', classes: 'Phar|PharData' },
	sodium: {
		build: 'partial',
		functions:
			'sodium_(?!crypto_generichash|crypto_aead_xchacha20poly1305_ietf_(?:encrypt|decrypt|keygen))\\w+'
	},
	tidy: { build: 'absent', functions: 'tidy_\\w+', classes: 'tidy' },
	xmlreader: { build: 'absent', functions: 'xmlreader_\\w+', classes: 'XMLReader' }
};

const PHP_FILE = /\.(php|module|inc|install|theme|engine|profile)$/;

export interface ExtensionCall {
	path: string;
	line: number;
	/** the file also tests for the extension or the function before calling it */
	guarded: boolean;
}

function callPattern(spec: ExtensionCalls): RegExp {
	const parts = [`(?<![\\w>$:])\\\\?(?:${spec.functions})\\s*\\(`];
	if (spec.classes !== undefined) {
		parts.push(
			`\\bnew\\s+\\\\?(?:${spec.classes})\\b`,
			`(?<![\\w$])\\\\?(?:${spec.classes})::`
		);
	}
	return new RegExp(parts.join('|'), 'i');
}

/** Call sites per extension, skipping comments, polyfills and the definition of a function. */
export function scanExtensionCalls(
	files: readonly { path: string; text: string }[]
): Record<string, ExtensionCall[]> {
	const out: Record<string, ExtensionCall[]> = {};
	for (const [ext, spec] of Object.entries(EXTENSION_CALLS)) {
		const call = callPattern(spec);
		const guard = new RegExp(
			`extension_loaded\\(\\s*['"]${ext}['"]|(?:function|class)_exists\\(\\s*['"]\\\\?(?:${spec.functions}${spec.classes === undefined ? '' : `|${spec.classes}`})['"]`,
			'i'
		);
		for (const file of files) {
			if (!PHP_FILE.test(file.path) || /polyfill/i.test(file.path)) continue;
			const guarded = guard.test(file.text);
			file.text.split('\n').forEach((raw, i) => {
				const line = raw.trim();
				if (/^(\/\/|#|\*|\/\*)/.test(line)) return;
				if (call.test(line.replace(/\bfunction\s+&?\w+/g, ''))) {
					(out[ext] ??= []).push({ path: file.path, line: i + 1, guarded });
				}
			});
		}
	}
	return out;
}

export interface DeclaredExtension {
	extension: string;
	/** the package or module whose composer.json requires it */
	by: string;
}

/** `ext-*` requirements, in the code tree's composer.json files and in the source's lock. */
export function declaredExtensions(
	files: readonly { path: string; text: string }[],
	lock: string | null
): DeclaredExtension[] {
	type Manifest = { name?: string; require?: Record<string, string> };
	const out: DeclaredExtension[] = [];
	const read = (text: string): Manifest | null => {
		try {
			return JSON.parse(text) as Manifest;
		} catch {
			return null;
		}
	};
	const take = (manifest: Manifest | null, fallback: string) => {
		for (const key of Object.keys(manifest?.require ?? {})) {
			const m = /^ext-(.+)$/.exec(key);
			if (m === null || !(m[1]! in EXTENSION_CALLS)) continue;
			const by = manifest?.name ?? fallback;
			if (!out.some((d) => d.extension === m[1] && d.by === by)) {
				out.push({ extension: m[1]!, by });
			}
		}
	};
	for (const file of files) {
		if (/(?:^|\/)composer\.json$/.test(file.path)) take(read(file.text), file.path);
	}
	if (lock !== null) {
		const parsed = read(lock) as { packages?: Manifest[] } | null;
		for (const pkg of parsed?.packages ?? []) take(pkg, 'a locked package');
	}
	return out.sort((a, b) => a.extension.localeCompare(b.extension) || a.by.localeCompare(b.by));
}

// #endregion

/**
 * Reads the source's own files from a directory: the code trees, `composer.lock` and the settings
 * files, each when present. The directory can be a Drupal root or a preview's output folder.
 */
export function readSourceCode(files: FileHost, dir: string): SourceCode {
	const tree = CODE_DIRS.some((d) => files.exists(`${dir}/${d}`))
		? codeTree(files, dir).files.map((f) => ({ path: f.path, text: f.text }))
		: [];
	const lockAt = [`${dir}/composer.lock`, `${dir}/../composer.lock`].find((p) => files.exists(p));
	const settingsAt = ['settings.php', 'settings.local.php']
		.map((n) => `${dir}/sites/default/${n}`)
		.filter((p) => files.exists(p));
	const assignments = settingsAt.flatMap((p) => parseSettings(files.readText(p)));
	return {
		files: tree,
		lock: lockAt === undefined ? null : files.readText(lockAt),
		settings: settingsAt.length === 0 ? null : settingsReport(assignments)
	};
}
