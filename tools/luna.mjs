import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readProfiles, selectProfile, duplicateProfile, validateMetadata } from './profile.mjs';

// Templates are tokenized by the caller, so strings and comments remain literal.
function templateParts(text, tokenize, parameters = []) {
    const tokens = tokenize(text);
    const parts = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.text !== '$') { parts.push({ text: token.text, token }); continue; }
        const open = tokens[++i], name = tokens[++i], close = tokens[++i];
        if (open?.text !== '{' || name?.kind !== 'name' || close?.text !== '}' ||
            open.start !== token.end || name.start !== open.end || close.start !== name.end)
            throw new Error('Template placeholders must use ${parameter}');
        if (!parameters.includes(name.text)) throw new Error('Unknown shortcut parameter: ' + name.text);
        parts.push({ parameter: name.text });
    }
    return parts;
}

function shortcutCall(code, index, source, fail, canonical) {
    const name = code[index];
    if (code[index + 1]?.text !== '(') fail(name, '"' + name.text + '" needs parentheses and its declared arguments');
    const stack = ['('];
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const args = [];
    let start = code[index + 1].end;
    for (let i = index + 2; i < code.length; i++) {
        const token = code[i];
        if (token.kind === 'name' && canonical(token) === 'function')
            fail(token, 'Shortcut arguments cannot contain anonymous functions yet; pass a named function instead');
        if (token.kind === 'symbol' && ['(', '[', '{'].includes(token.text)) stack.push(token.text);
        else if (token.kind === 'symbol' && Object.hasOwn(pairs, token.text)) {
            if (stack.pop() !== pairs[token.text]) fail(token, 'Mismatched delimiter in shortcut arguments');
            if (!stack.length) {
                const last = source.slice(start, token.start);
                if (last.trim()) args.push({ start, end: token.start });
                else if (args.length) fail(token, 'Missing shortcut argument after comma');
                return { args, end: token.end };
            }
        } else if (token.text === ',' && stack.length === 1) {
            if (!source.slice(start, token.start).trim()) fail(token, 'Missing shortcut argument');
            args.push({ start, end: token.start });
            start = token.end;
        }
    }
    fail(name, 'Unclosed shortcut argument list');
}


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keywords = new Set('and break do else elseif end false for function global goto if in local nil not or repeat return then true until while'.split(' '));
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LunaError extends Error {
    constructor(message, location = {}) { super(message); this.name = 'LunaError'; Object.assign(this, location); }
}
function sourceError(source, start, end, message) {
    const before = source.slice(0, start);
    const line = before.split(/\r\n|\r|\n/).length;
    const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
    return new LunaError('Line ' + line + ': ' + message, { line, column: start - lineStart + 1, start, end });
}
export function diagnosticFor(error) {
    return { severity: 'error', message: error.message, ...(error.file ? { file: error.file } : {}),
        ...(error.line ? { line: error.line, column: error.column ?? 1 } : {}),
        ...(Number.isInteger(error.start) ? { start: error.start, end: error.end } : {}) };
}

