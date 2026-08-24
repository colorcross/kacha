.PHONY: check-static check-targeted check-core check-full check-website

check-static:
	find scripts tests -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
	find scripts -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
	python3 -m py_compile scripts/*.py
	python3 scripts/scan_secrets.py

check-targeted: check-static
	node tests/run_tests.mjs --match 'production packs separate generic policy'
	node tests/run_tests.mjs --match 'production quality contract gates'

check-core:
	node tests/run_tests.mjs --suite core

check-full: check-static
	node tests/run_tests.mjs
	bash tests/test_installer.sh

check-website:
	cd website && npm run lint && npm run typecheck && npm run test:pages && npm run audit:dependencies
