#!/bin/bash
# Дым-тест прода: только чтение, без создания комнат.
set -euo pipefail
BASE="${BASE:-https://lot.bunker9.lol}"
fail=0

check() {
	local name="$1" url="$2" expect="$3"
	local code
	code=$(curl -sS -o /dev/null -m 12 -w '%{http_code}' "$url" || echo 000)
	if [ "$code" = "$expect" ]; then
		echo "  ✓ $name ($code)"
	else
		echo "  ✗ $name: $code, ждали $expect"
		fail=1
	fi
}

echo "· $BASE"
check "лендинг" "$BASE/" 200
check "health" "$BASE/health" 200
check "robots" "$BASE/robots.txt" 200
check "sitemap" "$BASE/sitemap.xml" 200
check "service worker" "$BASE/sw.js" 200
check "стили" "$BASE/public/style.css" 200
check "редизайн" "$BASE/public/redesign.css" 200
check "сцена" "$BASE/public/stages.css" 200
check "модуль" "$BASE/public/experience.js" 200
check "datastar" "$BASE/public/vendor/datastar-1.0.5.js" 200

body=$(curl -sS -m 12 "$BASE/health")
echo "$body" | grep -q '"ok":true' || { echo "  ✗ health не ok: $body"; fail=1; }
echo "$body" | grep -q '"rooms"' && { echo "  ✗ публичный health раскрывает счётчики"; fail=1; }
if [ -n "${LOT_OPS_TOKEN:-}" ]; then
	ops=$(curl -sS -m 12 -H "x-lot-ops: $LOT_OPS_TOKEN" "$BASE/health")
	echo "$ops" | grep -q '"mock":false' || echo "  ! внимание: сервер в mock-режиме"
	echo "$ops" | grep -q '"db"' || { echo "  ✗ операторский health без деталей"; fail=1; }
fi

# cache-buster: край Cloudflare может держать старую копию, проверяем origin
robots=$(curl -sS -m 12 "$BASE/robots.txt?smoke=$(date +%s)")
echo "$robots" | grep -q "sitemap.xml" || { echo "  ✗ robots без ссылки на sitemap"; fail=1; }

sitemap=$(curl -sS -m 12 "$BASE/sitemap.xml?smoke=$(date +%s)")
echo "$sitemap" | grep -q "<loc>" || { echo "  ✗ sitemap без loc"; fail=1; }

sw=$(curl -sS -m 12 "$BASE/sw.js")
echo "$sw" | grep -q '__LOT_ASSET_VERSION__' && { echo "  ✗ в sw.js не подставлена версия"; fail=1; }

page=$(curl -sS -m 12 "$BASE/")
echo "$page" | grep -q 'THE' >/dev/null || true
echo "$page" | grep -qi '<title>The Lot' || { echo "  ✗ нет заголовка The Lot"; fail=1; }
echo "$page" | grep -q 'Открыть дом' || { echo "  ✗ лендинг без формы создания"; fail=1; }
echo "$page" | grep -q 'Сесть за стол' || { echo "  ✗ лендинг без формы входа"; fail=1; }

headers=$(curl -sSI -m 12 "$BASE/")
echo "$headers" | grep -qi "content-security-policy" || { echo "  ✗ нет CSP"; fail=1; }
echo "$headers" | grep -qi "x-frame-options: DENY" || { echo "  ✗ нет X-Frame-Options"; fail=1; }

exit "$fail"
