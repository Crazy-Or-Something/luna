import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate, validateProfile } from './luna.mjs';
import os from 'node:os';
import { parseJSONC, readProfiles, selectProfile, duplicateProfile } from './profile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(root, 'profiles/example.jsonc');
const profile = selectProfile(readProfiles(examplePath, validateProfile), 'example').profile;
const copy = () => structuredClone(profile);
const removeTemporary = directory => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('luna-'))
        throw new Error('Refusing cleanup outside a Luna test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
};

test('keyword, function and shortcut translate together', () => {
    assert.equal(translate('state greet(n)\n echo(n)\n hello -- hi\nend\n', profile),
        'function greet(n)\n print(n)\n ;print("hello"); -- hi\nend\n');
});
test('strings and comments survive byte for byte', () => {
    const source = '-- state echo hello\necho("echo \\" hello state")\necho(\'state \\\' hello\')\n--[==[ state echo hello\n]==]\necho([=[hello\nstate echo]=])\n';
    assert.equal(translate(source, profile), source.replace(/^echo\(/gm, 'print('));
});
test('Lua whitespace escape does not expose text as code', () => {
    assert.equal(translate('echo("x\\z \n echo hello state")', profile), 'print("x\\z \n echo hello state")');
});
test('explicit fields and labels are not renamed', () => {
    const source = 'object.echo()\nobject:echo()\nobject.state = 1\nobject.hello = 2\n::hello::\ngoto hello';
    assert.equal(translate(source, profile), source);
});
test('multiple aliases can target one function', () => {
    const custom = copy();
    custom.functions.say = 'print';
    assert.equal(translate('say(1); echo(2)', custom), 'print(1); print(2)');
});
test('rejects name collisions', () => {
    const custom = copy();
    custom.functions.hello = 'print';
    assert.throws(() => validateProfile(custom), /Conflicting/);
});
test('rejects reserved names and invalid targets', () => {
    for (const custom of [
        { version: 1, keywords: { if: 'function' } },
        { version: 1, keywords: { state: 'missing' } },
        { version: 1, functions: { echo: 'print()' } }
    ]) assert.throws(() => validateProfile(custom));
});
test('rejects recursion and alias chains', () => {
    const custom = copy();
    custom.functions.say = 'echo';
    assert.throws(() => validateProfile(custom), /chains/);
    const recursive = copy();
    recursive.shortcuts.hello.expandsTo = 'hello';
    assert.throws(() => validateProfile(recursive), /canonical/);
});
test('rejects malformed profiles and multiline/comment shortcuts', () => {
    for (const custom of [
        null, [], { version: 2 }, { version: 1, functions: [] }, { version: 1, functions: null },
        { version: 1, shortcuts: { hello: { expandsTo: 'print(1)\nprint(2)' } } },
        { version: 1, shortcuts: { hello: { expandsTo: 'print(1) -- hi' } } }
    ]) assert.throws(() => validateProfile(custom));
});
test('rejects alias declarations', () => {
    for (const source of ['local echo = 1', 'state echo() end', 'state f(echo) end', 'echo = print', 'local hello = 1'])
        assert.throws(() => translate(source, profile), /reserved/);
});
test('rejects shortcuts in expressions or inline statements', () => {
    for (const source of ['local x = hello', 'hello()', 'echo(hello)', 'if true then hello end', 'hello;'])
        assert.throws(() => translate(source, profile), /alone on a line/);
});
test('preserves CRLF and trailing comments', () => {
    assert.equal(translate('hello -- echo\r\n', profile), ';print("hello"); -- echo\r\n');
});
test('rejects unfinished strings and long comments', () => {
    for (const source of ['echo("oops)', '--[=[oops', 'echo([[oops)'])
        assert.throws(() => translate(source, profile), /Unterminated/);
});
test('canonical Lua stays intact', () => {
    const source = 'function f() print("hello") end\nlocal echoes = 3\n';
    assert.equal(translate(source, profile), source);
});
test('CLI translates and rejects missing input', () => {
    const cli = path.join(root, 'tools/luna.mjs');
    const good = spawnSync(process.execPath, [cli, 'translate', path.join(root, 'examples/greet.ln'), '--profile', examplePath, '--profile-id', 'example'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /function greet/);
    const bad = spawnSync(process.execPath, [cli, 'translate', 'missing.ln'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
});
const runtime = [path.join(root, 'build/Release/lua.exe'), path.join(root, 'build/lua')].find(fs.existsSync);
test('compiled runtime executes translated example', { skip: !runtime }, () => {
    const result = spawnSync(process.execPath, [path.join(root, 'tools/luna.mjs'), 'run', path.join(root, 'examples/greet.ln'), '--lua', runtime, '--profile', examplePath, '--profile-id', 'example'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replaceAll('\r\n', '\n'), 'hello Red from Luna!\nhello\nstate, echo and hello stay unchanged inside strings\n');
});
test('Lua parser rejects shortcut in multiline expression', { skip: !runtime }, () => {
    const translated = translate('local x =\nhello\n', profile);
    const result = spawnSync(runtime, ['-e', 'local f=load(io.read("*a")); if f then os.exit(0) else os.exit(1) end'], { input: translated, encoding: 'utf8' });
    assert.equal(result.status, 1);
});

test('JSONC supports both comment types and trailing commas', () => {
    assert.deepEqual(parseJSONC('\uFEFF// example\r\n{/*block*/"a":1,"list":[2,],}'), { a: 1, list: [2] });
});
test('JSONC preserves comment markers and commas inside strings', () => {
    const object = { url: 'https://luna.test/a//b', text: '/* hi */ ,} [1,]', quote: 'a"//b', slash: '\\' };
    assert.deepEqual(parseJSONC('// comment\n' + JSON.stringify(object)), object);
});
test('JSONC rejects unterminated comments and malformed JSON', () => {
    for (const source of ['{/* oops', '{"a":"oops', '{"a":undefined}', '{"a":1,,}', '{,}', '[,]'])
        assert.throws(() => parseJSONC(source));
});
test('Blank default leaves example names inactive', () => {
    const collection = readProfiles(path.join(root, 'profiles/default.jsonc'), validateProfile);
    const selected = selectProfile(collection);
    assert.equal(selected.id, 'profile1');
    assert.equal(selected.profile.template, true);
    const source = 'local echo = 1\nlocal hello = 2\nlocal state = 3\n';
    assert.equal(translate(source, selected.profile), source);
});
test('profile selection requires ID when more than one exists', () => {
    const collection = { one: copy(), two: copy() };
    assert.throws(() => selectProfile(collection), /Choose --profile-id/);
    assert.equal(selectProfile(collection, 'two').profile, collection.two);
    assert.throws(() => selectProfile(collection, 'absent'), /Unknown profile ID/);
});
test('metadata types are checked', () => {
    for (const [key, value] of [['name', 1], ['description', false], ['canBeEdited', 'false'], ['canBeDuplicated', 1], ['template', null]]) {
        const custom = copy(); custom[key] = value;
        assert.throws(() => validateProfile(custom), /must be/);
    }
});
test('disabled shortcuts do not reserve names or expand', () => {
    const custom = copy();
    custom.shortcuts.hello.enabled = false;
    assert.equal(translate('local hello = 1\nprint(hello)', custom), 'local hello = 1\nprint(hello)');
    assert.equal(translate('hello', custom), 'hello');
    custom.shortcuts.hello.enabled = 'false';
    assert.throws(() => validateProfile(custom), /enabled must be a boolean/);
});
test('omitted enabled means active for backwards compatibility', () => {
    const custom = copy(); delete custom.shortcuts.hello.enabled;
    assert.equal(translate('hello', custom), ';print("hello");');
});
test('duplicating Blank makes editable non-template copy without modifying original', () => {
    const blank = readProfiles(path.join(root, 'profiles/default.jsonc'), validateProfile);
    const result = duplicateProfile(blank, 'profile1', 'myProfile', 'Mine');
    assert.equal(result.myProfile.name, 'Mine');
    assert.equal(result.myProfile.canBeEdited, true);
    assert.equal(result.myProfile.template, false);
    assert.equal(blank.profile1.canBeEdited, false);
    assert.equal(blank.profile1.template, true);
    assert.equal(Object.hasOwn(blank, 'myProfile'), false);
    assert.throws(() => duplicateProfile(result, 'profile1', 'myProfile'), /already exists/);
    assert.throws(() => duplicateProfile({ example: profile }, 'example', 'copy'), /cannot be duplicated/);
});
test('single-profile JSON remains supported and JSON stays strict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-profiles-'));
    try {
        const filename = path.join(dir, 'profile.json');
        fs.writeFileSync(filename, JSON.stringify(copy()));
        assert.equal(selectProfile(readProfiles(filename, validateProfile)).id, 'default');
        fs.writeFileSync(filename, '// comment\n' + JSON.stringify(copy()));
        assert.throws(() => readProfiles(filename, validateProfile));
    } finally { removeTemporary(dir); }
});
test('profile files reject empty collections and invalid profiles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-profiles-'));
    try {
        const filename = path.join(dir, 'profiles.jsonc');
        for (const text of ['{}', '{"bad":null}', '{"p":{"version":2}}', '{"p":{"version":1,"typo":true}}']) {
            fs.writeFileSync(filename, text);
            assert.throws(() => readProfiles(filename, validateProfile));
        }
    } finally { removeTemporary(dir); }
});
test('CLI lists profiles, rejects wrong ID and duplicates to a new file', () => {
    const cli = path.join(root, 'tools/luna.mjs');
    const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const listed = invoke(['profiles']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].id, 'profile1');
    const wrong = invoke(['translate', path.join(root, 'examples/greet.ln'), '--profile-id', 'missing']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /Unknown profile ID/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-duplicate-'));
    try {
        const output = path.join(dir, 'mine.jsonc');
        const args = ['duplicate-profile', '--profile-id', 'profile1', '--new-id', 'mine', '--name', 'My profile', '--output', output];
        const made = invoke(args);
        assert.equal(made.status, 0, made.stderr);
        const created = readProfiles(output, validateProfile);
        assert.equal(created.mine.canBeEdited, true);
        assert.equal(created.mine.name, 'My profile');
        const original = fs.readFileSync(output, 'utf8');
        assert.equal(invoke(args).status, 1);
        assert.equal(fs.readFileSync(output, 'utf8'), original);
        const translated = invoke(['translate', path.join(root, 'examples/blank.ln'), '--profile', output, '--profile-id', 'mine']);
        assert.equal(translated.status, 0, translated.stderr);
        assert.match(translated.stdout, /print\(/);
    } finally { removeTemporary(dir); }
});
