import fs from 'node:fs'
import path from 'node:path'

import { isValidCron } from './scheduleStore.js'

const QUERY_FILE = 'search-queries.json'
const DEFAULT_SOURCE = 'https://uapis.cn/api/v1/misc/hotboard'
const DEFAULT_CRON = '0 6 * * *'
const DEFAULT_TYPE = 'baidu'
const SUPPORTED_TYPES = ['baidu', 'weibo', 'zhihu', 'douyin', 'bilibili', 'toutiao']
const MAX_LIMIT = 500
const MAX_TITLES_IN_STATE = 100
const MAX_MESSAGE_LENGTH = 300
const FETCH_TIMEOUT_MS = 15_000
const SCHEDULER_INTERVAL_MS = 20_000
const MAX_SCAN_MINUTES = 7 * 24 * 60
const TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i

const CRON_FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 6 } // day of week (0 == Sunday)
]

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map()

function timezone() {
    return process.env.TZ || 'UTC'
}

function fail(code, message) {
    throw Object.assign(new Error(message), { code })
}

function clampMessage(value) {
    const text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text
}

export function hotboardFilePath(projectRoot) {
    return process.env.HOTBOARD_FILE || path.join(projectRoot, 'config', 'hotboard.json')
}

function defaultsFromEnv() {
    const limit = Number(process.env.HOTBOARD_LIMIT ?? 0)
    return {
        enabled: true,
        cron: (process.env.HOTBOARD_CRON || DEFAULT_CRON).trim(),
        source: (process.env.HOTBOARD_SOURCE || DEFAULT_SOURCE).trim(),
        type: (process.env.HOTBOARD_TYPE || DEFAULT_TYPE).trim(),
        limit: Number.isSafeInteger(limit) ? limit : 0
    }
}

function isValidSource(value) {
    if (typeof value !== 'string' || !value.trim()) return false
    try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
        return false
    }
}

function validateValues(values, code) {
    if (typeof values.enabled !== 'boolean') fail(code, '`enabled` must be a boolean.')
    if (typeof values.cron !== 'string' || !isValidCron(values.cron)) {
        fail(code, '`cron` must be a five-field cron expression, such as "0 6 * * *".')
    }
    if (!isValidSource(values.source)) fail(code, '`source` must be an absolute http(s) URL.')
    if (typeof values.type !== 'string' || !TYPE_PATTERN.test(values.type.trim())) {
        fail(code, '`type` must be a source identifier such as "baidu".')
    }
    if (!Number.isSafeInteger(values.limit) || values.limit < 0 || values.limit > MAX_LIMIT) {
        fail(code, `\`limit\` must be an integer between 0 and ${MAX_LIMIT}.`)
    }
}

function normalizeLastRun(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const titles = Array.isArray(value.titles)
        ? value.titles.filter(title => typeof title === 'string').slice(0, MAX_TITLES_IN_STATE)
        : []

    return {
        at: typeof value.at === 'string' ? value.at : null,
        ok: value.ok === true,
        trigger: typeof value.trigger === 'string' ? value.trigger : 'schedule',
        httpStatus: Number.isSafeInteger(value.httpStatus) ? value.httpStatus : null,
        durationMs: Number.isSafeInteger(value.durationMs) ? value.durationMs : null,
        count: Number.isSafeInteger(value.count) ? value.count : 0,
        written: Number.isSafeInteger(value.written) ? value.written : 0,
        upstreamUpdateTime: typeof value.upstreamUpdateTime === 'string' ? value.upstreamUpdateTime : null,
        error: typeof value.error === 'string' ? value.error : null,
        titles
    }
}

export function readHotboardConfig(projectRoot) {
    const file = hotboardFilePath(projectRoot)
    const base = defaultsFromEnv()

    if (!fs.existsSync(file)) {
        return { ...base, timezone: timezone(), updatedAt: null, lastRun: null, path: file, origin: 'env' }
    }

    let saved
    try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
        fail('CORRUPT_HOTBOARD', `hotboard.json is corrupt: ${err.message}`)
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        fail('CORRUPT_HOTBOARD', 'hotboard.json must contain a JSON object.')
    }

    const values = {
        enabled: saved.enabled === undefined ? base.enabled : saved.enabled,
        cron: saved.cron === undefined ? base.cron : saved.cron,
        source: saved.source === undefined ? base.source : saved.source,
        type: saved.type === undefined ? base.type : saved.type,
        limit: saved.limit === undefined ? base.limit : saved.limit
    }
    validateValues(values, 'CORRUPT_HOTBOARD')

    return {
        ...values,
        timezone: timezone(),
        updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
        lastRun: normalizeLastRun(saved.lastRun),
        path: file,
        origin: 'override'
    }
}

