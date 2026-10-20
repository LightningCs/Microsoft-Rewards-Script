import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    SUPPORTED_TYPES,
    cronMatches,
    fetchHotboard,
    getHotboardStatus,
    nextRunAt,
    readHotboardConfig,
    runHotboardRefresh,
    writeHotboardConfig,
    writeQueryList
} from './hotboardStore.js'

function createProject({ queries = [], dist = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-hotboard-'))
    const srcDir = path.join(root, 'src', 'functions')
    const srcFile = path.join(srcDir, 'search-queries.json')
    const distFile = path.join(root, 'dist', 'functions', 'search-queries.json')

    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(srcFile, `${JSON.stringify(queries, null, 4)}\n`)

    if (dist) {
        fs.mkdirSync(path.dirname(distFile), { recursive: true })
        fs.writeFileSync(distFile, `${JSON.stringify(queries, null, 4)}\n`)
    }

    return { root, srcFile, distFile, configFile: path.join(root, 'config', 'hotboard.json') }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function withFetch(stub, run) {
    const original = globalThis.fetch
    globalThis.fetch = stub
    try {
        return await run()
    } finally {
        globalThis.fetch = original
    }
}

function payload(titles, extra = {}) {
    return {
        type: 'baidu',
        update_time: '2026-10-19T01:58:00.000Z',
        list: titles.map((title, index) => ({ index: index + 1, title, url: `https://example.com/${index}` })),
        ...extra
    }
}

function jsonFetch(body, status = 200) {
    return async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })
}

test('cronMatches honours minute, hour, steps, ranges and Sunday aliases', () => {
    const at = iso => new Date(iso)

    assert.equal(cronMatches('0 6 * * *', at('2026-10-19T06:00:00Z'), 'UTC'), true)
    assert.equal(cronMatches('0 6 * * *', at('2026-10-19T06:01:00Z'), 'UTC'), false)
    assert.equal(cronMatches('*/15 * * * *', at('2026-10-19T06:15:00Z'), 'UTC'), true)
    assert.equal(cronMatches('*/15 * * * *', at('2026-10-19T06:10:00Z'), 'UTC'), false)
    assert.equal(cronMatches('0 9-17 * * *', at('2026-10-19T09:00:00Z'), 'UTC'), true)
    assert.equal(cronMatches('0 9-17 * * *', at('2026-10-19T08:00:00Z'), 'UTC'), false)
    assert.equal(cronMatches('0 6 1 1 *', at('2026-01-01T06:00:00Z'), 'UTC'), true)
    assert.equal(cronMatches('0 6 1 1 *', at('2026-02-01T06:00:00Z'), 'UTC'), false)

    // 2026-10-18 is a Sunday: both 0 and 7 must select it.
    assert.equal(cronMatches('0 6 * * 0', at('2026-10-18T06:00:00Z'), 'UTC'), true)
    assert.equal(cronMatches('0 6 * * 7', at('2026-10-18T06:00:00Z'), 'UTC'), true)
    assert.equal(cronMatches('0 6 * * 1', at('2026-10-18T06:00:00Z'), 'UTC'), false)

    assert.equal(cronMatches('not a cron', at('2026-10-19T06:00:00Z'), 'UTC'), false)
})

