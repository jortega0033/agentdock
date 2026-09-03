#!/usr/bin/env python3
"""Build AgentDock documentation and social images from reviewed local sources."""

from __future__ import annotations

import io
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageEnhance, ImageFont
from generate_assets import assert_safe_svg


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ASSETS = PROJECT_ROOT / "apps" / "desktop" / "assets"
SCREENSHOTS = PROJECT_ROOT / "docs" / "images" / "screenshots"
SOCIAL = PROJECT_ROOT / "docs" / "images" / "social"
ARTWORK = PROJECT_ROOT / "docs" / "images" / "artwork" / "agent-dock-runtime.png"
PNG_ICONS = DESKTOP_ASSETS / "app-icons" / "png"
BRAND = DESKTOP_ASSETS / "brand"
ILLUSTRATIONS = DESKTOP_ASSETS / "illustrations"

NAVY = "#0B1020"
INK = "#0F172A"
SLATE = "#64748B"
PAPER = "#F8FAFC"
CANVAS = "#F6F8FC"
BORDER = "#D8E1ED"
COBALT = "#5B6CFF"
MINT = "#2DD4BF"

SCREENSHOT_NAMES = (
    "desktop-ready.png",
    "desktop-dark.png",
    "session-running.png",
    "session-completed.png",
    "daemon-unavailable.png",
)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/seguisb.ttf") if bold else Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
        if bold
        else Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def fit_crop(image: Image.Image, target: tuple[int, int]) -> Image.Image:
    width, height = target
    ratio = max(width / image.width, height / image.height)
    resized = image.resize(
        (round(image.width * ratio), round(image.height * ratio)),
        Image.Resampling.LANCZOS,
    )
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255
    )
    return mask


def rasterize_svg(path: Path, width: int, height: int, color: str | None = None) -> Image.Image:
    source_bytes = path.read_bytes()
    assert_safe_svg(source_bytes, path)
    source = source_bytes.decode("utf-8")
    if color:
        source = source.replace("currentColor", color)
    raw = cairosvg.svg2png(
        bytestring=source.encode("utf-8"), output_width=width, output_height=height
    )
    with Image.open(io.BytesIO(raw)) as image:
        return image.convert("RGBA")


def draw_grid(draw: ImageDraw.ImageDraw, size: tuple[int, int], color: str, step: int = 48) -> None:
    width, height = size
    for x in range(0, width, step):
        draw.line((x, 0, x, height), fill=color, width=1)
    for y in range(0, height, step):
        draw.line((0, y, width, y), fill=color, width=1)


def normalize_screenshots() -> None:
    """Normalize browser captures to the production 1440x900 documentation canvas."""

    for name in SCREENSHOT_NAMES:
        path = SCREENSHOTS / name
        with Image.open(path) as source:
            image = source.convert("RGB")

        if image.size == (1440, 900):
            image.save(path, format="PNG", optimize=True)
            continue
        if image.height > 900 or image.width > 1440:
            raise ValueError(f"Unexpected capture dimensions for {path}: {image.size}")

        dark = name == "desktop-dark.png"
        background = "#080D19" if dark else "#EEF2F8"
        grid = "#0E1627" if dark else "#E8EDF6"
        canvas = Image.new("RGB", (1440, 900), background)
        draw_grid(ImageDraw.Draw(canvas), canvas.size, grid)
        x = (canvas.width - image.width) // 2
        canvas.paste(image, (x, 0))
        canvas.save(path, format="PNG", optimize=True)


