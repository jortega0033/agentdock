#!/usr/bin/env python3
"""Regression tests for same-document SVG references used by brand assets."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import generate_assets
import validate_assets


class SvgSafetyTests(unittest.TestCase):
    def assert_safe(self, body: str) -> None:
        generate_assets.assert_safe_svg(body.encode("utf-8"), Path("fixture.svg"))

    def assert_blocked(self, body: str) -> None:
        with self.assertRaises(ValueError):
            self.assert_safe(body)

    def validator_errors(self, body: str) -> list[str]:
        original_root = validate_assets.PROJECT_ROOT
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fixture = root / "fixture.svg"
            fixture.write_text(body, encoding="utf-8")
            validate_assets.PROJECT_ROOT = root
            validate_assets.ERRORS.clear()
            try:
                validate_assets.validate_svg(fixture, "0 0 64 64")
                return list(validate_assets.ERRORS)
            finally:
                validate_assets.ERRORS.clear()
                validate_assets.PROJECT_ROOT = original_root

    def test_known_same_document_references_are_allowed(self) -> None:
        self.assert_safe(
            """<svg xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="paint"/><clipPath id="clip"><path/></clipPath></defs>
            <path fill="url(#paint)" clip-path="url('#clip')"/>
            </svg>"""
        )

    def test_missing_same_document_reference_is_blocked(self) -> None:
        self.assert_blocked(
            '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#missing)"/></svg>'
        )

    def test_external_and_data_references_are_blocked(self) -> None:
        for reference in (
            "url(https://example.com/paint.svg#gradient)",
            "url(file:///tmp/paint.svg#gradient)",
            "url(data:image/svg+xml;base64,PHN2Zz4=)",
        ):
            with self.subTest(reference=reference):
                self.assert_blocked(
                    f'<svg xmlns="http://www.w3.org/2000/svg"><path fill="{reference}"/></svg>'
                )

    def test_active_content_is_still_blocked(self) -> None:
        self.assert_blocked(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        )
        self.assert_blocked(
            '<svg xmlns="http://www.w3.org/2000/svg"><path onclick="alert(1)"/></svg>'
        )

    def test_css_escaped_external_reference_is_blocked(self) -> None:
        self.assert_blocked(
            r'<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\72l(h\74tps://example.com/x)"/></svg>'
        )

    def test_duplicate_ids_are_blocked(self) -> None:
        self.assert_blocked(
            '<svg xmlns="http://www.w3.org/2000/svg"><path id="paint"/><path id="paint"/></svg>'
        )

    def test_validator_checks_complete_svg_policy(self) -> None:
        safe = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <defs><linearGradient id="paint"/></defs><path fill="url(#paint)"/>
        </svg>"""
        self.assertEqual(self.validator_errors(safe), [])

        blocked_fixtures = {
            "missing local reference": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="url(#missing)"/></svg>',
            "external reference": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="url(https://example.com/x)"/></svg>',
            "CSS escape": r'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="u\72l(h\74tps://example.com/x)"/></svg>',
            "duplicate id": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path id="paint"/><path id="paint"/></svg>',
        }
        for label, fixture in blocked_fixtures.items():
            with self.subTest(label=label):
                self.assertTrue(self.validator_errors(fixture), label)

    def test_generator_and_validator_classify_references_identically(self) -> None:
        values = (
            "url(#paint)",
            "url('#paint')",
            "url(https://example.com/paint.svg#gradient)",
            "url(data:image/png;base64,AAAA)",
            "C:\\Users\\someone\\paint.svg",
            "@import 'paint.css'",
            r"u\72l(h\74tps://example.com/x)",
        )
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(
                    generate_assets.has_unsafe_reference(value),
                    validate_assets.has_unsafe_reference(value),
                )
                self.assertEqual(
                    generate_assets.local_fragment_ids(value),
                    validate_assets.local_fragment_ids(value),
                )


if __name__ == "__main__":
    unittest.main()
