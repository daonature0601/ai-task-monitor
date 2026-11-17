#!/usr/bin/env node
/**
 * 生成应用图标 resources/icon.png（1024×1024）。
 * 图形与应用内左上角保持一致：青→紫渐变圆角方块 + 深色脉冲折线（lucide Activity）。
 * electron-builder 会据此派生 .icns / .ico。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const MARGIN = SIZE * 0.085
const RADIUS = SIZE * 0.225

// 与 tailwind 主题一致：accent-cyan #22D3EE → accent-violet #7C6BFF
const FROM = [34, 211, 238]
const TO = [124, 107, 255]
// 图标内线条颜色，与 UI 中 text-ink-950 一致
const INK = [10, 14, 20]

// lucide Activity：M22 12h-4l-3 9L9 3l-3 9H2（viewBox 24）
const GLYPH = [
  [22, 12],
  [18, 12],
  [15, 21],
  [9, 3],
  [6, 12],
  [2, 12]
]
const GLYPH_SCALE = SIZE * 0.0273
const CENTER = SIZE / 2
const STROKE = 2.3 * GLYPH_SCALE

let crcTable = null

function crc32(buffer) {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 点到线段的最短距离 */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

const points = GLYPH.map(([vx, vy]) => [CENTER + (vx - 12) * GLYPH_SCALE, CENTER + (vy - 12) * GLYPH_SCALE])

function glyphDistance(x, y) {
  let min = Infinity
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[i + 1]
    min = Math.min(min, distanceToSegment(x, y, x1, y1, x2, y2))
  }
  return min
}

/** 圆角矩形内部判定（带 1px 抗锯齿） */
function insideRounded(x, y) {
  const left = MARGIN
  const right = SIZE - MARGIN
  if (x < left - 1 || x > right + 1 || y < left - 1 || y > right + 1) return 0
  const ix = Math.min(x - left, right - x)
  const iy = Math.min(y - left, right - y)
  if (ix >= RADIUS || iy >= RADIUS) return 1
  const dx = RADIUS - ix
  const dy = RADIUS - iy
  const dist = Math.hypot(dx, dy)
  return Math.max(0, Math.min(1, RADIUS - dist + 0.5))
}

function paint(x, y) {
  const cover = insideRounded(x, y)
  if (cover <= 0) return [0, 0, 0, 0]

  // 沿对角线插值，形成 from-accent-cyan to-accent-violet 的渐变
  const t = Math.max(0, Math.min(1, (x + y) / (SIZE * 2)))
  let r = Math.round(FROM[0] + (TO[0] - FROM[0]) * t)
  let g = Math.round(FROM[1] + (TO[1] - FROM[1]) * t)
  let b = Math.round(FROM[2] + (TO[2] - FROM[2]) * t)

  // 脉冲折线：距离场描边，端点自然形成圆头
  const dist = glyphDistance(x, y)
  const stroke = Math.max(0, Math.min(1, STROKE / 2 - dist + 0.8))
  if (stroke > 0) {
    r = Math.round(r + (INK[0] - r) * stroke)
    g = Math.round(g + (INK[1] - g) * stroke)
    b = Math.round(b + (INK[2] - b) * stroke)
  }

  return [r, g, b, Math.round(255 * cover)]
}

function encodePng(size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = paint(x, y)
      const offset = y * stride + 1 + x * 4
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources')
mkdirSync(outDir, { recursive: true })
const target = join(outDir, 'icon.png')
writeFileSync(target, encodePng(SIZE))
console.log(`[icon] wrote ${target}`)
