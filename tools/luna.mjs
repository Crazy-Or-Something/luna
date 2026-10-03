import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readProfiles, selectProfile, duplicateProfile, validateMetadata } from './profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keywords = new Set('and break do else elseif end false for function global goto if in local nil not or repeat return then true until while'.split(' '));
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LunaError extends Error {}

// Keep original token text and offsets, including all trivia.
export function tokenize(source) {
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
        if (end < 0) throw new LunaError('Unterminated long string or comment');
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
                    if (/[\r\n]/.test(source[end])) throw new LunaError('Unescaped newline in string');
                    end++;
                }
            }
            if (end >= source.length) throw new LunaError('Unterminated string');
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
                if (Object.keys(rule).some(key => !['expandsTo', 'description', 'enabled'].includes(key)) ||
                    (own(rule, 'description') && typeof rule.description !== 'string'))
                    throw new LunaError('Invalid shortcut fields: ' + name);
                if (own(rule, 'enabled') && typeof rule.enabled !== 'boolean')
                    throw new LunaError('Shortcut enabled must be a boolean: ' + name);
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
        if (tokenize(rule.expandsTo).some(t => t.kind === 'name' && names.has(t.text)))
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
    const canonical = token => token && (own(renamed, token.text) ? renamed[token.text] : token.text);
    const error = (token, message) => {
        const prefix = source.slice(0, token.start);
        const line = prefix.split(/\r\n|\r|\n/).length;
        throw new LunaError('Line ' + line + ': ' + message);
    };
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
            const lineStart = Math.max(source.lastIndexOf('\n', token.start - 1), source.lastIndexOf('\r', token.start - 1)) + 1;
            const lineEndMatch = /[\r\n]/.exec(source.slice(token.end));
            const lineEnd = lineEndMatch ? token.end + lineEndMatch.index : source.length;
            const before = source.slice(lineStart, token.start);
            const after = source.slice(token.end, lineEnd);
            if (!/^[ \t]*$/.test(before) || !/^[ \t]*(?:--[^\r\n]*)?$/.test(after))
                error(token, '"' + name + '" is reserved for a shortcut; put it alone on a line');
            // Semicolons stop the expansion becoming part of a neighbouring expression.
            replacement.set(token.start, ';' + shortcuts[name].expandsTo + ';');
        }
    }
    return tokens.map(t => replacement.get(t.start) ?? t.text).join('');
}

export function main(args) {
    const command = args.shift();
    if (!['translate', 'check', 'run', 'profiles', 'duplicate-profile'].includes(command)) {
        throw new LunaError('Usage: node tools/luna.mjs <translate|check|run> file.ln [--profile file.jsonc] [--profile-id ID] [--output file.lua] [--lua lua.exe]\n       node tools/luna.mjs profiles [--profile file.jsonc]\n       node tools/luna.mjs duplicate-profile --profile-id ID --new-id ID --output new.jsonc [--name NAME] [--profile file.jsonc]');
    }
    const managesProfiles = ['profiles', 'duplicate-profile'].includes(command);
    const input = managesProfiles ? null : args.shift();
    if (!managesProfiles && (!input || input.startsWith('--'))) throw new LunaError('Expected a .ln source file');
    const options = {};
    const allowed = command === 'profiles' ? ['--profile']
        : command === 'duplicate-profile' ? ['--profile', '--profile-id', '--new-id', '--name', '--output']
        : ['--profile', '--profile-id', '--output', '--lua'];
    while (args.length) {
        const flag = args.shift(), value = args.shift();
        if (!allowed.includes(flag) || !value || value.startsWith('--') || own(options, flag))
            throw new LunaError('Invalid or duplicate option: ' + flag);
        options[flag] = value;
    }
    if (options['--output'] && !['translate', 'duplicate-profile'].includes(command)) throw new LunaError('--output is only for translate or duplicate-profile');
    const profilePath = options['--profile'] ?? path.join(root, 'profiles', 'default.jsonc');
    const collection = readProfiles(profilePath, validateProfile);
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
    const { profile } = selectProfile(collection, options['--profile-id']);
    const source = fs.readFileSync(input, 'utf8');
    const translated = translate(source, profile).replace(/^\uFEFF/, '');
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
    const filename = '@' + path.resolve(input).replaceAll('\\', '/');
    // Compile as text only. This developer runner is NOT a sandbox.
    const loader = 'local f,e=load(io.read("*a"),' + JSON.stringify(filename) + ',"t"); if not f then io.stderr:write(e,"\\n"); os.exit(1) end; ' +
        (command === 'run' ? 'f()' : 'io.write("Syntax OK\\n")');
    const result = spawnSync(runtime, ['-e', loader], { input: translated, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw new LunaError(result.error.message);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new LunaError('Lua process failed (' + (result.status ?? result.signal) + ')');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error('Luna: ' + error.message); process.exitCode = 1; }
}