def framed_screenshot(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    frame = Image.new("RGBA", (size[0] + 28, size[1] + 28), (0, 0, 0, 0))
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle(
        (0, 0, frame.width - 1, frame.height - 1),
        radius=24,
        fill="#111827",
        outline="#334155",
        width=2,
    )
    crop = fit_crop(source, size)
    frame.paste(crop, (14, 14), rounded_mask(size, 14))
    return frame


def hero_canvas() -> Image.Image:
    with Image.open(ARTWORK) as source:
        artwork = fit_crop(source.convert("RGB"), (1440, 900))
    artwork = ImageEnhance.Brightness(artwork).enhance(0.68)
    canvas = artwork.convert("RGBA")
    canvas.alpha_composite(Image.new("RGBA", canvas.size, (5, 11, 24, 72)))
    return canvas


def make_readme_and_portfolio() -> None:
    canvas = hero_canvas()
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((44, 48, 470, 852), radius=30, fill=(7, 14, 30, 226), outline="#273449", width=2)

    icon = Image.open(PNG_ICONS / "icon-128.png").convert("RGBA").resize((88, 88), Image.Resampling.LANCZOS)
    canvas.alpha_composite(icon, (78, 84))
    draw.text((78, 210), "AgentDock", fill=PAPER, font=font(58, bold=True))
    draw.multiline_text(
        (78, 292),
        "Forkable Electron boilerplate\nfor desktop products using\nClaude Agent or Codex CLI.",
        fill="#CBD5E1",
        font=font(23),
        spacing=8,
    )

    chips = ("Local daemon included", "CLI auth stays local", "Typed provider events")
    y = 418
    for label in chips:
        draw.rounded_rectangle((78, y, 390, y + 48), radius=14, fill="#121A2B", outline="#334155")
        draw.ellipse((96, y + 18, 108, y + 30), fill=MINT if y == 418 else COBALT)
        draw.text((122, y + 12), label, fill="#E2E8F0", font=font(17, bold=True))
        y += 64
    draw.text((78, 786), "Electron · Fastify · TypeScript", fill="#94A3B8", font=font(16))

    with Image.open(SCREENSHOTS / "session-completed.png") as source:
        screenshot = source.convert("RGB")
    frame = framed_screenshot(screenshot, (840, 525))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((524, 205, 1404, 775), radius=28, fill=(0, 0, 0, 90))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(frame, (500, 178))

    rgb = canvas.convert("RGB")
    rgb.save(SOCIAL / "readme-hero.webp", format="WEBP", quality=90, method=6)
    rgb.save(SOCIAL / "portfolio-project.png", format="PNG", optimize=True)


def make_social(width: int, height: int, filename: str) -> None:
    with Image.open(ARTWORK) as source:
        background = fit_crop(source.convert("RGB"), (width, height))
    background = ImageEnhance.Brightness(background).enhance(0.62).convert("RGBA")
    background.alpha_composite(Image.new("RGBA", background.size, (4, 10, 22, 88)))
    draw = ImageDraw.Draw(background)

    pad = round(width * 0.06)
    icon_size = round(height * 0.14)
    icon = Image.open(PNG_ICONS / "icon-128.png").convert("RGBA").resize(
        (icon_size, icon_size), Image.Resampling.LANCZOS
    )
    background.alpha_composite(icon, (pad, pad))
    title_size = round(height * 0.105)
    draw.text((pad, pad + icon_size + 28), "AgentDock", fill=PAPER, font=font(title_size, bold=True))
    draw.multiline_text(
        (pad, pad + icon_size + title_size + 50),
        "Electron boilerplate.\nLocal daemon included.",
        fill="#CBD5E1",
        font=font(round(height * 0.043)),
        spacing=8,
    )
    draw.text(
        (pad, height - pad - 30),
        "Fork it · Claude Agent · Codex CLI",
        fill="#94A3B8",
        font=font(round(height * 0.027)),
    )
    background.convert("RGB").save(SOCIAL / filename, format="PNG", optimize=True)


def make_asset_system_preview() -> None:
    canvas = Image.new("RGB", (1600, 1040), CANVAS)
    draw = ImageDraw.Draw(canvas)
    draw.text((70, 54), "AgentDock · Asset System", fill=INK, font=font(44, bold=True))
    draw.text((70, 112), "Forkable boilerplate · local daemon · provider-neutral", fill=SLATE, font=font(22))

    icon = Image.open(PNG_ICONS / "icon-512.png").convert("RGBA").resize((290, 290), Image.Resampling.LANCZOS)
    canvas.paste(icon, (70, 188), icon)
    draw.text((70, 504), "Application icon", fill=INK, font=font(22, bold=True))
    draw.text((70, 540), "Agent module inside a trusted local dock", fill=SLATE, font=font(18))

    draw.rounded_rectangle((420, 188, 1520, 350), radius=20, fill=PAPER, outline=BORDER, width=2)
    light = rasterize_svg(BRAND / "agent-dock-lockup-horizontal-light.svg", 720, 144)
    canvas.paste(light, (490, 197), light)
    draw.rounded_rectangle((420, 382, 1520, 544), radius=20, fill=NAVY, outline="#273449", width=2)
    dark = rasterize_svg(BRAND / "agent-dock-lockup-horizontal-dark.svg", 720, 144)
    canvas.paste(dark, (490, 391), dark)

    names = (
        "empty-prompt",
        "empty-events",
        "empty-session",
        "no-providers",
        "empty-working-directory",
        "provider-unavailable",
        "runtime-unavailable",
    )
    x0, y0 = 70, 650
    for index, name in enumerate(names):
        x = x0 + index * 215
        draw.rounded_rectangle((x, y0, x + 185, y0 + 260), radius=16, fill=PAPER, outline=BORDER, width=2)
        illustration = rasterize_svg(ILLUSTRATIONS / f"{name}.svg", 142, 142, INK)
        canvas.paste(illustration, (x + 21, y0 + 20), illustration)
        label = name.replace("-", " ").title()
        words = label.split()
        lines: list[str] = []
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if line and draw.textlength(candidate, font=font(16, bold=True)) > 153:
                lines.append(line)
                line = word
            else:
                line = candidate
        if line:
            lines.append(line)
        for row, text in enumerate(lines[:2]):
            draw.text((x + 16, y0 + 180 + row * 22), text, fill=INK, font=font(16, bold=True))
    canvas.save(SOCIAL / "asset-system-preview.png", format="PNG", optimize=True)


def make_icon_size_preview() -> None:
    canvas = Image.new("RGB", (1180, 430), CANVAS)
    draw = ImageDraw.Draw(canvas)
    draw.text((35, 25), "AgentDock icon at production sizes", fill=INK, font=font(26, bold=True))
    sizes = (16, 24, 32, 44, 48, 64, 128, 256)
    x = 35
    for size in sizes:
        card_width = max(90, size + 34)
        draw.rounded_rectangle((x, 85, x + card_width, 365), radius=14, fill=PAPER, outline=BORDER, width=2)
        with Image.open(PNG_ICONS / f"icon-{size}.png") as source:
            icon = source.convert("RGBA")
        display_size = min(size, 210)
        if display_size != size:
            icon = icon.resize((display_size, display_size), Image.Resampling.LANCZOS)
        px = x + (card_width - display_size) // 2
        py = 105 + (220 - display_size) // 2
        canvas.paste(icon, (px, py), icon)
        label = f"{size}px"
        label_font = font(16)
        text_width = draw.textlength(label, font=label_font)
        draw.text((x + (card_width - text_width) / 2, 338), label, fill=SLATE, font=label_font)
        x += card_width + 18
    canvas.save(SOCIAL / "icon-size-preview.png", format="PNG", optimize=True)


def main() -> None:
    SOCIAL.mkdir(parents=True, exist_ok=True)
    normalize_screenshots()
    make_readme_and_portfolio()
    make_social(1280, 640, "github-social-preview.png")
    make_social(1200, 630, "open-graph.png")
    make_asset_system_preview()
    make_icon_size_preview()
    print(f"Generated public assets under {SOCIAL}")


if __name__ == "__main__":
    main()
