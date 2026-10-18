import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { addQueries, readQueries, removeQueries, replaceQueries } from './queryStore.js'

function createProject(queries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-queries-'))
    const file = path.join(root, 'src', 'functions', 'search-queries.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(queries, null, 4)}\n`)
    return { root, file, distFile: path.join(root, 'dist', 'functions', 'search-queries.json') }
}

function readFile(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('reads the list and reports duplicates without dropping entries', () => {
    const { root, file } = createProject(['a query', 'A  Query', 'second query'])

    const result = readQueries(root)

    assert.equal(result.path, file)
    assert.equal(result.total, 3)
    assert.equal(result.uniqueCount, 2)
    assert.deepEqual(result.duplicates, ['A Query'])
    assert.deepEqual(result.queries, ['a query', 'A  Query', 'second query'])
})

test('normalizes whitespace and reports removed duplicates when replacing', () => {
    const { root, file } = createProject(['old query'])

    const result = replaceQueries(root, ['  new   query ', 'new query', 'another one'])

    assert.deepEqual(readFile(file), ['new query', 'another one'])
    assert.equal(result.count, 2)
    assert.equal(result.previousCount, 1)
    assert.equal(result.duplicatesRemoved, 1)
})

test('writes the existing dist copy so a running build sees the change', () => {
    const { root, file, distFile } = createProject(['only query'])
    fs.mkdirSync(path.dirname(distFile), { recursive: true })
    fs.writeFileSync(distFile, `${JSON.stringify(['only query'], null, 4)}\n`)

    const result = addQueries(root, ['fresh query'])

    assert.deepEqual(readFile(file), ['only query', 'fresh query'])
    assert.deepEqual(readFile(distFile), ['only query', 'fresh query'])
    assert.deepEqual(result.written.sort(), [file, distFile].sort())
})

test('adds queries and skips case-insensitive duplicates', () => {
    const { root, file } = createProject(['cook rice'])

    const result = addQueries(root, ['Cook Rice', 'boil eggs'])

    assert.deepEqual(readFile(file), ['cook rice', 'boil eggs'])
    assert.deepEqual(result.added, ['boil eggs'])
    assert.deepEqual(result.skipped, ['Cook Rice'])
    assert.equal(result.count, 2)
})

test('removes queries by normalized text and reports the ones it could not find', () => {
    const { root, file } = createProject(['cook rice', 'boil eggs', 'brew coffee'])

    const result = removeQueries(root, ['Cook  Rice', 'missing query'])

    assert.deepEqual(readFile(file), ['boil eggs', 'brew coffee'])
    assert.deepEqual(result.removed, ['cook rice'])
    assert.deepEqual(result.notFound, ['missing query'])
    assert.equal(result.count, 2)
})

test('refuses to empty the list through remove', () => {
    const { root, file } = createProject(['cook rice'])

    assert.throws(
        () => removeQueries(root, ['cook rice']),
        err => err.code === 'BAD_REQUEST'
    )
    assert.deepEqual(readFile(file), ['cook rice'])
})

test('rejects empty replacements and non-string entries', () => {
    const { root, file } = createProject(['cook rice'])

    assert.throws(
        () => replaceQueries(root, []),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => replaceQueries(root, ['cook rice', 42]),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => addQueries(root, 'cook rice'),
        err => err.code === 'BAD_REQUEST'
    )
    assert.deepEqual(readFile(file), ['cook rice'])
})

test('reports a corrupt query list instead of throwing a parse error', () => {
    const { root, file } = createProject([])
    fs.writeFileSync(file, '{ not json')

    assert.throws(
        () => readQueries(root),
        err => err.code === 'CORRUPT_QUERY_LIST'
    )
})
