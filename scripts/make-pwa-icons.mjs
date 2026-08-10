/**
 * Derive the home-screen icons from the one master icon.
 *
 *   node scripts/make-pwa-icons.mjs
 *
 * Reads build/icon.png — the 1024px master electron-builder already uses for
 * the desktop app — and writes the four PNGs in src/renderer/public that a
 * phone needs. Committed output; this is run when the logo changes, not during
 * a build.
 *
 * ## Why a script rather than four hand-made files
 *
 * Because three of the four are not crops. They are derived by rules that have
 * to be right or the icon looks broken on a home screen, and a rule written
 * down is a rule somebody can re-apply when the logo changes:
 *
 *   · A MASKABLE icon is masked by the launcher to whatever shape that phone
 *     uses — circle, squircle, teardrop. Anything transparent becomes a black
 *     or white wedge, which is why the master's rounded corners have to be
 *     filled in before it can be used as one. Android also crops to the middle
 *     80%: this master's wordmark already sits inside that circle, so the fill
 *     is the whole of the work.
 *   · An APPLE TOUCH ICON is composited onto BLACK by iOS and then masked with
 *     Apple's own squircle. Ship one with an alpha channel and the rounded
 *     corners of the artwork show as a dark ring inside Apple's rounding —
 *     the "why does our icon look grubby" bug. So it is flattened here.
 *   · A NOTIFICATION BADGE is drawn by Android using the ALPHA CHANNEL ONLY,
 *     tinted by the system. Hand it a full-colour icon and the status bar
 *     shows a solid grey square. So the badge is keyed down to the wordmark
 *     itself: bright pixels become opaque, the blue field becomes transparent.
 *
 * ## Why it decodes and encodes PNG by hand
 *
 * There is no image library in this repository and adding one for four files
 * that change once a year is not a trade worth making. What is here is the
 * narrow case the master actually is — 8-bit RGBA, non-interlaced — and it
 * refuses anything else loudly rather than writing a corrupt icon.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'build/icon.png')
const OUT = join(ROOT, 'src/renderer/public')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(bytes) {
  let c = -1
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * The Paeth predictor, spelled out because every PNG filter but this one is
 * obvious and this one is the one people get subtly wrong.
 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.')
  let at = 8
  let header = null
  const idat = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12]
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  if (!header) throw new Error('No IHDR.')
  if (header.depth !== 8 || header.interlace !== 0 || (header.colorType !== 6 && header.colorType !== 2)) {
    throw new Error(
      `Only 8-bit non-interlaced RGB/RGBA is supported; this is depth ${header.depth}, ` +
        `colour type ${header.colorType}, interlace ${header.interlace}.`
    )
  }

  const channels = header.colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const out = new Uint8Array(header.width * header.height * 4)
  let previous = new Uint8Array(stride)
  let read = 0
  for (let y = 0; y < header.height; y++) {
    const filter = raw[read++]
    const line = Uint8Array.prototype.slice.call(raw, read, read + stride)
    read += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter} on row ${y}.`)
    }
    for (let x = 0; x < header.width; x++) {
      const to = (y * header.width + x) * 4
      const from = x * channels
      out[to] = line[from]
      out[to + 1] = line[from + 1]
      out[to + 2] = line[from + 2]
      out[to + 3] = channels === 4 ? line[from + 3] : 255
    }
    previous = line
  }
  return { width: header.width, height: header.height, data: out }
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * Encode, choosing a filter per row by the standard minimum-sum-of-absolute-
 * differences heuristic. Filter 0 everywhere would be correct and would also
 * triple the size of a gradient like this one, and these files are fetched by a
 * phone on a warehouse connection.
 *
 * An image with no transparent pixel anywhere is written WITHOUT an alpha
 * channel — colour type 2 rather than 6. That is not a size optimisation. The
 * maskable icon and the Apple touch icon must be opaque to be correct, and a
 * file that physically has no alpha channel cannot quietly stop being opaque
 * the next time somebody regenerates it from a logo with a soft edge. It also
 * makes the property assertable from the file header, which is what
 * tests/webPush.test.ts does.
 */