test('cronMatches evaluates the expression in the configured timezone', () => {
    const instant = new Date('2026-10-19T22:00:00Z')

    assert.equal(cronMatches('0 6 * * *', instant, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('0 6 * * *', instant, 'UTC'), false)
})

test('nextRunAt returns the next matching instant and null for impossible crons', () => {
    assert.equal(
        nextRunAt('0 6 * * *', { from: new Date('2026-10-19T03:00:00Z'), timeZone: 'UTC' }),
        '2026-10-19T06:00:00.000Z'
    )
    assert.equal(
        nextRunAt('0 6 * * *', { from: new Date('2026-10-19T03:00:00Z'), timeZone: 'Asia/Shanghai' }),
        '2026-10-19T22:00:00.000Z'
    )
    assert.equal(nextRunAt('broken', { from: new Date('2026-10-19T03:00:00Z'), timeZone: 'UTC' }), null)
})

test('falls back to environment defaults when no configuration file exists', () => {
    const { root, configFile } = createProject()

    const config = readHotboardConfig(root)

    assert.equal(config.enabled, true)
    assert.equal(config.cron, '0 6 * * *')
    assert.deepEqual(config.sources, ['https://uapis.cn/api/v1/misc/hotboard'])
    assert.equal(config.type, 'baidu')
    assert.equal(config.limit, 0)
    assert.equal(config.origin, 'env')
    assert.equal(config.path, configFile)
    assert.equal(fs.existsSync(configFile), false)
})

test('defaults split comma-separated HOTBOARD_SOURCES from the environment', () => {
    const { root } = createProject()
    const savedSources = process.env.HOTBOARD_SOURCES
    const savedSource = process.env.HOTBOARD_SOURCE
    try {
        delete process.env.HOTBOARD_SOURCES
        process.env.HOTBOARD_SOURCE = 'https://one.example, https://two.example/api, bad-url, https://one.example'
        const config = readHotboardConfig(root)
        assert.deepEqual(config.sources, ['https://one.example', 'https://two.example/api'])
    } finally {
        if (savedSources === undefined) delete process.env.HOTBOARD_SOURCES
        else process.env.HOTBOARD_SOURCES = savedSources
        if (savedSource === undefined) delete process.env.HOTBOARD_SOURCE
        else process.env.HOTBOARD_SOURCE = savedSource
    }
})

test('persists configuration changes and validates every field', () => {
    const { root, configFile } = createProject()

    const updated = writeHotboardConfig(root, { cron: '30 7 * * *', type: 'weibo', limit: 20 })

    assert.equal(updated.enabled, true)
    assert.equal(updated.cron, '30 7 * * *')
    assert.equal(updated.type, 'weibo')
    assert.equal(updated.limit, 20)
    assert.equal(updated.origin, 'override')
    assert.ok(updated.updatedAt)

    const saved = readJson(configFile)
    assert.equal(saved.cron, '30 7 * * *')
    assert.equal(saved.type, 'weibo')
    assert.equal(saved.limit, 20)
    assert.equal(readHotboardConfig(root).origin, 'override')

    assert.throws(
        () => writeHotboardConfig(root, { cron: '61 7 * * *' }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { sources: ['ftp://example.com'] }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { sources: [] }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { sources: 'not-an-array' }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { type: '' }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { limit: 501 }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.throws(
        () => writeHotboardConfig(root, { limit: 1.5 }),
        err => err.code === 'BAD_REQUEST'
    )
    assert.equal(readJson(configFile).cron, '30 7 * * *')
})

test('writeHotboardConfig accepts a sources array and a legacy single source', () => {
    const { root, configFile } = createProject()

    const multi = writeHotboardConfig(root, {
        sources: ['https://a.example/hotboard', 'https://a.example/hotboard', 'https://b.example/hotboard']
    })
    assert.deepEqual(multi.sources, ['https://a.example/hotboard', 'https://b.example/hotboard'])
    assert.equal(multi.source, 'https://a.example/hotboard')
    assert.deepEqual(readJson(configFile).sources, ['https://a.example/hotboard', 'https://b.example/hotboard'])

    const legacy = writeHotboardConfig(root, { source: 'https://legacy.example/hotboard' })
    assert.deepEqual(legacy.sources, ['https://legacy.example/hotboard'])
    assert.deepEqual(readJson(configFile).sources, ['https://legacy.example/hotboard'])
})

test('migrates a legacy single `source` entry in the config file to `sources`', () => {
    const { root, configFile } = createProject()
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(
        configFile,
        JSON.stringify({
            enabled: true,
            cron: '0 6 * * *',
            source: 'https://legacy.example/hotboard',
            type: 'baidu',
            limit: 0
        })
    )

    const config = readHotboardConfig(root)
    assert.deepEqual(config.sources, ['https://legacy.example/hotboard'])
})

test('reports a corrupt configuration file instead of crashing', () => {
    const { root, configFile } = createProject()
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, '{ not json')

    assert.throws(
        () => readHotboardConfig(root),
        err => err.code === 'CORRUPT_HOTBOARD'
    )
})

test('fetchHotboard extracts, normalizes, dedupes and truncates titles', async () => {
    const config = { sources: ['https://uapis.cn/api/v1/misc/hotboard'], type: 'baidu', limit: 2 }
    const body = payload(['  第一条  热搜 ', '第二条热搜', '第一条 热搜', 42, '第三条热搜'])

    const result = await withFetch(jsonFetch(body), () => fetchHotboard(config))

    assert.equal(result.ok, true)
    assert.equal(result.httpStatus, 200)
    assert.equal(result.upstreamUpdateTime, '2026-10-19T01:58:00.000Z')
    assert.deepEqual(result.titles, ['第一条 热搜', '第二条热搜'])
    assert.equal(result.usedSource, 'https://uapis.cn/api/v1/misc/hotboard')
    assert.deepEqual(result.failedSources, [])
    assert.equal(result.attempts.length, 1)
})

test('fetchHotboard surfaces upstream errors and malformed payloads', async () => {
    const config = { sources: ['https://uapis.cn/api/v1/misc/hotboard'], type: 'nope', limit: 0 }

    const upstreamError = await withFetch(jsonFetch({ code: 400, message: 'type is invalid' }, 400), () =>
        fetchHotboard(config)
    )
    assert.equal(upstreamError.ok, false)
    assert.equal(upstreamError.httpStatus, 400)
    assert.match(upstreamError.error, /type is invalid/)

    const noList = await withFetch(jsonFetch({ type: 'baidu' }), () => fetchHotboard(config))
    assert.equal(noList.ok, false)
    assert.match(noList.error, /no `list` array/)

    const notJson = await withFetch(
        async () => ({ ok: true, status: 200, text: async () => '<html>' }),
        () => fetchHotboard(config)
    )
    assert.equal(notJson.ok, false)
    assert.match(notJson.error, /non-JSON/)

    const rejected = await withFetch(
        async () => {
            throw new Error('getaddrinfo ENOTFOUND')
        },
        () => fetchHotboard(config)
    )
    assert.equal(rejected.ok, false)
    assert.equal(rejected.httpStatus, null)
    assert.match(rejected.error, /ENOTFOUND/)
})

test('fetchHotboard round-robins sources and falls back on failure', async () => {
    const good = 'https://good.example/hotboard'
    const bad = 'https://bad.example/hotboard'
    const config = { sources: [bad, good], type: 'baidu', limit: 0 }
    const calls = []
    const stub = async url => {
        calls.push(url)
        if (url.includes('bad.example')) return { ok: false, status: 500, text: async () => 'boom' }
        return jsonFetch(payload(['from good source']))(url)
    }

    const first = await withFetch(stub, () => fetchHotboard(config))
    assert.equal(first.ok, true)
    assert.equal(first.usedSource, good)
    assert.deepEqual(first.failedSources, [bad])
    assert.equal(first.attempts.length, 2)
    assert.equal(first.attempts[0].url, bad)
    assert.equal(first.attempts[1].url, good)
    assert.deepEqual(first.titles, ['from good source'])
    assert.deepEqual(calls, [`${bad}?type=baidu`, `${good}?type=baidu`])

    // rotation pointer advanced: the next refresh starts at `good` and succeeds immediately
    const second = await withFetch(stub, () => fetchHotboard(config))
    assert.equal(second.ok, true)
    assert.equal(second.usedSource, good)
    assert.deepEqual(calls.slice(2), [`${good}?type=baidu`])
})

test('fetchHotboard reports every failed source when all sources fail', async () => {
    const config = { sources: ['https://a.example/hotboard', 'https://b.example/hotboard'], type: 'baidu', limit: 0 }

    const result = await withFetch(
        async () => ({ ok: false, status: 503, text: async () => 'down' }),
        () => fetchHotboard(config)
    )

    assert.equal(result.ok, false)
    assert.equal(result.usedSource, null)
    assert.deepEqual(result.failedSources, ['https://a.example/hotboard', 'https://b.example/hotboard'])
    assert.equal(result.attempts.length, 2)
    assert.match(result.error, /Upstream responded 503/)
})

test('writeQueryList writes every existing copy with pretty JSON', () => {
    const { root, srcFile, distFile } = createProject({ queries: ['old'], dist: true })

    const result = writeQueryList(root, ['new one', 'new two'])

    assert.deepEqual(result.written, [srcFile, distFile])
    assert.deepEqual(readJson(srcFile), ['new one', 'new two'])
    assert.deepEqual(readJson(distFile), ['new one', 'new two'])
    assert.match(fs.readFileSync(srcFile, 'utf8'), /^\s{4}"new one"/m)
    assert.equal(fs.existsSync(`${srcFile}.bak`), true)
    assert.deepEqual(readJson(`${srcFile}.bak`), ['old'])
})

test('a successful refresh rewrites the query list and records the run', async () => {
    const { root, srcFile, configFile } = createProject({ queries: ['stale'] })

    const result = await withFetch(jsonFetch(payload(['热搜一', '热搜二'])), () =>
        runHotboardRefresh(root, { trigger: 'manual' })
    )

    assert.equal(result.ok, true)
    assert.equal(result.trigger, 'manual')
    assert.deepEqual(readJson(srcFile), ['热搜一', '热搜二'])
    assert.equal(result.lastRun.written, 1)

    const saved = readJson(configFile)
    assert.equal(saved.lastRun.ok, true)
    assert.equal(saved.lastRun.count, 2)
    assert.equal(saved.lastRun.trigger, 'manual')
    assert.equal(saved.lastRun.upstreamUpdateTime, '2026-10-19T01:58:00.000Z')
    assert.deepEqual(saved.lastRun.titles, ['热搜一', '热搜二'])
})

test('a failed refresh keeps the previous list and records the error', async () => {
    const { root, srcFile, configFile } = createProject({ queries: ['keep me'] })

    const result = await withFetch(jsonFetch({ code: 500, message: 'upstream exploded' }, 500), () =>
        runHotboardRefresh(root, { trigger: 'schedule' })
    )

    assert.equal(result.ok, false)
    assert.match(result.error, /upstream exploded/)
    assert.deepEqual(readJson(srcFile), ['keep me'])
    assert.equal(readJson(configFile).lastRun.ok, false)
    assert.match(readJson(configFile).lastRun.error, /upstream exploded/)
})

test('a dry run reads the upstream without touching the list or the state file', async () => {
    const { root, srcFile, configFile } = createProject({ queries: ['keep me'] })

    const result = await withFetch(jsonFetch(payload(['dry run title'])), () =>
        runHotboardRefresh(root, { trigger: 'manual', dryRun: true })
    )

    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.deepEqual(result.written, [])
    assert.deepEqual(readJson(srcFile), ['keep me'])
    assert.equal(fs.existsSync(configFile), false)
})

test('getHotboardStatus exposes schedule, source, query file and supported types', () => {
    const { root } = createProject({ queries: ['a', 'b'] })

    const status = getHotboardStatus(root)

    assert.equal(status.enabled, true)
    assert.equal(status.origin, 'env')
    assert.equal(typeof status.nextRunAt, 'string')
    assert.deepEqual(status.sources, ['https://uapis.cn/api/v1/misc/hotboard'])
    assert.equal(status.queryFile.count, 2)
    assert.deepEqual(status.supportedTypes, SUPPORTED_TYPES)
    assert.equal(status.limits.maxLimit, 500)
})
