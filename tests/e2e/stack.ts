#!/usr/bin/env bun
import { brokenUp, stackDown, stackUp } from './helpers/stack';

const action = process.argv[2];
if (action === 'up') {
	console.log('[e2e] bringing the stack up; the first boot installs Drupal');
	await stackUp();
	console.log('[e2e] ready');
} else if (action === 'broken') {
	console.log('[e2e] bringing the stack and the broken arm up');
	await stackUp();
	await brokenUp();
	console.log('[e2e] ready');
} else if (action === 'down') {
	await stackDown();
	console.log('[e2e] stack down, volumes removed');
} else {
	console.error('usage: bun tests/e2e/stack.ts up|broken|down');
	process.exit(2);
}
