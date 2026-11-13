import { join } from 'node:path';
import type { Context } from '../context';
import {
	parseDeploymentReceipt,
	serializeDeploymentReceipt,
	type CapabilityFinding,
	type DeploymentReceipt,
	type ReceiptState
} from '../migrate/source-identity';

/** how long a receipt stays good; a later run re-observes the duplicate instead of trusting it */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

export const RECEIPT_FILE = 'receipt.json';

export interface ReceiptInput {
	origin: string;
	source: string;
	epoch: number;
	revision: string;
	state: ReceiptState;
	findings: CapabilityFinding[];
}

/** writes the duplicate's receipt beside its other artifacts and returns what it wrote */
export function writeReceipt(ctx: Context, out: string, input: ReceiptInput): DeploymentReceipt {
	const receipt: DeploymentReceipt = {
		...input,
		expiresAt: ctx.now().getTime() + RECEIPT_TTL_MS
	};
	ctx.files.writeText(join(out, RECEIPT_FILE), `${serializeDeploymentReceipt(receipt)}\n`);
	return receipt;
}

/** the receipt in a duplicate's folder, or null when there is none or it is not one */
export function readReceipt(ctx: Context, out: string): DeploymentReceipt | null {
	const path = join(out, RECEIPT_FILE);
	if (!ctx.files.exists(path)) return null;
	try {
		return parseDeploymentReceipt(ctx.files.readText(path));
	} catch {
		return null;
	}
}
