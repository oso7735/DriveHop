#!/usr/bin/env python3
"""Build DriveHop's deterministic, per-file LZ4 installer archive."""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

import lz4.block


MAGIC = b"DHIPACK1"
HEADER = struct.Struct("<8sII")
ENTRY = struct.Struct("<HHQQI")
FLAG_STORED = 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"missing app directory: {source}")

    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not files:
        raise SystemExit("refusing to create an empty installer")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("wb") as archive:
        archive.write(HEADER.pack(MAGIC, 1, len(files)))
        raw_total = packed_total = 0
        for path in files:
            relative = path.relative_to(source).as_posix().encode("utf-8")
            if len(relative) > 1023:
                raise SystemExit(f"installer path is too long: {relative!r}")
            raw = path.read_bytes()
            packed = lz4.block.compress(raw, mode="high_compression", compression=9, store_size=False) if raw else b""
            flags = 0
            if len(packed) >= len(raw):
                packed = raw
                flags = FLAG_STORED
            archive.write(ENTRY.pack(len(relative), flags, len(raw), len(packed), zlib.crc32(raw) & 0xFFFFFFFF))
            archive.write(relative)
            archive.write(packed)
            raw_total += len(raw)
            packed_total += len(packed)
    temporary.replace(args.output)
    print(f"Packed {len(files)} files: {raw_total} -> {packed_total} bytes")


if __name__ == "__main__":
    main()
