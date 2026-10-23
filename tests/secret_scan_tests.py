"""Embedded preview images must not hide adjacent credentials or malformed data."""
import importlib.util
from pathlib import Path
import base64
import unittest
import zlib
import struct

spec = importlib.util.spec_from_file_location("scanner", Path(__file__).resolve().parents[1] / "scripts/scan_secrets.py")
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class EmbeddedPreviewTests(unittest.TestCase):
    def test_png_only_omits_payload_for_entropy_scan(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes([0, 255, 255, 255]))) + chunk(b'IEND', b'')
        uri = 'data:image/png;base64,' + base64.b64encode(png).decode()
        credential = 'gh' + 'p_' + 'a' * 24
        line = '<img src="' + uri + '"> token="' + credential + '"'
        cleaned = scanner.omit_png_payloads(line)
        self.assertIn(credential, cleaned)
        self.assertIn('validated-payload', cleaned)
        self.assertTrue(scanner.PATTERNS['GitHub token'].search(line))

    def test_fake_png_and_other_uri_remain_visible(self):
        for mime in ['image/png', 'text/plain', 'image/svg+xml']:
            line = '<img src="data:' + mime + ';base64,' + base64.b64encode(b'not an image: confidential data').decode() + '">'
            self.assertEqual(scanner.omit_png_payloads(line), line)


if __name__ == '__main__':
    unittest.main()
