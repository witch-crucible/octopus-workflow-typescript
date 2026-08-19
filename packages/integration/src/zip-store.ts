/**
 * Minimal PKZIP reader/writer — enough for .oplx files.
 *
 * Only handles:
 * - Stored entries (compression method 0)
 * - Deflated entries (compression method 8) via Node built-in zlib
 * - No encryption, no split archives, no ZIP64
 *
 * The .oplx files we work with are small (~100 KB) and simple,
 * so this minimal implementation suffices.
 */

import { inflateRawSync, deflateRawSync } from "node:zlib"

// ── ZIP constants ──

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

const COMPRESSION_STORED = 0
const COMPRESSION_DEFLATED = 8

// ── Read ──

export interface ZipEntry {
  readonly name: string
  readonly data: Buffer
}

function readUint16LE(buf: Buffer, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8)
}

function readUint32LE(buf: Buffer, offset: number): number {
  return ((buf[offset] ?? 0)
    | ((buf[offset + 1] ?? 0) << 8)
    | ((buf[offset + 2] ?? 0) << 16)
    | ((buf[offset + 3] ?? 0) << 24)) >>> 0
}

/**
 * Parse a ZIP buffer into a Map of entry name → uncompressed data.
 * Throws on invalid ZIP structure or unsupported compression.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()

  // Scan for local file headers
  let offset = 0
  while (offset + 30 <= buf.length) {
    if (readUint32LE(buf, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      break
    }

    const compressionMethod = readUint16LE(buf, offset + 8)
    const compressedSize = readUint32LE(buf, offset + 18)
    const uncompressedSize = readUint32LE(buf, offset + 22)
    const nameLength = readUint16LE(buf, offset + 26)
    const extraLength = readUint16LE(buf, offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const name = buf.toString("utf-8", nameStart, nameStart + nameLength)

    const compressedData = buf.subarray(dataStart, dataStart + compressedSize)

    let data: Buffer
    if (compressionMethod === COMPRESSION_STORED) {
      if (compressedSize !== uncompressedSize) {
        throw new Error(`ZIP entry "${name}": stored size mismatch`)
      }
      data = Buffer.from(compressedData)
    } else if (compressionMethod === COMPRESSION_DEFLATED) {
      data = inflateRawSync(compressedData)
      if (data.length !== uncompressedSize) {
        throw new Error(`ZIP entry "${name}": inflated size mismatch`)
      }
    } else {
      throw new Error(`ZIP entry "${name}": unsupported compression method ${compressionMethod}`)
    }

    entries.set(name, data)
    offset = dataStart + compressedSize
  }

  return entries
}

// ── Write ──

function writeUint16LE(buf: Buffer, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

function writeUint32LE(buf: Buffer, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

export interface ZipWriteEntry {
  readonly name: string
  readonly data: Buffer
}

interface PartWithOffset {
  name: string
  data: Buffer
  compressedData: Buffer
  method: number
  crc32: number
  offset: number
}

/**
 * Write a minimal ZIP buffer from the given entries.
 * Uses STORED compression (simpler, no external deps, sufficient for XML/PNG).
 */
export function writeZip(entries: ZipWriteEntry[]): Buffer {
  // First pass: compute compressed data (stored = identity)
  const parts: PartWithOffset[] = []

  for (const entry of entries) {
    // Use STORED for simplicity
    parts.push({
      name: entry.name,
      data: entry.data,
      compressedData: entry.data,
      method: COMPRESSION_STORED,
      crc32: crc32(entry.data),
      offset: 0,
    })
  }

  // Compute offsets
  const localHeaders: Buffer[] = []
  let offset = 0

  for (const part of parts) {
    const nameBytes = Buffer.from(part.name, "utf-8")
    const localHeader = Buffer.alloc(30 + nameBytes.length)

    writeUint32LE(localHeader, 0, LOCAL_FILE_HEADER_SIGNATURE)
    writeUint16LE(localHeader, 4, 20) // version needed
    writeUint16LE(localHeader, 6, 0) // flags
    writeUint16LE(localHeader, 8, part.method)
    writeUint16LE(localHeader, 10, 0) // mod time
    writeUint16LE(localHeader, 12, 0) // mod date
    writeUint32LE(localHeader, 14, part.crc32)
    writeUint32LE(localHeader, 18, part.compressedData.length)
    writeUint32LE(localHeader, 22, part.data.length)
    writeUint16LE(localHeader, 26, nameBytes.length)
    writeUint16LE(localHeader, 28, 0) // extra length
    nameBytes.copy(localHeader, 30)

    localHeaders.push(localHeader)
    part.offset = offset
    offset += localHeader.length + part.compressedData.length
  }

  // Second pass: build central directory
  const centralDirBuffers: Buffer[] = []
  let centralDirOffset = offset

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const nameBytes = Buffer.from(part.name, "utf-8")
    const centralEntry = Buffer.alloc(46 + nameBytes.length)

    writeUint32LE(centralEntry, 0, CENTRAL_DIRECTORY_SIGNATURE)
    writeUint16LE(centralEntry, 4, 20) // version made by
    writeUint16LE(centralEntry, 6, 20) // version needed
    writeUint16LE(centralEntry, 8, 0) // flags
    writeUint16LE(centralEntry, 10, part.method)
    writeUint16LE(centralEntry, 12, 0) // mod time
    writeUint16LE(centralEntry, 14, 0) // mod date
    writeUint32LE(centralEntry, 16, part.crc32)
    writeUint32LE(centralEntry, 20, part.compressedData.length)
    writeUint32LE(centralEntry, 24, part.data.length)
    writeUint16LE(centralEntry, 28, nameBytes.length)
    writeUint16LE(centralEntry, 30, 0) // extra length
    writeUint16LE(centralEntry, 32, 0) // comment length
    writeUint16LE(centralEntry, 34, 0) // disk number start
    writeUint16LE(centralEntry, 36, 0) // internal attrs
    writeUint32LE(centralEntry, 38, 0) // external attrs
    writeUint32LE(centralEntry, 42, part.offset)
    nameBytes.copy(centralEntry, 46)

    centralDirBuffers.push(centralEntry)
  }

  const centralDirSize = centralDirBuffers.reduce((sum, buf) => sum + buf.length, 0)

  // End of central directory
  const eocd = Buffer.alloc(22)
  writeUint32LE(eocd, 0, END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  writeUint16LE(eocd, 4, 0) // disk number
  writeUint16LE(eocd, 6, 0) // disk with central dir
  writeUint16LE(eocd, 8, parts.length) // entries on this disk
  writeUint16LE(eocd, 10, parts.length) // total entries
  writeUint32LE(eocd, 12, centralDirSize)
  writeUint32LE(eocd, 16, centralDirOffset)
  writeUint16LE(eocd, 20, 0) // comment length

  return Buffer.concat([
    ...localHeaders.map((h, i) => {
      const part = parts[i]
      if (!part) return h
      return Buffer.concat([h, part.compressedData])
    }),
    ...centralDirBuffers,
    eocd,
  ])
}

// ── CRC32 ──

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1)
    } else {
      c = c >>> 1
    }
  }
  CRC_TABLE[i] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
