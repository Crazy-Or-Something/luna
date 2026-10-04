import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translate, validateProfile, diagnosticFor } from './luna.mjs';
const profile = { version: 1, functions: { echo: 'print' }, keywords: { state: 'function' }, shortcuts: {
    say: { parameters: ['message'], expandsTo: 'print(${message})' },
    pair: { parameters: ['a', 'b'], expandsTo: 'print(${a}, ${b})' },
    twice: { parameters: ['value'], expandsTo: 'print(${value}, ${value})' },
    nothing: { parameters: [], expandsTo: 'print("ok")' }
} };
const runtime = fileURLToPath(new URL('../build/Release/lua.exe', import.meta.url));
function run(source) {
    const result = spawnSync(runtime, ['-e', 'assert(load(io.read("*a")))()'], {input: translate(source, profile), encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replaceAll('\r\n', '\n');
}
test('parameter shortcuts capture arguments and keep trailing comments', () => {
    const output = translate('  say("hello") -- hi\r\n', profile);
    assert.match(output, /local __luna_arg_0 = \("hello"\); print\(__luna_arg_0\)/);
    assert.ok(output.endsWith(' -- hi\r\n'));
    assert.match(translate('nothing()', profile), /;do print\("ok"\); end;/);
});
test('literal placeholders inside strings remain unchanged', () => {
    const custom = {version:1,shortcuts:{literal:{parameters:['x'],expandsTo:'print("${x}", ${x})'}}};
    assert.match(translate('literal(1)', custom), /print\("\$\{x\}", __luna_arg_0\)/);
});
test('nested tables calls and commas inside strings are arguments', {skip:!fs.existsSync(runtime)}, () => {
    assert.equal(run('pair(({key="a,b"}).key, math.max(1, 2))'), 'a,b\t2\n');
    assert.equal(run('pair([=[x,y]=], ({3,4})[2])'), 'x,y\t4\n');
});
test('arguments run exactly once left to right and do not expand multiple returns', {skip:!fs.existsSync(runtime)}, () => {
    assert.equal(run('local n=0\nfunction nextValue() n=n+1; return n, 999 end\ntwice(nextValue())\npair(nextValue(), nextValue())\nprint(n)'), '1\t1\n2\t3\n3\n');
});
test('generated local names do not shadow source or template identifiers', {skip:!fs.existsSync(runtime)}, () => {
    assert.equal(run('local __luna_arg_0 = 8\nsay(__luna_arg_0)\nprint(__luna_arg_0)'), '8\n8\n');
    const custom = {version:1,shortcuts:{say:{parameters:['x'],expandsTo:'print(${x}, __luna_arg_0)'}}};
    assert.match(translate('say(1)', custom), /local __luna_arg_1/);
});
test('aliases inside arguments translate; member names and strings stay literal', () => {
    const text = translate('say(echo("echo"))', profile);
    assert.match(text, /\(print\("echo"\)\)/);
    assert.equal(translate('obj.say(1)\nprint("say(1)")', profile), 'obj.say(1)\nprint("say(1)")');
});
test('rejects invalid parameter definitions and unresolved placeholders', () => {
    for (const parameters of [null, 'x', ['x','x'], ['function'], ['1x'], [false]]) {
        assert.throws(() => validateProfile({version:1,shortcuts:{say:{parameters,expandsTo:'print(1)'}}}), /parameters/);
    }
    for (const expandsTo of ['print(${absent})', 'print($ {x})', 'print(${x )']) {
        assert.throws(() => validateProfile({version:1,shortcuts:{say:{parameters:['x'],expandsTo}}}));
    }
    assert.throws(() => validateProfile({version:1,shortcuts:{say:{expandsTo:'print(${x})'}}}), /Unknown shortcut parameter/);
});
test('rejects wrong arity malformed calls and expression use', () => {
    for (const source of ['say', 'say()', 'say(1,2)', 'say(,1)', 'say(1,)', 'say({])', 'say(1', 'local x=say(1)', 'say(\n1)', 'say(function() return 1,2 end)', 'say(state() return 1 end)']) {
        assert.throws(() => translate(source, profile), undefined, source);
    }
});
test('disabled parameter shortcuts remain ordinary names', () => {
    const custom = structuredClone(profile); custom.shortcuts.say.enabled = false;
    assert.equal(translate('local say = print\nsay(1)', custom), 'local say = print\nsay(1)');
});
test('errors include original UTF-16 offsets line and column', () => {
    try { translate('-- 😀\r\n  local echo = 1', profile); assert.fail('expected conflict'); }
    catch (error) {
        const diagnostic = diagnosticFor(error);
        assert.equal(diagnostic.line, 2);
        assert.equal(diagnostic.column, 9);
        assert.equal(diagnostic.end - diagnostic.start, 4);
    }
    assert.throws(() => translate('print(1)\n  say("oops)', profile), error => error.line === 2 && error.column === 7);
});
test('CLI JSON diagnostics handle profile selection and invalid format', () => {
    const cli = fileURLToPath(new URL('./luna.mjs', import.meta.url));
    const example = fileURLToPath(new URL('../examples/greet.ln', import.meta.url));
    const bad = spawnSync(process.execPath, [cli,'translate',example,'--profile-id','missing','--diagnostics','json'], {encoding:'utf8'});
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stderr).diagnostics[0].message, /Unknown profile ID/);
    const malformed = spawnSync(process.execPath, [cli,'translate',example,'--diagnostics','yaml'], {encoding:'utf8'});
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /must be json/);
});

test('CLI diagnostics provide source positions and Lua lines without corrupting JSON', {skip:!fs.existsSync(runtime)}, async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-diagnostics-'));
    const input = path.join(dir, 'test.ln');
    const profileFile = path.join(dir, 'test.jsonc');
    const cli = fileURLToPath(new URL('./luna.mjs', import.meta.url));
    const invoke = command => spawnSync(process.execPath, [cli,command,input,'--profile',profileFile,'--profile-id','p','--diagnostics','json'], {encoding:'utf8'});
    try {
        fs.writeFileSync(profileFile, JSON.stringify({p:profile}));
        fs.writeFileSync(input, 'print(1)\n  local echo = 1');
        const translation = invoke('translate');
        assert.equal(translation.status, 1);
        const first = JSON.parse(translation.stderr).diagnostics[0];
        assert.equal(first.line, 2); assert.equal(first.column, 9); assert.equal(first.file, input);
        fs.writeFileSync(input, 'print(1)\nlocal =');
        const checked = invoke('check');
        assert.equal(checked.status, 1);
        assert.equal(JSON.parse(checked.stderr).diagnostics[0].line, 2);
        assert.equal(checked.stdout, '');
        fs.writeFileSync(input, 'error("runtime failure")');
        const runtimeError = invoke('run');
        assert.equal(runtimeError.status, 1);
        assert.match(JSON.parse(runtimeError.stderr).diagnostics[0].message, /runtime failure/);
        fs.writeFileSync(profileFile, '// 😀\n/* unfinished');
        const malformed = invoke('translate');
        const diagnostic = JSON.parse(malformed.stderr).diagnostics[0];
        assert.equal(diagnostic.file, profileFile);
        assert.equal(diagnostic.line, 2); assert.equal(diagnostic.column, 1);
    } finally {
        if (fs.existsSync(input)) fs.unlinkSync(input);
        if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
        fs.rmdirSync(dir);
    }
});