function encodePng({ width, height, data }) {
  let opaque = true
  for (let i = 3; i < data.length && opaque; i += 4) if (data[i] !== 255) opaque = false
  const channels = opaque ? 3 : 4
  const stride = width * channels

  // Drop the alpha plane when there is nothing in it to keep.
  let pixels = data
  if (opaque) {
    pixels = new Uint8Array(width * height * 3)
    for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
      pixels[q] = data[p]
      pixels[q + 1] = data[p + 1]
      pixels[q + 2] = data[p + 2]
    }
  }

  const rows = []
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * stride, (y + 1) * stride)
    let best = null
    for (let filter = 0; filter <= 4; filter++) {
      const candidate = new Uint8Array(stride)
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0
        const b = previous[i]
        const c = i >= channels ? previous[i - channels] : 0
        let value
        if (filter === 0) value = line[i]
        else if (filter === 1) value = line[i] - a
        else if (filter === 2) value = line[i] - b
        else if (filter === 3) value = line[i] - ((a + b) >> 1)
        else value = line[i] - paeth(a, b, c)
        candidate[i] = value & 0xff
        // Signed distance from zero: the heuristic from the PNG specification.
        score += candidate[i] < 128 ? candidate[i] : 256 - candidate[i]
      }
      if (!best || score < best.score) best = { filter, candidate, score }
    }
    rows.push(Buffer.concat([Buffer.from([best.filter]), Buffer.from(best.candidate)]))
    previous = line
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/**
 * Area-average downscale, on PREMULTIPLIED colour.
 *
 * Averaging straight RGBA blends the colour of fully transparent pixels into
 * their neighbours, which around the master's rounded corners means a grey
 * fringe on every icon derived from it. Premultiplying first is what makes the
 * transparent pixels contribute nothing.
 */
function resize(image, size) {
  const out = new Uint8Array(size * size * 4)
  const scale = image.width / size
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scale)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4
          const alpha = image.data[i + 3] / 255
          r += image.data[i] * alpha
          g += image.data[i + 1] * alpha
          b += image.data[i + 2] * alpha
          a += image.data[i + 3]
          n++
        }
      }
      const to = (y * size + x) * 4
      // Undo the premultiplication by the SUM of the alphas that went into it,
      // not by the count of pixels: dividing by n would scale every colour by
      // the number of samples and flatten the whole icon to white.
      const un = a > 0 ? 255 / a : 0
      out[to] = Math.round(Math.min(255, r * un))
      out[to + 1] = Math.round(Math.min(255, g * un))
      out[to + 2] = Math.round(Math.min(255, b * un))
      out[to + 3] = Math.round(a / n)
    }
  }
  return { width: size, height: size, data: out }
}

/**
 * Fill in whatever is transparent with the colour of the artwork at that HEIGHT.
 *
 * The master is a rounded square that reaches every edge, so the only
 * transparent pixels are its four corners, and the colour a corner "should"
 * have is the colour of the gradient on that row. Sampling the row rather than
 * inventing a flat background is what keeps the fill invisible — a solid colour
 * behind a vertical gradient shows as a band across the corners.
 */
function flatten(image) {
  const { width, height, data } = image
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    // The centre column is opaque on every row of a full-bleed rounded square.
    const seed = (y * width + (width >> 1)) * 4
    const br = data[seed]
    const bg = data[seed + 1]
    const bb = data[seed + 2]
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = data[i + 3] / 255
      out[i] = Math.round(data[i] * alpha + br * (1 - alpha))
      out[i + 1] = Math.round(data[i + 1] * alpha + bg * (1 - alpha))
      out[i + 2] = Math.round(data[i + 2] * alpha + bb * (1 - alpha))
      out[i + 3] = 255
    }
  }
  return { width, height, data: out }
}

/**
 * Keep the bright marks, throw away the field behind them.
 *
 * Android draws a notification badge from the alpha channel alone and tints it
 * white, so what matters is the SHAPE. The master is a white wordmark and a
 * gold rule on a blue field: luminance separates them cleanly (the field tops
 * out around 112, the rule sits at 184, the letters at 255), and the ramp
 * between the two thresholds keeps the letter edges smooth instead of jagged.
 */
const BADGE_FLOOR = 130
const BADGE_CEILING = 175

function keyToGlyph(image) {
  const out = new Uint8Array(image.data.length)
  for (let i = 0; i < image.data.length; i += 4) {
    const luma =
      0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]
    const t = Math.max(0, Math.min(1, (luma - BADGE_FLOOR) / (BADGE_CEILING - BADGE_FLOOR)))
    out[i] = 255
    out[i + 1] = 255
    out[i + 2] = 255
    out[i + 3] = Math.round(255 * t * (image.data[i + 3] / 255))
  }
  return { width: image.width, height: image.height, data: out }
}

// ---------------------------------------------------------------------------

const master = decodePng(readFileSync(SOURCE))
if (master.width !== master.height) throw new Error('The master icon must be square.')

const written = []
function write(name, image) {
  const bytes = encodePng(image)
  writeFileSync(join(OUT, name), bytes)
  written.push(`${name}  ${image.width}×${image.height}  ${(bytes.length / 1024).toFixed(1)} kB`)
}

// Ordinary icons: transparency kept, because a browser tab and a Chrome
// install both composite these onto their own background.
write('app-icon-192.png', resize(master, 192))
// Maskable and Apple: opaque, for the two reasons in the header comment.
write('app-icon-maskable-512.png', resize(flatten(master), 512))
write('apple-touch-icon-180.png', resize(flatten(master), 180))
// The badge: a shape, not a picture.
write('app-icon-badge-96.png', resize(keyToGlyph(master), 96))

console.log(`From ${SOURCE}:`)
for (const line of written) console.log('  ' + line)
console.log('\napp-icon-512.png is the existing master copy and is left alone.')
