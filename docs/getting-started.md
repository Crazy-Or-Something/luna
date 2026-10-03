# First Luna prototype

Requires Node.js and CMake plus a C compiler. On Windows, Visual Studio C++ tools can build the runtime.

From the repository root:

```powershell
cmake -S . -B build
cmake --build build --config Release
node tools/luna.mjs run examples/blank.ln
node tools/luna.mjs profiles
node tools/luna.mjs translate examples/greet.ln --profile profiles/example.jsonc --profile-id example
node tools/luna.mjs check examples/greet.ln --profile profiles/example.jsonc --profile-id example
node tools/luna.mjs run examples/greet.ln --profile profiles/example.jsonc --profile-id example
node --test tools/luna.test.mjs
```

The opt-in example prints:

```text
hello Red from Luna!
hello
state, echo and hello stay unchanged inside strings
```

## JSONC and profile collections

`profiles/default.jsonc` contains a commented usage example and one active profile, `profile1` (Blank).
Comments do not activate rules. Blank has no aliases or shortcuts.
JSONC accepts `//` comments, `/* ... */` comments, and trailing commas.
Comment markers inside quoted strings stay intact.
Files ending in `.json` use strict JSON for backwards compatibility.

A collection has profile IDs as its outer keys:

```jsonc
{
  "profile1": {
    "version": 1,
    "name": "Blank",
    "description": "This is a blank profile, used to start new ones",
    "canBeEdited": false,
    "canBeDuplicated": true,
    "template": true,
    "keywords": {},
    "functions": {},
    "shortcuts": {}
  }
}
```

Use `--profile file.jsonc` to choose a file and `--profile-id profile1` to choose a profile.
A file with one profile selects it automatically. Multiple profiles require an explicit ID.
The original single-profile format with `version` at the root still works; its ID is `default`.

## Create your own profile

```powershell
node tools/luna.mjs duplicate-profile --profile-id profile1 --new-id myProfile --name "My profile" --output profiles/my-profiles.jsonc
node tools/luna.mjs profiles --profile profiles/my-profiles.jsonc
```

The new collection contains Blank and your copy. The copy is editable and is no longer a template.
Edit `myProfile` in the new file, then run with:

```powershell
node tools/luna.mjs run examples/greet.ln --profile profiles/my-profiles.jsonc --profile-id myProfile
```

Add the example rules to your copy before running `greet.ln`.
Duplication respects `canBeDuplicated: false`, rejects duplicate IDs, and never overwrites an existing file.
It writes a new collection as formatted JSON (also valid JSONC); source comments are not copied.
`canBeEdited` and `template` describe editor behaviour for the future editor. They do not lock files on disk.
Omitted permissions default to editable and duplicable; omitted `template` defaults to false.

## Your naming table

- `keywords`: renamed Lua keywords, such as `state` for `function`.
- `functions`: direct function calls with parentheses, such as `echo(...)` for `print(...)`.
- `shortcuts`: a name with `expandsTo` containing one line of canonical Lua statements, an optional `description`, and optional `enabled`.

For example:

```jsonc
"hello": {
  "expandsTo": "print(\"hello\")",
  "description": "Prints hello to the console",
  "enabled": true
}
```

Set `enabled` to false to disable a shortcut without deleting it.
Disabled shortcuts don't reserve their names. Omitted `enabled` means true.
The flag currently applies to shortcuts; keyword and function aliases remain string mappings.

A shortcut must occupy its own line; indentation and a trailing comment are allowed.
It expands with semicolon delimiters, without declaring a function.
Strings, escaped strings, long strings, and comments retain their original text.
Explicit member accesses such as `object.echo()` retain their names.

Active custom names are reserved in bare code: don't use them as variable names or function parameters.
Keyword aliases behave as reserved keywords and Lua's parser checks the translated syntax.
Canonical spellings remain available. Alias chains and recursive shortcut expansions are rejected.
Translation is one pass; expansions must use canonical Lua names, not other shortcuts.

`translate` outputs source; `check` compiles it without executing; `run` executes it.
Use `--output file.lua` with `translate` to save the result.
Use `--lua path/to/lua.exe` to select another runtime.

## Current boundaries

This is a Node.js tooling prototype around our Lua source, not yet a native Luna CLI.
The runner executes trusted local code with Lua's normal libraries; sandboxing is not implemented.
Shortcuts are fixed statements, with no parameters yet.
Line breaks are preserved, but diagnostic columns refer to translated code.
Full scope analysis, Visual Luna, the editor, and the VS Code extension are still planned.
