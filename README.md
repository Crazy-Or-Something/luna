# Luna

sooo, i wanted to make a Roblox inspired platform with easier game creation, and now we're making a Lua fork ig

![lunaIcon](assets/icons/Luna_Icon.png)

Luna is the scripting language for that project. The idea is to give creators more control over how they build games, with customizable names, visual scripting, and tools that work together.

## Status

Very early development. A first JSON/JSONC-profile translator is working: keyword aliases, function aliases, and fixed shortcuts can be translated and tested with the local Lua runtime. Visual Luna, sandboxing, and editor integrations are still planned.

## Features and roadmap

### Local Renaming

Already used to `echo` instead of `print`? Prefer `state` instead of `function`? Make the language feel familiar to you.

You can customize function names and keywords through a local JSONC profile and translate them with the prototype CLI. Editor integration for testing and publishing is planned.

For example, with `print` renamed to `echo` and function renamed to `state`:

```ln
state greet(name)
    echo("hello " .. name ..  " from Luna!")
end
```

Would translate to:

```ln
function greet(name)
    print("hello " .. name ..  " from Luna!")
end
```

Your preferences belong to your editor. Other creators can use their own names while working on the same project.

The translator recognizes tokens rather than replacing every matching word: strings and comments stay intact, and conflicting uses of active custom names get reported.

### Profiles and JSONC

Keep multiple profiles in one `.jsonc` file, with `//` and `/* ... */` comments for examples and notes.

The default profile is **Blank**: no renaming or shortcuts are active. The commented example stays documentation, not defaults. [Example rules](profiles/example.jsonc) are opt-in.

Each profile has an ID, a visible `name`, a `description`, and `canBeEdited`, `canBeDuplicated`, and `template` metadata. The CLI can list profiles and duplicate Blank into an editable, non-template copy. Editor permissions are metadata for the future editor; they do not lock files on disk.

Shortcuts support `"enabled": false` to keep a rule without activating it.

```powershell
node tools/luna.mjs profiles
node tools/luna.mjs duplicate-profile --profile-id profile1 --new-id myProfile --name "My profile" --output profiles/my-profiles.jsonc
```

### Visual Luna

Build behaviors with visual blocks, inspired by Scratch and GameMaker, and see the Luna code they generate.

- `.ln` — Luna source code.
- `.vln` — Visual Luna files, including blocks, connections, positions, and settings.

Start with blocks, then move a behavior to code when you need more control. Converting arbitrary handwritten code back into blocks is outside the initial scope.

### VS Code integration

An official extension is planned so VS Code and the game editor can work with the same project files.

That includes shared naming profiles, autocomplete, diagnostics, and a way to launch a playtest from VS Code.

## Why?

Because sometimes you look at a creation tool and think: "i would LOVE it if this did that."

That's the starting point: make game creation easier, try ideas with creators, and use their feedback to decide what improves the experience.

## Lua foundation

Luna is based on [Lua](https://www.lua.org/). Lua's original copyright and license notices remain applicable to its code.

The custom engine, game editor, and platform are part of the wider project; this repository focuses on the language.

## Try the prototype

See [Getting started](docs/getting-started.md) for building the runtime and running examples.

```powershell
node tools/luna.mjs run examples/blank.ln
node tools/luna.mjs run examples/greet.ln --profile profiles/example.jsonc --profile-id example
```

Start from [Blank](profiles/default.jsonc) by duplicating it, or try [Example](profiles/example.jsonc) explicitly. Use `--profile` to choose a file and `--profile-id` to select a profile. If the file contains multiple profiles, selecting an ID is required. For example, the enabled `hello` shortcut expands to `print("hello")` without declaring a function.

This is a developer prototype for trusted local scripts. The runtime is not sandboxed yet.
