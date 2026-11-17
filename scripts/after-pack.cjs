/**
 * 打包后裁剪语言包：只保留 en 与 zh_CN。
 *
 * 说明：electron-builder 的 `electronLanguages` 在 macOS 上并不会删除
 * `Electron Framework.framework/Resources/*.lproj`（每个目录内是 locale.pak），
 * 因此这里在 afterPack 阶段做一次显式清理，同时兼顾 Windows/Linux 的 locales/*.pak。
 */
const { promises: fsp } = require('node:fs')
const { join, basename } = require('node:path')

const KEEP = new Set(['en', 'zh_CN'])
const KEEP_PAK = new Set(['en.pak', 'zh_CN.pak'])

async function pruneLproj(root) {
  let removed = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.endsWith('.lproj')) {
        const locale = entry.name.slice(0, -'.lproj'.length)
        if (!KEEP.has(locale)) {
          await fsp.rm(full, { recursive: true, force: true })
          removed += 1
        }
        continue
      }
      stack.push(full)
    }
  }
  return removed
}

async function pruneLocalesPak(appOutDir) {
  let removed = 0
  const candidates = [
    join(appOutDir, 'locales'),
    join(appOutDir, 'Contents', 'Resources', 'locales')
  ]
  for (const dir of candidates) {
    let entries
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.pak')) continue
      if (KEEP_PAK.has(name)) continue
      await fsp.rm(join(dir, name), { force: true })
      removed += 1
    }
  }
  return removed
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const lprojRemoved = await pruneLproj(appOutDir)
  const pakRemoved = await pruneLocalesPak(appOutDir)
  console.log(
    `[after-pack] 语言包裁剪完成：移除 ${lprojRemoved} 个 *.lproj、${pakRemoved} 个 *.pak（保留 ${Array.from(KEEP).join(', ')}）`
  )
  console.log(`[after-pack] ${basename(appOutDir)}`)
}
