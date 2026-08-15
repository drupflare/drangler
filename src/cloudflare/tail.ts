import { UsageError } from '../errors';

export interface TailEvent {
	executionModel: string;
	cpuTime: number | null;
	wallTime: number | null;
	outcome: string | null;
	scriptName: string | null;
}

export interface ModelSummary {
	n: number;
	median: number;
	min: number;
	max: number;
	/** max minus min, because the platform is bimodal by 400-600 ms and a bare median hides that */
	spread: number;
}

export interface CpuReport {
	events: number;
	byModel: Record<string, ModelSummary>;
	/**
	 * True when the capture holds stateless events and no durableObject event at all.
	 *
	 * Measured in `drupflare/worker` on 2026-08: `wrangler tail --format json` returned 12 stateless
	 * events at 0-1 ms and zero durableObject events for the same invocations the Workers
	 * Observability API reported as 15 durableObject events with a 6,509 ms max. The expensive half of
	 * the trace was simply absent, and nothing marked it dropped. A capture in that shape is an
	 * instrument failure, and reporting a CPU figure from it is the failure mode RULE 0 exists for.
	 */
	instrumentFailure: boolean;
	/** whether an absolute may be quoted from this capture at all */
	usable: boolean;
	notes: string[];
}

/** The n below which this project's own rule refuses a verdict, given a 400-600 ms bimodal platform. */
export const MIN_SAMPLES = 3;

/** Reads a `wrangler tail --format json` capture: NDJSON, a JSON array, or concatenated objects. */
export function parseTailCapture(text: string): TailEvent[] {
	const raw = text.trim();
	if (raw === '') return [];
	const records: unknown[] = [];
	const asArray = raw.startsWith('[') ? safeParse(raw) : null;
	if (Array.isArray(asArray)) {
		records.push(...asArray);
	} else {
		for (const line of raw.split('\n')) {
			const parsed = safeParse(line.trim());
			if (parsed !== null) records.push(parsed);
		}
		if (records.length === 0) {
			const parsed = safeParse(raw);
			if (parsed !== null) records.push(parsed);
			else throw new UsageError('the capture is neither NDJSON nor a JSON array');
		}
	}
	return records.filter(isRecord).map((r) => ({
		executionModel: typeof r.executionModel === 'string' ? r.executionModel : 'unknown',
		cpuTime: typeof r.cpuTime === 'number' ? r.cpuTime : null,
		wallTime: typeof r.wallTime === 'number' ? r.wallTime : null,
		outcome: typeof r.outcome === 'string' ? r.outcome : null,
		scriptName: typeof r.scriptName === 'string' ? r.scriptName : null
	}));
}

function safeParse(text: string): unknown {
	if (text === '') return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function summarise(values: number[]): ModelSummary {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const median =
		sorted.length === 0
			? 0
			: sorted.length % 2 === 1
				? (sorted[mid] as number)
				: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	const min = sorted[0] ?? 0;
	const max = sorted[sorted.length - 1] ?? 0;
	return { n: sorted.length, median, min, max, spread: max - min };
}

/**
 * Summarises cpuTime per execution model, and says whether the capture may be quoted.
 *
 * The guard is the product here, not the arithmetic. Every earlier absolute in this project that had
 * to be withdrawn was withdrawn because the instrument was wrong rather than the system, so a report
 * that cannot detect its own instrument failing is worth less than no report.
 */
export function summariseCpu(events: readonly TailEvent[]): CpuReport {
	const byModel: Record<string, ModelSummary> = {};
	const groups = new Map<string, number[]>();
	for (const event of events) {
		if (event.cpuTime === null) continue;
		const bucket = groups.get(event.executionModel) ?? [];
		bucket.push(event.cpuTime);
		groups.set(event.executionModel, bucket);
	}
	for (const [model, values] of groups) byModel[model] = summarise(values);

	const stateless = byModel['stateless']?.n ?? 0;
	const durable = byModel['durableObject']?.n ?? 0;
	const instrumentFailure = stateless > 0 && durable === 0;

	const notes: string[] = [];
	if (instrumentFailure) {
		notes.push(
			'this capture has stateless events and no durableObject event; wrangler tail has been measured omitting them silently, so read it as an instrument failure and use the Workers Observability API instead'
		);
	}
	if (durable > 0 && durable < MIN_SAMPLES) {
		notes.push(
			`n=${durable} durableObject events; the platform is bimodal by 400-600 ms, so an absolute under about 500 ms is not supportable at this n`
		);
	}
	const wide = Object.entries(byModel).filter(([, s]) => s.spread > 400);
	for (const [model, s] of wide) {
		notes.push(
			`${model} spans ${s.spread} ms between min and max; quote the spread, not the median alone`
		);
	}
	if (events.length === 0)
		notes.push('the capture is empty; an empty tail is not evidence of anything');

	return {
		events: events.length,
		byModel,
		instrumentFailure,
		usable: !instrumentFailure && durable + stateless > 0,
		notes
	};
}

/** The exact capture command, since `--format json` is what makes a capture parseable at all. */
export function captureCommand(worker: string): string {
	return `bunx wrangler tail ${worker} --format json > tail.json`;
}
