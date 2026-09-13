#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createContext, expect, ReleaseError } from './core.mjs';
import { inspect, plan } from './inspect.mjs';
import { publish } from './publish.mjs';

const help = `azuki release automation

Usage:
  mise run release -- inspect
  mise run release -- plan --inspection PATH --version VERSION --notes PATH
  mise run release -- publish --plan PATH --approve DIGEST
  mise run release -- resume --plan PATH --approve DIGEST

inspect and plan write private review artifacts, not release commits or remote refs.
publish requires the user's explicit approval of the exact source, version, notes,
and publication consequences shown by plan; --approve is not itself authorization.
resume is only for the same explicitly authorized interrupted release.

Progress is written to stderr; each command returns one JSON result on stdout.
State and full command logs live under the Git common directory's azuki-release/.
The target is fixed to github.com/nanazt/azuki, origin/master; no target override.
`;

let command = process.argv[2] ?? 'help';
try {
  const args = process.argv.slice(3);
  if (command === 'help' || command === '--help' || process.argv.includes('--help')) {
    process.stdout.write(help);
  } else {
    const allowed = {
      inspect: [],
      plan: ['inspection', 'version', 'notes'],
      publish: ['plan', 'approve'],
      resume: ['plan', 'approve'],
    };
    expect(Object.hasOwn(allowed, command), 'usage', 'Unknown release command; use --help.');
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].startsWith('--') ? args[i].slice(2) : '';
      expect(allowed[command].includes(key) && !Object.hasOwn(options, key) && args[i + 1] !== undefined && !args[i + 1].startsWith('--'), 'usage', 'Unexpected, duplicate, or incomplete command option.', { option: args[i] });
      options[key] = args[i + 1];
    }
    for (const key of allowed[command]) expect(Object.hasOwn(options, key), 'usage', `Missing --${key}.`);
    if (command === 'plan') options.notes = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(options.notes));
    const ctx = await createContext();
    const result = command === 'inspect' ? await inspect(ctx)
      : command === 'plan' ? await plan(ctx, options)
        : await publish(ctx, { ...options, resume: command === 'resume' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const known = error instanceof ReleaseError;
  process.stdout.write(`${JSON.stringify({ ok: false, command, code: known ? error.code : 'unexpected_error', message: error.message, ...(known && Object.keys(error.details).length ? { details: error.details } : {}) })}\n`);
  process.exitCode = error.code === 'interrupted' ? 130 : 1;
}
