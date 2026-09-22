.PHONY: check-static check-targeted check-core check-full check-website check-browser

check-static:
	find scripts tests hooks -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
	find scripts -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
	python3 -m py_compile scripts/*.py
	python3 scripts/scan_secrets.py
	node scripts/verify_product_truth.mjs

check-targeted: check-static
	node tests/run_tests.mjs --match 'production packs separate generic policy'
	node tests/run_tests.mjs --match 'production quality contract gates'
	node tests/mcp_server_tests.mjs
	node tests/workbench_distribution_tests.mjs

check-core:
	node tests/run_tests.mjs --suite core

check-full: check-static
	node tests/audio_fallback_review_tests.mjs
	node tests/optimization_telemetry_tests.mjs
	node tests/optimization_observation_tests.mjs
	node tests/optimization_runtime_tests.mjs
	node tests/optimization_preview_tests.mjs
	node tests/optimization_execution_tests.mjs
	node tests/optimization_render_tests.mjs
	node tests/job_reliability_tests.mjs
	node tests/run_tests.mjs
	node tests/mcp_server_tests.mjs
	node tests/workbench_distribution_tests.mjs
	bash tests/test_installer.sh

check-website:
	cd website && npm run lint && npm run typecheck && npm test && npm run test:pages && npm run audit:dependencies

# Optional real-browser journey for the editor workbench. Requires a local
# Playwright module; point KACHA_PLAYWRIGHT_MODULE at it and run `make check-browser`.
check-browser:
	node tests/browser/run_editor_journey.mjs