// Keep original token text and offsets, including all trivia.
export function tokenize(source, { allowIncomplete = false } = {}) {
    const tokens = [];
    let i = 0;
    const add = (kind, end) => {
        tokens.push({ kind, text: source.slice(i, end), start: i, end });
        i = end;
    };
    const longEnd = start => {
        const opener = /^\[(=*)\[/.exec(source.slice(start));
        if (!opener) return null;
        const close = ']' + opener[1] + ']';
        const end = source.indexOf(close, start + opener[0].length);
        if (end < 0) {
            if (allowIncomplete) return source.length;
            throw sourceError(source, start, source.length, 'Unterminated long string or comment');
        }
        return end + close.length;
    };
    while (i < source.length) {
        const rest = source.slice(i);
        if (i === 0 && source[i] === '\uFEFF') { add('space', i + 1); continue; }
        const space = /^[ \t\r\n\f\v]+/.exec(rest);
        if (space) { add('space', i + space[0].length); continue; }
        if (rest.startsWith('--')) {
            const end = longEnd(i + 2);
            if (end !== null) add('comment', end);
            else {
                const line = source.slice(i).search(/[\r\n]/);
                add('comment', line < 0 ? source.length : i + line);
            }
            continue;
        }
        if (source[i] === '"' || source[i] === "'") {
            const quote = source[i];
            let end = i + 1;
            while (end < source.length && source[end] !== quote) {
                if (source[end] === '\\') {
                    if (source[end + 1] === 'z') {
                        end += 2;
                        while (end < source.length && /[ \t\r\n\f\v]/.test(source[end])) end++;
                    } else {
                        end += 2;
                        if (source[end - 1] === '\r' && source[end] === '\n') end++;
                    }
                } else {
                    if (/[\r\n]/.test(source[end])) {
                        if (allowIncomplete) break;
                        throw sourceError(source, i, end, 'Unescaped newline in string');
                    }
                    end++;
                }
            }
            if (end >= source.length || source[end] !== quote) {
                if (allowIncomplete) { add('string', Math.min(end, source.length)); continue; }
                throw sourceError(source, i, source.length, 'Unterminated string');
            }
            add('string', end + 1);
            continue;
        }
        const end = longEnd(i);
        if (end !== null) { add('string', end); continue; }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        if (name) { add('name', i + name[0].length); continue; }
        const number = /^(?:0[xX][0-9a-fA-F]+(?:\.(?!\.)[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?|(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
        if (number) { add('number', i + number[0].length); continue; }
        const symbol = /^(?:\.\.\.|\.\.|::|==|~=|<=|>=|<<|>>|\/\/)/.exec(rest);
        add('symbol', i + (symbol ? symbol[0].length : 1));
    }
    return tokens;
}

export function validateProfile(profile) {
    if (!record(profile)) throw new LunaError('Profile must be a JSON object');
    for (const key of Object.keys(profile)) {
        if (!['version', 'name', 'description', 'canBeEdited', 'canBeDuplicated', 'template', 'keywords', 'functions', 'shortcuts'].includes(key))
            throw new LunaError('Unknown profile field: ' + key);
    }
    if (profile.version !== 1) throw new LunaError('Profile version must be 1');
    validateMetadata(profile);
    const names = new Set();
    for (const group of ['keywords', 'functions', 'shortcuts']) {
        if (own(profile, group) && !record(profile[group])) throw new LunaError(group + ' must be an object');
        for (const [name, rule] of Object.entries(profile[group] ?? {})) {
            if (!identifier.test(name) || keywords.has(name))
                throw new LunaError('Invalid or reserved custom name: ' + name);
            const active = group !== 'shortcuts' || rule?.enabled !== false;
            if (active) {
                if (names.has(name)) throw new LunaError('Conflicting custom name: ' + name);
                names.add(name);
            }
            if (group === 'keywords' && !keywords.has(rule))
                throw new LunaError('Unknown keyword target for ' + name);
            if (group === 'functions' && (typeof rule !== 'string' || !identifier.test(rule) || keywords.has(rule)))
                throw new LunaError('Function target must be a plain identifier: ' + name);
            if (group === 'shortcuts') {
                if (!record(rule) || typeof rule.expandsTo !== 'string' || !rule.expandsTo.trim())
                    throw new LunaError('Shortcut needs expandsTo: ' + name);
                if (Object.keys(rule).some(key => !['expandsTo', 'description', 'enabled', 'parameters'].includes(key)) ||
                    (own(rule, 'description') && typeof rule.description !== 'string'))
                    throw new LunaError('Invalid shortcut fields: ' + name);
                if (own(rule, 'enabled') && typeof rule.enabled !== 'boolean')
                    throw new LunaError('Shortcut enabled must be a boolean: ' + name);
                if (own(rule, 'parameters') && (!Array.isArray(rule.parameters) ||
                    rule.parameters.some(name => typeof name !== 'string' || !identifier.test(name) || keywords.has(name)) ||
                    new Set(rule.parameters).size !== rule.parameters.length))
                    throw new LunaError('Shortcut parameters must be unique non-reserved identifiers: ' + name);
                templateParts(rule.expandsTo, tokenize, rule.parameters ?? []);
                if (/[\r\n]/.test(rule.expandsTo) || tokenize(rule.expandsTo).some(t => t.kind === 'comment'))
                    throw new LunaError('Shortcut must be one line without comments: ' + name);
            }
        }
    }
    for (const [name, target] of Object.entries(profile.functions ?? {})) {
        if (names.has(target)) throw new LunaError('Alias chains are not supported: ' + name);
    }
    for (const rule of Object.values(profile.shortcuts ?? {})) {
        if (rule.enabled === false) continue;
        if (templateParts(rule.expandsTo, tokenize, rule.parameters ?? []).some(part => part.token?.kind === 'name' && names.has(part.text)))
            throw new LunaError('Shortcut expansions must use canonical Lua names');
    }
    return profile;
}

export function translate(source, profile) {
    validateProfile(profile);
    const aliases = profile.functions ?? {};
    const renamed = profile.keywords ?? {};
    const shortcuts = Object.fromEntries(Object.entries(profile.shortcuts ?? {}).filter(([, rule]) => rule.enabled !== false));
    const tokens = tokenize(source);
    const code = tokens.filter(t => t.kind !== 'space' && t.kind !== 'comment');
    const replacement = new Map();
    const calls = [];
    const usedNames = new Set([...tokens.filter(t => t.kind === 'name').map(t => t.text),
        ...Object.values(shortcuts).flatMap(rule => tokenize(rule.expandsTo).filter(t => t.kind === 'name').map(t => t.text))]);
    let generated = 0;
    const freshName = () => { let name; do { name = '__luna_arg_' + generated++; } while (usedNames.has(name)); usedNames.add(name); return name; };
    const canonical = token => token && (own(renamed, token.text) ? renamed[token.text] : token.text);
    const error = (token, message) => { throw sourceError(source, token.start, token.end, message); };
    for (let i = 0; i < code.length; i++) {
        const token = code[i];
        if (token.kind !== 'name') continue;
        const previous = code[i - 1], next = code[i + 1];
        // Explicit fields and labels retain their actual names.
        if (previous && ['.', ':', '::', 'goto'].includes(canonical(previous))) continue;
        const name = token.text;
        if (own(renamed, name)) {
            replacement.set(token.start, renamed[name]);
        } else if (own(aliases, name)) {
            if (canonical(previous) === 'function' || !next || next.text !== '(')
                error(token, '"' + name + '" is reserved for a function alias; use it as ' + name + '(...)');
            replacement.set(token.start, aliases[name]);
        } else if (own(shortcuts, name)) {
            const rule = shortcuts[name];
            const call = own(rule, 'parameters') ? shortcutCall(code, i, source, error, canonical) : { end: token.end };
            if (/[\r\n]/.test(source.slice(token.start, call.end))) error(token, 'Shortcut calls must fit on one line');
            if (call.args && call.args.length !== rule.parameters.length)
                error(token, '"' + name + '" expects ' + rule.parameters.length + ' argument(s), got ' + call.args.length);
            const lineStart = Math.max(source.lastIndexOf('\n', token.start - 1), source.lastIndexOf('\r', token.start - 1)) + 1;
            const lineEndMatch = /[\r\n]/.exec(source.slice(call.end));
            const lineEnd = lineEndMatch ? call.end + lineEndMatch.index : source.length;
            const before = source.slice(lineStart, token.start);
            const after = source.slice(call.end, lineEnd);
            if (!/^[ \t]*$/.test(before) || !/^[ \t]*(?:--[^\r\n]*)?$/.test(after))
                error(token, '"' + name + '" is reserved for a shortcut; put it alone on a line');
            // Semicolons stop the expansion becoming part of a neighbouring expression.
            if (call.args) {
                if (tokens.some(t => t.kind === 'comment' && t.start >= token.start && t.start < call.end))
                    error(token, 'Comments inside shortcut arguments are not supported; put comments after the call');
                calls.push({ start: token.start, ...call, rule });
            } else replacement.set(token.start, ';' + rule.expandsTo + ';');
        }
    }
    const render = (start, end) => tokens.filter(t => t.start >= start && t.end <= end).map(t => replacement.get(t.start) ?? t.text).join('');
    for (const call of calls) {
        const variables = Object.fromEntries(call.rule.parameters.map(parameter => [parameter, freshName()]));
        const body = templateParts(call.rule.expandsTo, tokenize, call.rule.parameters).map(part =>
            part.parameter ? variables[part.parameter] : part.text).join('');
        const values = call.args.map(arg => '(' + render(arg.start, arg.end).trim() + ')');
        const capture = values.length ? 'local ' + Object.values(variables).join(', ') + ' = ' + values.join(', ') + '; ' : '';
        replacement.set(call.start, ';do ' + capture + body + '; end;');
    }
    const consumed = new Map(calls.map(call => [call.start, call.end]));
    let skipUntil = -1;
    return tokens.map(token => {
        if (token.start < skipUntil) return '';
        if (consumed.has(token.start)) skipUntil = consumed.get(token.start);
        return replacement.get(token.start) ?? token.text;
    }).join('');
}

export function main(args) {
    const command = args.shift();
    if (!['translate', 'check', 'run', 'profiles', 'duplicate-profile'].includes(command)) {
        throw new LunaError('Usage: node tools/luna.mjs <translate|check|run> file.ln [--profile file.jsonc] [--profile-id ID] [--output file.lua] [--lua lua.exe] [--diagnostics json]\n       node tools/luna.mjs profiles [--profile file.jsonc]\n       node tools/luna.mjs duplicate-profile --profile-id ID --new-id ID --output new.jsonc [--name NAME] [--profile file.jsonc]');
    }
    const managesProfiles = ['profiles', 'duplicate-profile'].includes(command);
    const input = managesProfiles ? null : args.shift();
    if (!managesProfiles && (!input || input.startsWith('--'))) throw new LunaError('Expected a .ln source file');
    const options = {};
    const allowed = command === 'profiles' ? ['--profile', '--diagnostics']
        : command === 'duplicate-profile' ? ['--profile', '--profile-id', '--new-id', '--name', '--output', '--diagnostics']
        : ['--profile', '--profile-id', '--output', '--lua', '--diagnostics'];
    while (args.length) {
        const flag = args.shift(), value = args.shift();
        if (!allowed.includes(flag) || !value || value.startsWith('--') || own(options, flag))
            throw new LunaError('Invalid or duplicate option: ' + flag);
        options[flag] = value;
    }
    if (options['--diagnostics'] && options['--diagnostics'] !== 'json') throw new LunaError('--diagnostics must be json');
    if (options['--output'] && !['translate', 'duplicate-profile'].includes(command)) throw new LunaError('--output is only for translate or duplicate-profile');
    const profilePath = options['--profile'] ?? path.join(root, 'profiles', 'default.jsonc');
    let collection;
    try { collection = readProfiles(profilePath, validateProfile); }
    catch (error) { error.file = path.resolve(profilePath); throw error; }
    if (command === 'profiles') {
        const summaries = Object.entries(collection).map(([id, profile]) => ({
            id, name: profile.name ?? id, description: profile.description ?? '',
            canBeEdited: profile.canBeEdited ?? true,
            canBeDuplicated: profile.canBeDuplicated ?? true,
            template: profile.template ?? false
        }));
        console.log(JSON.stringify(summaries, null, 2));
        return;
    }
    if (command === 'duplicate-profile') {
        if (!options['--output']) throw new LunaError('duplicate-profile requires --output for a new collection file');
        if (!['.json', '.jsonc'].includes(path.extname(options['--output']).toLowerCase()))
            throw new LunaError('Profile output must end in .json or .jsonc');
        const duplicate = duplicateProfile(collection, options['--profile-id'], options['--new-id'], options['--name']);
        // Create a new file only; never overwrite the source or another profile collection.
        fs.writeFileSync(options['--output'], JSON.stringify(duplicate, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        console.log('Created profile "' + options['--new-id'] + '" in ' + options['--output']);
        return;
    }
    let profile;
    try { ({ profile } = selectProfile(collection, options['--profile-id'])); }
    catch (error) { error.file = path.resolve(profilePath); throw error; }
    const source = fs.readFileSync(input, 'utf8');
    let translated;
    try { translated = translate(source, profile).replace(/^\uFEFF/, ''); }
    catch (error) { error.file = path.resolve(input); throw error; }
    if (command === 'translate') {
        if (options['--output']) {
            if (path.resolve(options['--output']) === path.resolve(input)) throw new LunaError('Output must not overwrite source');
            fs.writeFileSync(options['--output'], translated, 'utf8');
        } else process.stdout.write(translated);
        return;
    }
    const candidates = [path.join(root, 'build', 'Release', 'lua.exe'), path.join(root, 'build', 'lua.exe'), path.join(root, 'build', 'lua')];
    const runtime = options['--lua'] ?? candidates.find(file => fs.existsSync(file));
    if (!runtime) throw new LunaError('Build the Lua runtime first (see docs/getting-started.md), or pass --lua');
    const filename = '@LunaCheck';
    // Compile as text only. This developer runner is NOT a sandbox.
    const loader = 'local f,e=load(io.read("*a"),' + JSON.stringify(filename) + ',"t"); if not f then io.stderr:write(e,"\\n"); os.exit(1) end; ' +
        (command === 'run' ? 'f()' : 'io.write("Syntax OK\\n")');
    const result = spawnSync(runtime, ['-e', loader], { input: translated, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw new LunaError(result.error.message);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0 && result.stderr) {
        const detail = /LunaCheck:(\d+):\s*([^\r\n]*)/.exec(result.stderr);
        if (detail) {
            if (command === 'run' && !options['--diagnostics']) process.stderr.write(result.stderr);
            const line = Number(detail[1]);
            throw new LunaError('Line ' + line + ': ' + detail[2] + ' (Lua error; columns are not mapped)', { line, column: 1, file: path.resolve(input) });
        }
        if (!options['--diagnostics']) process.stderr.write(result.stderr);
    }
    if (result.status === 0 && result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new LunaError('Lua process failed (' + (result.status ?? result.signal) + ')');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(process.argv.slice(2)); }
    catch (error) {
        const args = process.argv.slice(2);
        if (args[args.indexOf('--diagnostics') + 1] === 'json' && args.includes('--diagnostics'))
            console.error(JSON.stringify({ diagnostics: [diagnosticFor(error)] }));
        else {
            const location = error.file ? error.file + (error.line ? ':' + error.line + ':' + (error.column ?? 1) : '') + ': ' : '';
            console.error('Luna: ' + location + error.message + (!error.file && error.column ? ' (column ' + error.column + ')' : ''));
        }
        process.exitCode = 1;
    }
}
