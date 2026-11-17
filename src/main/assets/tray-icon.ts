import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'

let crcTable: number[] | null = null

function crc32(buffer: Buffer): number {
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

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

type Pixel = [number, number, number, number]

/** 极简 PNG 编码器（RGBA8），避免为图标引入二进制资源与额外依赖 */
function encodePng(size: number, painter: (x: number, y: number) => Pixel): Buffer {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = painter(x, y)
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
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 生成托盘图标：外圈进度环 + 中心点。
 * active=true 时在右下角叠加青色活动点（非 template，保留颜色）。
 */
export function createTrayIcon(active: boolean, scale = 2): NativeImage {
  const size = 16 * scale
  const center = (size - 1) / 2
  const outer = size * 0.42
  const inner = size * 0.28

  const buffer = encodePng(size, (x, y) => {
    const dx = x - center
    const dy = y - center
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (active) {
      // 青色活动点位于右下
      const adx = x - size * 0.74
      const ady = y - size * 0.74
      if (Math.sqrt(adx * adx + ady * ady) <= size * 0.15) return [34, 211, 238, 255]
    }

    if (dist <= outer && dist >= inner) {
      // 环上做 12 点方向的缺口，形成"计时器"观感
      const angle = Math.atan2(dy, dx)
      const gap = Math.abs(angle + Math.PI / 2) < 0.35
      if (!gap) return active ? [34, 211, 238, 255] : [0, 0, 0, 255]
    }
    if (dist < inner * 0.45) return active ? [34, 211, 238, 255] : [0, 0, 0, 255]
    return [0, 0, 0, 0]
  })

  const image = nativeImage.createFromBuffer(buffer, { scaleFactor: scale })
  image.setTemplateImage(!active)
  return image
}
