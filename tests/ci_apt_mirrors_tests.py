"""Exercise both runner APT layouts without touching the host configuration."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("configure_apt", Path(__file__).resolve().parents[1] / ".github/scripts/configure_apt_mirrors.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AptMirrorTests(unittest.TestCase):
    def test_mirror_lists_fall_back_to_official_https_and_preserve_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sources.list.d").mkdir()
            (root / "apt-mirrors.txt").write_text("# Ubuntu mirrors\nhttp://azure.archive.ubuntu.com/ubuntu\nhttps://archive.ubuntu.com/ubuntu\n")
            (root / "apt-mirrors-security.txt").write_text("http://azure.archive.ubuntu.com/ubuntu\nhttps://security.ubuntu.com/ubuntu\n")
            sources = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
            (root / "sources.list.d/ubuntu.sources").write_text(sources)
            third_party = "deb [signed-by=/usr/share/keyrings/vendor.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n"
            (root / "sources.list.d/vendor.list").write_text(third_party)
            module.configure(root)
            self.assertEqual((root / "apt-mirrors.txt").read_text(), "# Ubuntu mirrors\nhttps://archive.ubuntu.com/ubuntu\n")
            self.assertEqual((root / "apt-mirrors-security.txt").read_text(), "https://security.ubuntu.com/ubuntu\n")
            self.assertEqual((root / "sources.list.d/ubuntu.sources").read_text(), sources)
            self.assertEqual((root / "sources.list.d/vendor.list").read_text(), third_party)
            config = (root / "apt.conf.d/80kacha-network-timeouts").read_text()
            self.assertIn('Timeout "30"', config)
            self.assertNotIn("AllowUnauthenticated", config)
            self.assertNotIn("Verify-Peer", config)
            self.assertEqual(module.configure(root), [])

    def test_direct_sources_preserve_suites_components_and_other_hosts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sources.list.d").mkdir()
            source = "deb http://azure.archive.ubuntu.com/ubuntu/ noble main universe\ndeb https://ports.ubuntu.com/ubuntu-ports noble main\n"
            (root / "sources.list").write_text(source)
            deb822 = "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble-security\nComponents: main restricted\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
            (root / "sources.list.d/ubuntu.sources").write_text(deb822)
            module.configure(root)
            self.assertEqual((root / "sources.list").read_text(), source.replace("http://azure.archive.ubuntu.com", "https://archive.ubuntu.com"))
            self.assertEqual((root / "sources.list.d/ubuntu.sources").read_text(), deb822.replace("http://azure.archive.ubuntu.com", "https://archive.ubuntu.com"))


if __name__ == "__main__":
    unittest.main()
