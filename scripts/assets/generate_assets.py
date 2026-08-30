#!/usr/bin/env python3
"""Regenerate AgentDock desktop icons from the canonical application-icon SVG.

Optional maintainer tool. Requires Python 3.11+ and dependencies pinned in
``scripts/assets/requirements.txt``. It performs no network access.
"""

from __future__ import annotations

import io
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

import cairosvg
from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = PROJECT_ROOT / "apps" / "desktop" / "assets"
SOURCE = ASSET_ROOT / "brand" / "agent-dock-app-icon.svg"
ICON_ROOT = ASSET_ROOT / "app-icons"
PNG_ROOT = ICON_ROOT / "png"

PNG_SIZES = (16, 24, 32, 44, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))

BLOCKED_ELEMENTS = {
    "animate",
    "animatemotion",
    "animatetransform",
    "embed",
    "foreignobject",
    "iframe",
    "image",
    "object",
    "script",
    "set",
    "style",
    "use",
}
EXTERNAL_REFERENCE = re.compile(r"(?i)(?:https?|file|ftp):|data:|url\s*\(")
LOCAL_PATH = re.compile(r"(?i)(?:[a-z]:[\\/]|/(?:home|users|tmp)/)")
CSS_IMPORT = re.compile(r"(?i)@import\b")


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].lower()


def assert_safe_svg(svg: bytes, source: Path = SOURCE) -> None:
    """Reject source features that could resolve external or active content."""

    upper = svg.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper or b"<?XML-STYLESHEET" in upper:
        raise ValueError(f"Unsafe XML declaration in {source}")

    root = ET.fromstring(svg)
    if local_name(root.tag) != "svg":
        raise ValueError(f"Expected SVG root in {source}")

    for element in root.iter():
        element_name = local_name(element.tag)
        if element_name in BLOCKED_ELEMENTS:
            raise ValueError(f"Blocked <{element_name}> element in {source}")

        for text in (element.text, element.tail):
            if text and (
                EXTERNAL_REFERENCE.search(text)
                or LOCAL_PATH.search(text)
                or CSS_IMPORT.search(text)
            ):
                raise ValueError(f"Blocked external or local text reference in {source}")

        for raw_name, value in element.attrib.items():
            attribute_name = local_name(raw_name)
            normalized = str(value).strip()
            if attribute_name.startswith("on"):
                raise ValueError(f"Blocked event attribute {attribute_name} in {source}")
            if attribute_name in {"href", "src"} and not normalized.startswith("#"):
                raise ValueError(f"Blocked reference {attribute_name}={normalized!r} in {source}")
            if (
                EXTERNAL_REFERENCE.search(normalized)
                or LOCAL_PATH.search(normalized)
                or CSS_IMPORT.search(normalized)
            ):
                raise ValueError(f"Blocked external or local reference in {source}")


def rasterize(svg: bytes, size: int) -> Image.Image:
    rendered = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=size)
    with Image.open(io.BytesIO(rendered)) as image:
        return image.convert("RGBA")


def build_ico(png_root: Path) -> bytes:
    """Build an ICO whose frames come from the exact-size committed PNGs."""

    payloads: list[tuple[int, bytes]] = []
    for width, height in ICO_SIZES:
        if width != height:
            raise ValueError(f"ICO frame must be square: {(width, height)}")
        payloads.append((width, (png_root / f"icon-{width}.png").read_bytes()))

    header = struct.pack("<HHH", 0, 1, len(payloads))
    offset = len(header) + (16 * len(payloads))
    entries = bytearray()
    images = bytearray()

    for size, payload in payloads:
        encoded_size = 0 if size == 256 else size
        entries.extend(
            struct.pack(
                "<BBBBHHII",
                encoded_size,
                encoded_size,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        images.extend(payload)
        offset += len(payload)

    return header + bytes(entries) + bytes(images)


def main() -> None:
    svg = SOURCE.read_bytes()
    assert_safe_svg(svg)

    PNG_ROOT.mkdir(parents=True, exist_ok=True)
    images: dict[int, Image.Image] = {}
    try:
        for size in PNG_SIZES:
            image = rasterize(svg, size)
            images[size] = image
            image.save(PNG_ROOT / f"icon-{size}.png", format="PNG", optimize=True)

        (ICON_ROOT / "agent-dock.ico").write_bytes(build_ico(PNG_ROOT))
        images[1024].save(ICON_ROOT / "agent-dock.icns", format="ICNS")
    finally:
        for image in images.values():
            image.close()

    print(f"Generated {len(PNG_SIZES)} PNGs, ICO, and ICNS under {ICON_ROOT}")


if __name__ == "__main__":
    main()
