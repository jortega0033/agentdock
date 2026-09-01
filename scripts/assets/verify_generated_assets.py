#!/usr/bin/env python3
"""Verify committed native icons match exact pixels rendered from the canonical SVG."""

from __future__ import annotations

import io

from PIL import Image, ImageChops

from generate_assets import (
    ICO_SIZES,
    ICON_ROOT,
    PNG_ROOT,
    PNG_SIZES,
    SOURCE,
    assert_safe_svg,
    rasterize,
)


def assert_exact_pixels(label: str, actual: Image.Image, expected: Image.Image) -> None:
    actual_rgba = actual.convert("RGBA")
    expected_rgba = expected.convert("RGBA")
    if actual_rgba.size != expected_rgba.size:
        raise ValueError(
            f"Wrong dimensions for {label}: {actual_rgba.size}, expected {expected_rgba.size}"
        )
    if ImageChops.difference(actual_rgba, expected_rgba).getbbox() is not None:
        raise ValueError(f"Decoded pixels differ from the canonical SVG: {label}")


def main() -> None:
    svg = SOURCE.read_bytes()
    assert_safe_svg(svg)
    rendered: dict[int, Image.Image] = {}

    try:
        for size in PNG_SIZES:
            expected = rasterize(svg, size)
            rendered[size] = expected
            with Image.open(PNG_ROOT / f"icon-{size}.png") as actual:
                actual.load()
                assert_exact_pixels(f"PNG {size}x{size}", actual, expected)

        with Image.open(ICON_ROOT / "agent-dock.ico") as icon:
            for size in ICO_SIZES:
                frame = icon.ico.getimage(size)
                assert_exact_pixels(f"ICO {size[0]}x{size[1]}", frame, rendered[size[0]])

        expected_icns_bytes = io.BytesIO()
        rendered[1024].save(expected_icns_bytes, format="ICNS")
        expected_icns_bytes.seek(0)
        with (
            Image.open(ICON_ROOT / "agent-dock.icns") as icon,
            Image.open(expected_icns_bytes) as expected_icon,
        ):
            representations = {tuple(item) for item in icon.info.get("sizes", [])}
            expected_representations = {
                tuple(item) for item in expected_icon.info.get("sizes", [])
            }
            if representations != expected_representations:
                raise ValueError(
                    "ICNS representation inventory differs from the canonical SVG: "
                    f"{sorted(representations)}"
                )
            for representation in sorted(representations):
                logical_width, logical_height, scale = representation
                if logical_width != logical_height:
                    raise ValueError(f"Non-square ICNS representation: {representation}")
                frame = icon.icns.getimage(representation)
                expected_frame = expected_icon.icns.getimage(representation)
                assert_exact_pixels(
                    f"ICNS {logical_width}x{logical_height}@{scale}x",
                    frame,
                    expected_frame,
                )
    finally:
        for image in rendered.values():
            image.close()

    print(
        f"Verified exact decoded pixels for {len(PNG_SIZES)} PNGs, "
        f"{len(ICO_SIZES)} ICO frames, and all ICNS representations"
    )


if __name__ == "__main__":
    main()
