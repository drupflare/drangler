import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const out = process.argv[2] ?? 'drift-diagnostics';
const beatMs = 50;
const stallMs = 250;

const read = (path) => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
};

const cpuStat = () => {
	const [, ...fields] = read('/proc/stat').split('\n')[0].split(/\s+/);
	const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map(Number);
	return { total: user + nice + system + idle + iowait + irq + softirq + steal, steal };
};

const cgroupCpu = () => {
	const stat = Object.fromEntries(
		read('/sys/fs/cgroup/cpu.stat')
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split(' '))
	);
	return {
		nrThrottled: Number(stat.nr_throttled ?? 0),
		throttledUsec: Number(stat.throttled_usec ?? 0)
	};
};

const clocksource = () =>
	read('/sys/devices/system/clocksource/clocksource0/current_clocksource').trim();

const events = [];
const log = (event) => {
	const line = { t: new Date().toISOString(), ...event };
	events.push(line);
	appendFileSync(`${out}/probe.jsonl`, `${JSON.stringify(line)}\n`);
};

const listener = net.createServer((socket) => {
	let last = performance.now();
	socket.on('data', () => {
		const now = performance.now();
		if (now - last > stallMs) log({ kind: 'transport-stall', gapMs: Math.round(now - last) });
		last = now;
	});
	socket.on('error', (error) =>
		log({ kind: 'transport-error', side: 'server', code: error.code })
	);
});

listener.listen(0, '127.0.0.1', () => {
	const client = net.connect(listener.address().port, '127.0.0.1');
	client.on('error', (error) =>
		log({ kind: 'transport-error', side: 'client', code: error.code })
	);
	client.on('close', () => log({ kind: 'transport-closed' }));
	setInterval(() => client.write('x'), beatMs).unref();
});

let before = { cpu: cpuStat(), cgroup: cgroupCpu() };
const first = before;
let expected = performance.now() + 1000;
const sample = setInterval(() => {
	const now = performance.now();
	const cpu = cpuStat();
	const cgroup = cgroupCpu();
	log({
		kind: 'sample',
		loopLagMs: Math.round(now - expected),
		stealPct: Number(
			((100 * (cpu.steal - before.cpu.steal)) / (cpu.total - before.cpu.total || 1)).toFixed(
				2
			)
		),
		throttled: cgroup.nrThrottled - before.cgroup.nrThrottled,
		clocksource: clocksource()
	});
	before = { cpu, cgroup };
	expected = now + 1000;
}, 1000);

const finish = () => {
	clearInterval(sample);
	const cpu = cpuStat();
	const cgroup = cgroupCpu();
	const samples = events.filter((event) => event.kind === 'sample');
	const summary = {
		seconds: samples.length,
		clocksource: clocksource(),
		stealPct: Number(
			((100 * (cpu.steal - first.cpu.steal)) / (cpu.total - first.cpu.total || 1)).toFixed(2)
		),
		maxSecondStealPct: Math.max(0, ...samples.map((event) => event.stealPct)),
		throttledPeriods: cgroup.nrThrottled - first.cgroup.nrThrottled,
		throttledUsec: cgroup.throttledUsec - first.cgroup.throttledUsec,
		maxLoopLagMs: Math.max(0, ...samples.map((event) => event.loopLagMs)),
		transportStalls: events.filter((event) => event.kind === 'transport-stall').length,
		maxTransportGapMs: Math.max(
			0,
			...events
				.filter((event) => event.kind === 'transport-stall')
				.map((event) => event.gapMs)
		),
		transportErrors: events.filter((event) => event.kind === 'transport-error').length
	};
	writeFileSync(`${out}/probe-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
	process.exit(0);
};

process.on('SIGTERM', finish);
process.on('SIGINT', finish);
