import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const srcDir = path.join(root, 'src', 'functions')
const outDir = path.join(root, 'dist', 'functions')

const requiredAssets = ['search-queries.bundled.json', 'bing-search-activity-queries.json']

// Runtime data written by the control API. Copied only when present so a fresh
// checkout (where the file is gitignored and absent) still builds.
const runtimeAssets = ['search-queries.json']

fs.mkdirSync(outDir, { recursive: true })

for (const asset of requiredAssets) {
    const from = path.join(srcDir, asset)
    if (!fs.existsSync(from)) {
        throw new Error(`Required build asset is missing: ${from}`)
    }
    fs.copyFileSync(from, path.join(outDir, asset))
    console.log(`[info] Copied ${asset} -> dist/functions/`)
}

for (const asset of runtimeAssets) {
    const from = path.join(srcDir, asset)
    if (!fs.existsSync(from)) {
        console.log(`[info] Skipped ${asset} (no runtime data yet)`)
        continue
    }
    fs.copyFileSync(from, path.join(outDir, asset))
    console.log(`[info] Copied ${asset} -> dist/functions/`)
}
