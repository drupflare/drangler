import {
	summariseCpu as librarySummary,
	type CpuReport,
	type TelemetryEvent
} from '@drupflare/workforce';
import { UsageError } from '../errors';

export interface TailEvent {
	executionModel: string;
	cpuTime: number | null;
	wallTime: number | null;
	outcome: string | null;
	scriptName: string | null;
}

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

/**
 * Summarises a capture with the library's reading, plus the remedy a CLI user can act on.
 *
 * The statistics and the instrument-failure rule are the library's; what is added here is the next
 * step, since `drangler cf logs` is the instrument to reach for when tail has dropped the expensive
 * half of the trace.
 */
export function summariseCpu(events: readonly TailEvent[]): CpuReport {
	const report = librarySummary(events.map(asTelemetry));
	if (!report.instrumentFailure) return report;
	return {
		...report,
		notes: [...report.notes, 'use the Workers Observability API instead: `drangler cf logs`']
	};
}

function asTelemetry(event: TailEvent): TelemetryEvent {
	return {
		timestamp: null,
		scriptName: event.scriptName,
		outcome: event.outcome,
		executionModel: event.executionModel,
		cpuTimeMs: event.cpuTime,
		wallTimeMs: event.wallTime,
		message: null,
		raw: {}
	};
}

/** The exact capture command, since `--format json` is what makes a capture parseable at all. */
export function captureCommand(worker: string): string {
	return `bunx wrangler tail ${worker} --format json > tail.json`;
}
