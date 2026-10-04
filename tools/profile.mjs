import fs from 'node:fs';

const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Replace comments with spaces so parse errors retain original positions.
// Strings are copied unchanged, including URLs and escaped quotes.
export function parseJSONC(text) {
    const chars = text.replace(/^\uFEFF/, ' ').split('');
    let i = 0;
    const skipString = () => {
        const start = i;
        i++;
        while (i < chars.length) {
            if (chars[i] === '\\') { i += 2; continue; }
            if (chars[i++] === '"') return;
        }
        throw Object.assign(new Error('Unterminated JSONC string'), { position: start });
    };
    while (i < chars.length) {
        if (chars[i] === '"') { skipString(); continue; }
        if (chars[i] === '/' && chars[i + 1] === '/') {
            chars[i++] = ' '; chars[i++] = ' ';
            while (i < chars.length && !/[\r\n]/.test(chars[i])) chars[i++] = ' ';
        } else if (chars[i] === '/' && chars[i + 1] === '*') {
            const start = i;
            chars[i++] = ' '; chars[i++] = ' ';
            let closed = false;
            while (i < chars.length) {
                if (chars[i] === '*' && chars[i + 1] === '/') {
                    chars[i++] = ' '; chars[i++] = ' '; closed = true; break;
                }
                if (!/[\r\n]/.test(chars[i])) chars[i] = ' ';
                i++;
            }
            if (!closed) throw Object.assign(new Error('Unterminated JSONC block comment'), { position: start });
        } else i++;
    }
    // JSONC profiles also accept a trailing comma before a closing bracket.
    i = 0;
    while (i < chars.length) {
        if (chars[i] === '"') { skipString(); continue; }
        if (chars[i] === ',') {
            let next = i + 1;
            while (next < chars.length && /\s/.test(chars[next])) next++;
            let previous = i - 1;
            while (previous >= 0 && /\s/.test(chars[previous])) previous--;
            if ((chars[next] === '}' || chars[next] === ']') && previous >= 0 &&
                !['{', '[', ',', ':'].includes(chars[previous])) chars[i] = ' ';
        }
        i++;
    }
    return JSON.parse(chars.join(''));
}

export function validateMetadata(profile) {
    for (const key of ['name', 'description']) {
        if (own(profile, key) && typeof profile[key] !== 'string')
            throw new Error(key + ' must be a string');
    }
    for (const key of ['canBeEdited', 'canBeDuplicated', 'template']) {
        if (own(profile, key) && typeof profile[key] !== 'boolean')
            throw new Error(key + ' must be a boolean');
    }
}

export function readProfiles(filename, validate) {
    const text = fs.readFileSync(filename, 'utf8');
    // .json stays strict; only .jsonc enables comments and trailing commas.
    let document;
    try {
        document = filename.toLowerCase().endsWith('.jsonc') ? parseJSONC(text) : JSON.parse(text.replace(/^\uFEFF/, ' '));
    } catch (error) {
        const position = error.position ?? Number(/position (\d+)/i.exec(error.message)?.[1]);
        if (Number.isInteger(position)) {
            const before = text.slice(0, position);
            error.line = before.split(/\r\n|\r|\n/).length;
            error.column = position - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
            error.start = position;
            error.end = Math.min(text.length, position + 1);
        }
        error.file = filename;
        throw error;
    }
    if (!record(document)) throw new Error('Profiles file must be an object');
    const collection = own(document, 'version') ? { default: document } : document;
    if (Object.keys(collection).length === 0) throw new Error('Profiles collection is empty');
    for (const [id, profile] of Object.entries(collection)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) throw new Error('Invalid profile ID: ' + id);
        if (!record(profile)) throw new Error('Profile "' + id + '" must be an object');
        try { validate(profile); }
        catch (error) { throw new Error('Profile "' + id + '": ' + error.message); }
    }
    return collection;
}

export function selectProfile(collection, id) {
    if (!id) {
        const ids = Object.keys(collection);
        if (ids.length !== 1)
            throw new Error('Choose --profile-id. Available profiles: ' + ids.join(', '));
        id = ids[0];
    }
    if (!own(collection, id)) throw new Error('Unknown profile ID "' + id + '". Available profiles: ' + Object.keys(collection).join(', '));
    return { id, profile: collection[id] };
}

export function duplicateProfile(collection, id, newId, name) {
    const { profile } = selectProfile(collection, id);
    if (profile.canBeDuplicated === false) throw new Error('Profile "' + id + '" cannot be duplicated');
    if (!newId || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(newId)) throw new Error('A valid --new-id is required');
    if (own(collection, newId)) throw new Error('Profile ID already exists: ' + newId);
    const copy = structuredClone(profile);
    copy.name = name ?? ((profile.name ?? id) + ' copy');
    copy.canBeEdited = true;
    copy.template = false;
    return { ...collection, [newId]: copy };
}
