import fs from 'node:fs'
import path from 'node:path'

const QUERY_FILE = path.join('functions', 'search-queries.json')
const MAX_QUERY_LENGTH = 200
const MAX_QUERIES = 20000

function normalizeQuery(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null
}

function queryKey(value) {
    return normalizeQuery(value)?.toLowerCase() ?? ''
}

function hasControlCharacters(value) {
    return [...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

function sourcePath(projectRoot) {
    return path.join(projectRoot, 'src', QUERY_FILE)
}

function builtPath(projectRoot) {
    return path.join(projectRoot, 'dist', QUERY_FILE)
}

function normalizeList(entries, label = 'queries') {
    if (!Array.isArray(entries)) {
        throw Object.assign(new Error(`\`${label}\` must be an array of query strings.`), { code: 'BAD_REQUEST' })
    }
    if (entries.length > MAX_QUERIES) {
        throw Object.assign(new Error(`\`${label}\` may contain at most ${MAX_QUERIES} queries.`), {
            code: 'BAD_REQUEST'
        })
    }

    const queries = []

    for (const [index, entry] of entries.entries()) {
        const query = normalizeQuery(entry)
        if (!query) {
            throw Object.assign(new Error(`\`${label}[${index}]\` must be a non-empty string.`), {
                code: 'BAD_REQUEST'
            })
        }
        if (query.length > MAX_QUERY_LENGTH) {
            throw Object.assign(new Error(`\`${label}[${index}]\` exceeds ${MAX_QUERY_LENGTH} characters.`), {
                code: 'BAD_REQUEST'
            })
        }
        if (hasControlCharacters(query)) {
            throw Object.assign(new Error(`\`${label}[${index}]\` contains control characters.`), {
                code: 'BAD_REQUEST'
            })
        }
        queries.push(query)
    }

    return { queries }
}

function dedupe(queries) {
    const seen = new Set()
    const unique = []
    const duplicates = []

    for (const query of queries) {
        const key = queryKey(query)
        if (seen.has(key)) {
            duplicates.push(query)
            continue
        }
        seen.add(key)
        unique.push(query)
    }

    return { unique, duplicates }
}

export function resolveQueryFile(projectRoot) {
    const candidates = [sourcePath(projectRoot), builtPath(projectRoot)]
    return candidates.find(file => fs.existsSync(file)) ?? candidates[0]
}

export function resolveQueryMirrors(projectRoot) {
    return [sourcePath(projectRoot), builtPath(projectRoot)].filter(file => fs.existsSync(file))
}

function readQueryFile(file) {
    if (!fs.existsSync(file)) {
        throw Object.assign(new Error(`Query list not found at ${file}.`), { code: 'QUERY_FILE_MISSING' })
    }
    let parsed
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
        throw Object.assign(new Error(`search-queries.json is corrupt: ${err.message}`), {
            code: 'CORRUPT_QUERY_LIST'
        })
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
        throw Object.assign(new Error('search-queries.json must be a JSON array of strings.'), {
            code: 'CORRUPT_QUERY_LIST'
        })
    }
    return parsed
}

function writeQueryFile(file, queries) {
    if (fs.existsSync(file)) {
        try {
            fs.copyFileSync(file, `${file}.bak`)
        } catch {
            // best-effort backup
        }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(queries, null, 4)}\n`)
    fs.renameSync(tmp, file)
}

function mirrorStatus(projectRoot, primary, queries) {
    return resolveQueryMirrors(projectRoot)
        .filter(file => path.resolve(file) !== path.resolve(primary))
        .map(file => {
            let inSync = false
            try {
                inSync = JSON.stringify(readQueryFile(file)) === JSON.stringify(queries)
            } catch {}
            return { path: file, inSync }
        })
}

export function readQueries(projectRoot) {
    const file = resolveQueryFile(projectRoot)
    const queries = readQueryFile(file)
    const { unique, duplicates } = dedupe(queries.map(query => normalizeQuery(query) ?? ''))

    return {
        path: file,
        mirrors: mirrorStatus(projectRoot, file, queries),
        total: queries.length,
        uniqueCount: unique.length,
        duplicates,
        queries
    }
}

export function persistQueries(projectRoot, queries) {
    const primary = resolveQueryFile(projectRoot)
    const targets = [primary]

    for (const file of resolveQueryMirrors(projectRoot)) {
        if (!targets.some(target => path.resolve(target) === path.resolve(file))) targets.push(file)
    }

    for (const file of targets) writeQueryFile(file, queries)

    return { path: primary, written: targets }
}

export function replaceQueries(projectRoot, entries) {
    const { queries } = normalizeList(entries)
    if (!queries.length) {
        throw Object.assign(new Error('The query list must contain at least one query.'), { code: 'BAD_REQUEST' })
    }

    const { unique, duplicates } = dedupe(queries)
    const previous = readQueryFile(resolveQueryFile(projectRoot))
    const persisted = persistQueries(projectRoot, unique)

    return {
        ...persisted,
        count: unique.length,
        previousCount: previous.length,
        duplicatesRemoved: duplicates.length,
        duplicates
    }
}

export function addQueries(projectRoot, entries) {
    const { queries: candidates } = normalizeList(entries, 'add')
    if (!candidates.length) {
        throw Object.assign(new Error('`add` must contain at least one query.'), { code: 'BAD_REQUEST' })
    }

    const current = readQueryFile(resolveQueryFile(projectRoot))
    const keys = new Set(current.map(queryKey))
    const added = []
    const skipped = []

    for (const query of candidates) {
        const key = queryKey(query)
        if (keys.has(key)) {
            skipped.push(query)
            continue
        }
        keys.add(key)
        added.push(query)
    }

    if (added.length) persistQueries(projectRoot, [...current, ...added])

    return {
        path: resolveQueryFile(projectRoot),
        written: added.length ? resolveQueryMirrors(projectRoot) : [],
        count: current.length + added.length,
        previousCount: current.length,
        added,
        skipped
    }
}

export function removeQueries(projectRoot, entries) {
    const { queries: candidates } = normalizeList(entries, 'remove')
    if (!candidates.length) {
        throw Object.assign(new Error('`remove` must contain at least one query.'), { code: 'BAD_REQUEST' })
    }

    const current = readQueryFile(resolveQueryFile(projectRoot))
    const removalKeys = new Set(candidates.map(queryKey))
    const removed = current.filter(query => removalKeys.has(queryKey(query)))
    const remaining = current.filter(query => !removalKeys.has(queryKey(query)))
    const removedKeys = new Set(removed.map(queryKey))
    const notFound = candidates.filter(query => !removedKeys.has(queryKey(query)))

    if (!removed.length) {
        return {
            path: resolveQueryFile(projectRoot),
            written: [],
            count: current.length,
            previousCount: current.length,
            removed: [],
            notFound
        }
    }

    if (!remaining.length) {
        throw Object.assign(new Error('Removing these queries would empty the list. Use PUT /queries instead.'), {
            code: 'BAD_REQUEST'
        })
    }

    const persisted = persistQueries(projectRoot, remaining)

    return {
        ...persisted,
        count: remaining.length,
        previousCount: current.length,
        removed,
        notFound
    }
}
