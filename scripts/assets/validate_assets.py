#!/usr/bin/env python3
"""Validate committed AgentDock desktop, documentation, and social assets."""

from __future__ import annotations

import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ASSETS = PROJECT_ROOT / "apps" / "desktop" / "assets"
BRAND_ROOT = DESKTOP_ASSETS / "brand"
ICON_ROOT = DESKTOP_ASSETS / "app-icons"
PNG_ROOT = ICON_ROOT / "png"
ILLUSTRATION_ROOT = DESKTOP_ASSETS / "illustrations"
IMAGE_ROOT = PROJECT_ROOT / "docs" / "images"
ARCHITECTURE_ROOT = IMAGE_ROOT / "architecture"
ARTWORK_ROOT = IMAGE_ROOT / "artwork"
SCREENSHOT_ROOT = IMAGE_ROOT / "screenshots"
SOCIAL_ROOT = IMAGE_ROOT / "social"

PNG_SIZES = (16, 24, 32, 44, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)}
ICNS_REPRESENTATIONS = {
    (512, 512, 2),
    (512, 512, 1),
    (256, 256, 2),
    (256, 256, 1),
    (128, 128, 2),
    (128, 128, 1),
    (32, 32, 2),
    (16, 16, 2),
}

BRAND_VIEWBOXES = {
    "agent-dock-app-icon.svg": "0 0 1024 1024",
    "agent-dock-lockup-horizontal-dark.svg": "0 0 640 128",
    "agent-dock-lockup-horizontal-light.svg": "0 0 640 128",
    "agent-dock-lockup-stacked-dark.svg": "0 0 420 260",
    "agent-dock-lockup-stacked-light.svg": "0 0 420 260",
    "agent-dock-mark-dark.svg": "0 0 64 64",
    "agent-dock-mark-light.svg": "0 0 64 64",
    "agent-dock-mark.svg": "0 0 64 64",
}
ILLUSTRATION_VIEWBOXES = {
    "empty-events.svg": "0 0 160 160",
    "empty-prompt.svg": "0 0 160 160",
    "empty-session.svg": "0 0 160 160",
    "empty-working-directory.svg": "0 0 160 160",
    "no-providers.svg": "0 0 160 160",
    "provider-unavailable.svg": "0 0 160 160",
    "runtime-unavailable.svg": "0 0 160 160",
}
ARCHITECTURE_VIEWBOXES = {"runtime-flow.svg": "0 0 1400 440"}
PUBLIC_IMAGES = {
    ARTWORK_ROOT / "agent-dock-runtime.png": ((1536, 1024), "PNG"),
    SCREENSHOT_ROOT / "desktop-ready.png": ((1440, 900), "PNG"),
    SCREENSHOT_ROOT / "desktop-dark.png": ((1440, 900), "PNG"),
    SCREENSHOT_ROOT / "session-running.png": ((1440, 900), "PNG"),
    SCREENSHOT_ROOT / "session-completed.png": ((1440, 900), "PNG"),
    SCREENSHOT_ROOT / "daemon-unavailable.png": ((1440, 900), "PNG"),
    SOCIAL_ROOT / "readme-hero.webp": ((1440, 900), "WEBP"),
    SOCIAL_ROOT / "github-social-preview.png": ((1280, 640), "PNG"),
    SOCIAL_ROOT / "open-graph.png": ((1200, 630), "PNG"),
    SOCIAL_ROOT / "portfolio-project.png": ((1440, 900), "PNG"),
    SOCIAL_ROOT / "asset-system-preview.png": ((1600, 1040), "PNG"),
    SOCIAL_ROOT / "icon-size-preview.png": ((1180, 430), "PNG"),
}

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
SENSITIVE_INFO_KEYS = {
    "author",
    "comment",
    "copyright",
    "description",
    "exif",
    "icc_profile",
    "parameters",
    "software",
    "xmp",
    "xml:com.adobe.xmp",
}
PNG_METADATA_CHUNKS = {b"eXIf", b"iCCP", b"iTXt", b"tEXt", b"zTXt"}
WEBP_METADATA_CHUNKS = {b"EXIF", b"ICCP", b"XMP "}
FORBIDDEN_BYTE_PATTERNS = {
    "API key prefix": re.compile(
        rb"(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})"
    ),
    "Bearer credential": re.compile(rb"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    "email address": re.compile(rb"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    "Windows user path": re.compile(rb"(?i)\b[A-Z]:[\\/]Users[\\/]"),
    "project-local path": re.compile(rb"(?i)\bD:[\\/]Projects[\\/]"),
    "Unix home path": re.compile(rb"(?i)/home/"),
}

ERRORS: list[str] = []


def relative(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def check(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].lower()


def check_exact_files(directory: Path, expected: set[str]) -> None:
    if not directory.is_dir():
        ERRORS.append(f"Missing directory: {relative(directory)}")
        return

    actual = {path.name for path in directory.iterdir() if path.is_file()}
    for name in sorted(expected - actual):
        ERRORS.append(f"Missing file: {relative(directory / name)}")
    for name in sorted(actual - expected):
        ERRORS.append(f"Unexpected file: {relative(directory / name)}")


def validate_svg(path: Path, expected_viewbox: str) -> None:
    try:
        raw = path.read_bytes()
    except OSError as error:
        ERRORS.append(f"Cannot read {relative(path)}: {error}")
        return

    upper = raw.upper()
    check(
        b"<!DOCTYPE" not in upper
        and b"<!ENTITY" not in upper
        and b"<?XML-STYLESHEET" not in upper,
        f"Unsafe XML declaration: {relative(path)}",
    )

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        ERRORS.append(f"Malformed SVG {relative(path)}: {error}")
        return

    check(local_name(root.tag) == "svg", f"Wrong root element: {relative(path)}")
    actual_viewbox = " ".join(root.attrib.get("viewBox", "").split())
    check(
        actual_viewbox == expected_viewbox,
        f"Wrong viewBox for {relative(path)}: {actual_viewbox!r}",
    )

    for element in root.iter():
        element_name = local_name(element.tag)
        check(
            element_name not in BLOCKED_ELEMENTS,
            f"Blocked <{element_name}> element: {relative(path)}",
        )

        for text in (element.text, element.tail):
            if text:
                check(
                    EXTERNAL_REFERENCE.search(text) is None
                    and LOCAL_PATH.search(text) is None
                    and CSS_IMPORT.search(text) is None,
                    f"External or local text reference in {relative(path)}",
                )

        for raw_name, value in element.attrib.items():
            attribute_name = local_name(raw_name)
            normalized = str(value).strip()
            check(
                not attribute_name.startswith("on"),
                f"Event attribute {attribute_name}: {relative(path)}",
            )
            if attribute_name in {"href", "src"}:
                check(
                    normalized.startswith("#"),
                    f"External reference {attribute_name}={normalized!r}: {relative(path)}",
                )
            check(
                EXTERNAL_REFERENCE.search(normalized) is None
                and LOCAL_PATH.search(normalized) is None
                and CSS_IMPORT.search(normalized) is None,
                f"External or local path in {relative(path)}",
            )


def validate_forbidden_bytes(path: Path) -> None:
    try:
        data = path.read_bytes()
    except OSError as error:
        ERRORS.append(f"Cannot read {relative(path)}: {error}")
        return

    for label, pattern in FORBIDDEN_BYTE_PATTERNS.items():
        check(pattern.search(data) is None, f"Forbidden {label}: {relative(path)}")


def validate_png_chunks(path: Path, data: bytes) -> None:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        ERRORS.append(f"Invalid PNG signature: {relative(path)}")
        return

    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if end > len(data):
            ERRORS.append(f"Truncated PNG chunk: {relative(path)}")
            return
        check(
            chunk_type not in PNG_METADATA_CHUNKS,
            f"Metadata chunk {chunk_type.decode('ascii')}: {relative(path)}",
        )
        offset = end
        if chunk_type == b"IEND":
            return

    ERRORS.append(f"Missing PNG IEND chunk: {relative(path)}")


def validate_webp_chunks(path: Path, data: bytes) -> None:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        ERRORS.append(f"Invalid WebP signature: {relative(path)}")
        return

    offset = 12
    while offset + 8 <= len(data):
        chunk_type = data[offset : offset + 4]
        length = struct.unpack("<I", data[offset + 4 : offset + 8])[0]
        check(
            chunk_type not in WEBP_METADATA_CHUNKS,
            f"Metadata chunk {chunk_type.decode('ascii')}: {relative(path)}",
        )
        offset += 8 + length + (length & 1)
        if offset > len(data):
            ERRORS.append(f"Truncated WebP chunk: {relative(path)}")
            return


def validate_raster(
    path: Path,
    expected_size: tuple[int, int],
    expected_format: str,
    expected_mode: str,
) -> None:
    try:
        data = path.read_bytes()
        with Image.open(path) as image:
            image.load()
            check(image.format == expected_format, f"Wrong format for {relative(path)}: {image.format}")
            check(image.size == expected_size, f"Wrong dimensions for {relative(path)}: {image.size}")
            check(image.mode == expected_mode, f"Wrong color mode for {relative(path)}: {image.mode}")
            check(getattr(image, "n_frames", 1) == 1, f"Animated image: {relative(path)}")
            check(not image.getexif(), f"EXIF metadata found: {relative(path)}")
            sensitive = {str(key).lower() for key in image.info} & SENSITIVE_INFO_KEYS
            check(not sensitive, f"Sensitive metadata {sorted(sensitive)}: {relative(path)}")
    except (OSError, ValueError) as error:
        ERRORS.append(f"Cannot decode {relative(path)}: {error}")
        return

    if expected_format == "PNG":
        validate_png_chunks(path, data)
    elif expected_format == "WEBP":
        validate_webp_chunks(path, data)


def validate_ico(path: Path) -> None:
    try:
        with Image.open(path) as image:
            check(image.format == "ICO", f"Wrong format for {relative(path)}: {image.format}")
            sizes = set(image.ico.sizes()) if hasattr(image, "ico") else {image.size}
            check(sizes == ICO_SIZES, f"Wrong ICO representations: {sorted(sizes)}")
            for size in sorted(ICO_SIZES):
                image.ico.getimage(size).load()
    except (OSError, ValueError) as error:
        ERRORS.append(f"Cannot decode {relative(path)}: {error}")


def validate_icns(path: Path) -> None:
    try:
        with Image.open(path) as image:
            check(image.format == "ICNS", f"Wrong format for {relative(path)}: {image.format}")
            check(image.size == (1024, 1024), f"Wrong ICNS maximum size: {image.size}")
            representations = {tuple(item) for item in image.info.get("sizes", [])}
            check(
                representations == ICNS_REPRESENTATIONS,
                f"Wrong ICNS representations: {sorted(representations)}",
            )
            for representation in sorted(ICNS_REPRESENTATIONS):
                image.icns.getimage(representation).load()
    except (OSError, ValueError) as error:
        ERRORS.append(f"Cannot decode {relative(path)}: {error}")


def main() -> int:
    check_exact_files(BRAND_ROOT, set(BRAND_VIEWBOXES))
    check_exact_files(ICON_ROOT, {"agent-dock.ico", "agent-dock.icns"})
    check_exact_files(PNG_ROOT, {f"icon-{size}.png" for size in PNG_SIZES})
    check_exact_files(ILLUSTRATION_ROOT, set(ILLUSTRATION_VIEWBOXES))
    check_exact_files(ARCHITECTURE_ROOT, set(ARCHITECTURE_VIEWBOXES))
    check_exact_files(ARTWORK_ROOT, {path.name for path in PUBLIC_IMAGES if path.parent == ARTWORK_ROOT})
    check_exact_files(
        SCREENSHOT_ROOT,
        {path.name for path in PUBLIC_IMAGES if path.parent == SCREENSHOT_ROOT},
    )
    check_exact_files(SOCIAL_ROOT, {path.name for path in PUBLIC_IMAGES if path.parent == SOCIAL_ROOT})

    svg_files = {
        **{BRAND_ROOT / name: viewbox for name, viewbox in BRAND_VIEWBOXES.items()},
        **{ILLUSTRATION_ROOT / name: viewbox for name, viewbox in ILLUSTRATION_VIEWBOXES.items()},
        **{ARCHITECTURE_ROOT / name: viewbox for name, viewbox in ARCHITECTURE_VIEWBOXES.items()},
    }
    for path, viewbox in svg_files.items():
        if path.is_file():
            validate_svg(path, viewbox)

    curated_files = [
        *svg_files,
        *(PNG_ROOT / f"icon-{size}.png" for size in PNG_SIZES),
        ICON_ROOT / "agent-dock.ico",
        ICON_ROOT / "agent-dock.icns",
        *PUBLIC_IMAGES,
    ]
    for path in curated_files:
        if path.is_file():
            validate_forbidden_bytes(path)

    for size in PNG_SIZES:
        path = PNG_ROOT / f"icon-{size}.png"
        if path.is_file():
            validate_raster(path, (size, size), "PNG", "RGBA")

    ico = ICON_ROOT / "agent-dock.ico"
    if ico.is_file():
        validate_ico(ico)
    icns = ICON_ROOT / "agent-dock.icns"
    if icns.is_file():
        validate_icns(icns)

    for path, (size, image_format) in PUBLIC_IMAGES.items():
        if path.is_file():
            validate_raster(path, size, image_format, "RGB")

    if ERRORS:
        print("Asset validation failed:")
        for error in ERRORS:
            print(f"- {error}")
        return 1

    print(
        "Asset validation passed: "
        f"{len(svg_files)} SVGs, {len(PNG_SIZES)} PNG icons, ICO, ICNS, "
        f"and {len(PUBLIC_IMAGES)} curated public images"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
