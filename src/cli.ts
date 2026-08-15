#!/usr/bin/env bun
import { defaultContext } from './context';
import { run } from './run';

process.exitCode = await run(defaultContext(), process.argv.slice(2));
