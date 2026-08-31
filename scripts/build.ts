/**
 * Build script: transpile src/ to dist/ with the TypeScript compiler so the
 * runtime image only needs production dependencies — no transpilers.
 *
 * Why not bun build? Nest Terminus and Nest Common lazily require optional
 * adapters (@mikro-orm/core, class-transformer, etc.) that we do not use.
 * bun's bundler walks every dynamic require, fails on the missing ones, and
 * we'd be paying a tax to ship code we never import. tsc + Node's resolver
 * is the lazy, correct choice.
 */
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync } from 'node:fs';

if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

execSync('./node_modules/.bin/tsc -p tsconfig.build.json', { stdio: 'inherit' });
console.log('built dist/');