function persistConfigFile(projectRoot, values) {
    const file = hotboardFilePath(projectRoot)
    if (fs.existsSync(file)) {
        try {
            fs.copyFileSync(file, `${file}.bak`)
        } catch {
            // best-effort backup
        }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(values, null, 4)}\n`)
    fs.renameSync(tmp, file)
    return file
}

export function writeHotboardConfig(projectRoot, patch) {
    const current = readHotboardConfig(projectRoot)
    const next = {
        enabled: current.enabled,
        cron: current.cron,
        source: current.source,
        type: current.type,
        limit: current.limit
    }

    for (const key of ['enabled', 'cron', 'source', 'type', 'limit']) {
        if (key in patch) next[key] = patch[key]
    }

    if (typeof next.cron === 'string') next.cron = next.cron.trim()
    if (typeof next.source === 'string') next.source = next.source.trim()
    if (typeof next.type === 'string') next.type = next.type.trim()
    if ('limit' in patch) {
        const limit = Number(patch.limit)
        if (!Number.isSafeInteger(limit)) fail('BAD_REQUEST', '`limit` must be an integer between 0 and 500.')
        next.limit = limit
    }

    validateValues(next, 'BAD_REQUEST')

    const updatedAt = new Date().toISOString()
    persistConfigFile(projectRoot, { ...next, updatedAt, lastRun: current.lastRun })

    return {
        ...next,
        timezone: current.timezone,
        updatedAt,
        lastRun: current.lastRun,
        path: current.path,
        origin: 'override'
    }
}

export function recordLastRun(projectRoot, lastRun) {
    const current = readHotboardConfig(projectRoot)
    persistConfigFile(projectRoot, {
        enabled: current.enabled,
        cron: current.cron,
        source: current.source,
        type: current.type,
        limit: current.limit,
        updatedAt: current.updatedAt,
        lastRun: normalizeLastRun(lastRun)
    })
}

function activeQueryFileTargets(projectRoot) {
    const targets = []
    for (const dir of ['src', 'dist']) {
        const functions = path.join(projectRoot, dir, 'functions')
        if (fs.existsSync(functions)) targets.push(path.join(functions, QUERY_FILE))
    }
    if (!targets.length) targets.push(path.join(projectRoot, 'src', 'functions', QUERY_FILE))
    return targets
}

export function readActiveQueryList(projectRoot) {
    const file = activeQueryFileTargets(projectRoot)[0]
    if (!fs.existsSync(file)) return { path: file, count: 0, updatedAt: null }

    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        const count = Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item.trim()).length : 0
        return { path: file, count, updatedAt: fs.statSync(file).mtime.toISOString() }
    } catch {
        return { path: file, count: 0, updatedAt: null }
    }
}

export function writeQueryList(projectRoot, titles) {
    const targets = activeQueryFileTargets(projectRoot)
    const body = `${JSON.stringify(titles, null, 4)}\n`

    for (const file of targets) {
        if (fs.existsSync(file)) {
            try {
                fs.copyFileSync(file, `${file}.bak`)
            } catch {
                // best-effort backup
            }
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, body)
        fs.renameSync(tmp, file)
    }

    return { path: targets[0], written: targets, count: titles.length }
}

function buildSourceUrl(config) {
    const url = new URL(config.source)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail('BAD_REQUEST', '`source` must be an absolute http(s) URL.')
    }
    if (config.type) url.searchParams.set('type', config.type)
    return url.toString()
}

function normalizeTitles(list, limit) {
    const seen = new Set()
    const titles = []

    for (const item of list) {
        const raw = item && typeof item === 'object' ? item.title : undefined
        const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
        if (!title) continue

        const key = title.toLowerCase()
        if (seen.has(key)) continue

        seen.add(key)
        titles.push(title)
        if (limit > 0 && titles.length >= limit) break
    }

    return titles
}

function describeUpstreamFailure(status, text) {
    let message = ''
    try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
            message = typeof parsed.message === 'string' ? parsed.message : ''
        }
    } catch {
        message = ''
    }
    const detail = clampMessage(message)
    return detail ? `Upstream responded ${status}: ${detail}` : `Upstream responded ${status}.`
}

export async function fetchHotboard(config) {
    const started = Date.now()
    let url
    try {
        url = buildSourceUrl(config)
    } catch (err) {
        return {
            ok: false,
            httpStatus: null,
            titles: [],
            upstreamUpdateTime: null,
            durationMs: 0,
            error: clampMessage(err instanceof Error ? err.message : err)
        }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'user-agent': 'microsoft-rewards-script-control-api' }
        })
        const text = await response.text()
        const durationMs = Date.now() - started

        if (!response.ok) {
            return {
                ok: false,
                httpStatus: response.status,
                titles: [],
                upstreamUpdateTime: null,
                durationMs,
                error: describeUpstreamFailure(response.status, text)
            }
        }

        let payload
        try {
            payload = JSON.parse(text)
        } catch {
            return {
                ok: false,
                httpStatus: response.status,
                titles: [],
                upstreamUpdateTime: null,
                durationMs,
                error: 'Upstream returned a non-JSON body.'
            }
        }

        const list = payload && Array.isArray(payload.list) ? payload.list : null
        if (!list) {
            return {
                ok: false,
                httpStatus: response.status,
                titles: [],
                upstreamUpdateTime: null,
                durationMs,
                error: 'Upstream response has no `list` array.'
            }
        }

        const titles = normalizeTitles(list, config.limit)
        if (!titles.length) {
            return {
                ok: false,
                httpStatus: response.status,
                titles: [],
                upstreamUpdateTime: null,
                durationMs,
                error: 'Upstream list contained no usable titles.'
            }
        }

        return {
            ok: true,
            httpStatus: response.status,
            titles,
            upstreamUpdateTime: typeof payload.update_time === 'string' ? payload.update_time : null,
            durationMs,
            error: null
        }
    } catch (err) {
        const durationMs = Date.now() - started
        const aborted = err instanceof Error && err.name === 'AbortError'
        return {
            ok: false,
            httpStatus: null,
            titles: [],
            upstreamUpdateTime: null,
            durationMs,
            error: aborted
                ? `Request timed out after ${FETCH_TIMEOUT_MS}ms.`
                : `Request failed: ${clampMessage(err instanceof Error ? err.message : err)}`
        }
    } finally {
        clearTimeout(timer)
    }
}

export async function runHotboardRefresh(projectRoot, { trigger = 'manual', dryRun = false } = {}) {
    const config = readHotboardConfig(projectRoot)
    const result = await fetchHotboard(config)

    let written = []
    let ok = result.ok
    let error = result.error

    if (result.ok && !dryRun) {
        try {
            written = writeQueryList(projectRoot, result.titles).written
        } catch (err) {
            ok = false
            error = `Fetched ${result.titles.length} hot titles but writing ${QUERY_FILE} failed: ${
                err instanceof Error ? err.message : err
            }`
            written = []
        }
    }

    const lastRun = {
        at: new Date().toISOString(),
        trigger,
        ok,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        count: result.titles.length,
        written: written.length,
        upstreamUpdateTime: result.upstreamUpdateTime,
        error,
        titles: result.titles.slice(0, MAX_TITLES_IN_STATE)
    }

    if (!dryRun) {
        try {
            recordLastRun(projectRoot, lastRun)
        } catch {
            // the refresh result still matters even when the state file cannot be written
        }
    }

    return {
        ok,
        error,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        upstreamUpdateTime: result.upstreamUpdateTime,
        titles: result.titles,
        written,
        dryRun,
        trigger,
        lastRun
    }
}

function getFormatter(timeZone) {
    let formatter = formatters.get(timeZone)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            weekday: 'short',
            hour: 'numeric',
            minute: 'numeric'
        })
        formatters.set(timeZone, formatter)
    }
    return formatter
}

function localParts(date, timeZone) {
    const parts = getFormatter(timeZone).formatToParts(date)
    const read = type => parts.find(part => part.type === type)?.value ?? ''

    return {
        year: Number(read('year')),
        month: Number(read('month')),
        day: Number(read('day')),
        hour: Number(read('hour')),
        minute: Number(read('minute')),
        weekday: WEEKDAYS[read('weekday')] ?? 0
    }
}

function localMinuteKey(date, timeZone) {
    const parts = localParts(date, timeZone)
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function fieldMatches(expr, value, { min, max, alias }) {
    for (const part of String(expr).split(',')) {
        const [range, stepRaw] = part.split('/')
        const step = stepRaw === undefined ? 1 : Number(stepRaw)
        if (!Number.isSafeInteger(step) || step < 1) continue

        let lo
        let hi
        if (range === '*') {
            lo = min
            hi = max
        } else if (range?.includes('-')) {
            const [start, end] = range.split('-')
            lo = Number(start)
            hi = Number(end)
        } else {
            lo = Number(range)
            hi = lo
        }

        for (const candidate of alias === undefined ? [value] : [value, alias]) {
            if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) continue
            if (candidate < lo || candidate > hi) continue
            if ((candidate - lo) % step === 0) return true
        }
    }
    return false
}

export function cronMatches(cron, date = new Date(), timeZone = timezone()) {
    if (!isValidCron(cron)) return false

    const fields = String(cron).trim().split(/\s+/)
    const now = localParts(date, timeZone)

    return (
        fieldMatches(fields[0], now.minute, CRON_FIELD_RANGES[0]) &&
        fieldMatches(fields[1], now.hour, CRON_FIELD_RANGES[1]) &&
        fieldMatches(fields[2], now.day, CRON_FIELD_RANGES[2]) &&
        fieldMatches(fields[3], now.month, CRON_FIELD_RANGES[3]) &&
        fieldMatches(fields[4], now.weekday, { ...CRON_FIELD_RANGES[4], alias: now.weekday === 0 ? 7 : undefined })
    )
}

export function nextRunAt(cron, { from = new Date(), timeZone = timezone() } = {}) {
    if (!isValidCron(cron)) return null

    const start = new Date(from.getTime())
    start.setSeconds(0, 0)

    for (let minutes = 1; minutes <= MAX_SCAN_MINUTES; minutes++) {
        const candidate = new Date(start.getTime() + minutes * 60_000)
        if (cronMatches(cron, candidate, timeZone)) return candidate.toISOString()
    }

    return null
}

export function getHotboardStatus(projectRoot) {
    const config = readHotboardConfig(projectRoot)

    return {
        ...config,
        nextRunAt: config.enabled ? nextRunAt(config.cron, { timeZone: config.timezone }) : null,
        queryFile: readActiveQueryList(projectRoot),
        supportedTypes: SUPPORTED_TYPES,
        limits: { maxLimit: MAX_LIMIT, maxTitlesInState: MAX_TITLES_IN_STATE }
    }
}

export function createHotboardScheduler(projectRoot, { log = () => {}, intervalMs = SCHEDULER_INTERVAL_MS } = {}) {
    let timer = null
    let lastMinuteKey = null
    let running = false
    let corruptLogged = false
    let warmupAttempted = false

    async function refresh(trigger) {
        running = true
        try {
            const result = await runHotboardRefresh(projectRoot, { trigger })
            if (result.ok) {
                log(
                    'info',
                    `Hot board refreshed (${trigger}): ${result.titles.length} titles written to ${result.written.length} file(s).`
                )
            } else {
                log('warn', `Hot board refresh failed (${trigger}): ${result.error}`)
            }
            return result
        } catch (err) {
            log('error', `Hot board refresh failed (${trigger}): ${err instanceof Error ? err.message : err}`)
            return null
        } finally {
            running = false
        }
    }

    async function tick() {
        if (running) return

        let config
        try {
            config = readHotboardConfig(projectRoot)
            corruptLogged = false
        } catch (err) {
            if (!corruptLogged) {
                corruptLogged = true
                log('warn', `Hot board configuration is unusable: ${err instanceof Error ? err.message : err}`)
            }
            return
        }

        if (!config.enabled) return

        if (!warmupAttempted) {
            warmupAttempted = true
            if (readActiveQueryList(projectRoot).count === 0) {
                await refresh('startup')
                return
            }
        }

        const now = new Date()
        const key = localMinuteKey(now, config.timezone)
        if (key === lastMinuteKey) return
        lastMinuteKey = key

        if (!cronMatches(config.cron, now, config.timezone)) return
        await refresh('schedule')
    }

    return {
        start() {
            if (timer) return
            timer = setInterval(() => void tick(), intervalMs)
            if (typeof timer.unref === 'function') timer.unref()
            void tick()
        },
        stop() {
            if (!timer) return
            clearInterval(timer)
            timer = null
        },
        reload() {
            lastMinuteKey = null
        },
        status() {
            return { running, intervalMs }
        }
    }
}

export { DEFAULT_CRON, DEFAULT_SOURCE, DEFAULT_TYPE, MAX_LIMIT, SUPPORTED_TYPES, QUERY_FILE }
