/* Pre-minify this package's own JS with terser, in place, over the STAGED payload.
 *
 * terser rather than jsmin: jsmin strips comments and whitespace only, while identifiers are wire
 * bytes and uhttpd serves /www with no compression. This page is a 65 KB module whose comments are
 * half its size, and every reader who opens System → Files pays for all of it.
 *
 * Top-level mangling is safe BECAUSE a LuCI resource file is evaluated inside a function wrapper:
 * its top level is function scope, and everything crossing a module seam goes through the wrapper's
 * parameters (`L`, the require aliases) or through globals (`E`, `_`), which terser never renames.
 *
 * IT NEVER RUNS OVER THE CHECKOUT and it never runs over `vendor/`: the caller hands it the staged
 * copy of the view's own directory, and the vendored editor beside it is third-party ES-module code
 * shipped verbatim, already minified by its own build, and not ours to rewrite. It rewrites every
 * file it is handed in place.
 *
 * The SDK path is untouched and still runs jsmin (LUCI_MINIFY_JS is left at its default), which is
 * what tools/t0.sh gates. The two paths therefore ship different bytes for the same commit — the
 * price of the SDK having no node — and both are checked: t0.sh parses the jsmin output, this file
 * parses its own.
 *
 * THE LuCI WRAPPER IS REBUILT AROUND THE FILE BEFORE TERSER SEES IT. luci.js evaluates a resource
 * file as `function(window, document, L, <one arg per require pragma>) { … }`, so its top level is
 * a function body with those names already bound. Handed the bare file, terser takes the top level
 * for global scope, `L` for a name nobody declared, and is free to give `L` to a mangled `const` —
 * a redeclaration of the parameter and a SyntaxError before a line runs. Wrapped in the same
 * function, terser's own scope analysis sees the parameters (reserved, so they keep their names)
 * and every global the file reads, and never hands one of them out. Adapted from
 * luci-theme-footstrap's tools/minify-js.mjs; bump them together. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import * as acorn from 'acorn';
import { minify } from 'terser';

const ACORN = { ecmaVersion: 2022, allowReturnOutsideFunction: true };

const roots = process.argv.slice(2);
if (!roots.length) {
	console.error('usage: node tools/minify-js.mjs <dir-or-file.js> ...');
	process.exit(2);
}

/* `vendor/` is skipped by PATH rather than by handing this a file list: a directory is what the
 * caller passes, and a new vendored tree under it must not become ours to minify by default. */
const files = roots.flatMap((r) => statSync(r).isDirectory()
	? readdirSync(r, { recursive: true }).filter((f) => f.endsWith('.js') && !f.split(sep).includes('vendor')).map((f) => join(r, f))
	: [ r ]);

/* A minifier handed nothing must not exit 0. The step this replaces globbed a path that matched no
 * file and said nothing, and a release shipped the sources verbatim. */
if (!files.length) {
	console.error(`minify-js: no .js files under ${roots.join(', ')} — nothing to minify, which is not a build`);
	process.exit(1);
}

/* The wrapper's parameters, derived exactly the way luci.js derives them, so this list cannot
 * drift. */
function wrapperParams(src) {
	const names = [ 'window', 'document', 'L' ];
	for (const d of directives(src).split('\n')) {
		const m = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/.exec(d);
		if (m) names.push(m[2] || m[1].replace(/[^a-zA-Z0-9_]/g, '_'));
	}
	return names;
}

/* `src` as the body of the function luci.js builds, and the body back out of terser's output. */
const WRAP = '__luci_wrapper__';
const wrap = (params, src) => `var ${WRAP}=function(${params.join(',')}){${src}\n};`;
function unwrap(code) {
	const fn = acorn.parse(code, ACORN).body[0].declarations[0].init;
	return code.slice(fn.body.start + 1, fn.body.end - 1);
}

/* the leading run of string-literal ExpressionStatements: 'use strict' + the require pragmas */
function directives(src) {
	const body = acorn.parse(src, ACORN).body;
	const out = [];
	for (const n of body) {
		if (n.type !== 'ExpressionStatement' || n.expression.type !== 'Literal' ||
		    typeof n.expression.value !== 'string')
			break;
		out.push(n.expression.value);
	}
	return out.join('\n');
}

let before = 0, after = 0, failed = 0;
for (const f of files) {
	const name = basename(f);
	const src = readFileSync(f, 'utf8');
	const params = wrapperParams(src);
	let min;
	try {
		const res = await minify(wrap(params, src), {
			/* directives:false = do NOT remove them — the pragmas ARE directives */
			compress: { directives: false, passes: 3, keep_fargs: true },
			/* `E` and `_` are globals, not parameters, and a file that never reads one could have a
			 * local take its name — harmless until a later line reads it from somewhere the minifier
			 * cannot see, and this page builds every row with E(). */
			mangle: { reserved: [ ...params, 'E', '_' ] },
		});
		min = unwrap(res.code);
		/* Parsed AS the wrapper, which is what catches a mangled name declared over a parameter:
		 * "Identifier 'L' has already been declared" is a parse error of the function, not of the
		 * body on its own. */
		acorn.parse(wrap(params, min), ACORN);
		/* a lost require pragma raises nothing at minify time: the module would simply load with no
		 * dependencies, on the router, for good */
		if (directives(min) !== directives(src))
			throw new Error('directive prologue changed — a require pragma was lost');
		/* a floor, not a budget: an empty or truncated write must not ship */
		if (!min || min.length < 100 || min.length >= src.length)
			throw new Error(`implausible output size ${min && min.length} (source ${src.length})`);
	} catch (e) {
		console.log(`  FAIL ${name}: ${e.message}`);
		failed++;
		continue;
	}
	writeFileSync(f, min);
	before += src.length; after += min.length;
	console.log(`  ${String(src.length).padStart(7)} -> ${String(min.length).padStart(6)}  ${name}`);
}

console.log(`minify-js: ${before} -> ${after} bytes (${before ? Math.round(100 - after * 100 / before) : 0}% smaller), ${files.length} files`);
if (failed) {
	console.error(`minify-js: ${failed} file(s) failed verification — refusing to ship`);
	process.exit(1);
}
