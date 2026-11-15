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
check "стили" "$BASE/public/style.css" 200
check "редизайн" "$BASE/public/redesign.css" 200
check "сцена" "$BASE/public/stages.css" 200
check "модуль" "$BASE/public/experience.js" 200
check "datastar" "$BASE/public/vendor/datastar-1.0.5.js" 200

body=$(curl -sS -m 12 "$BASE/health")
echo "$body" | grep -q '"ok":true' || { echo "  ✗ health не ok: $body"; fail=1; }
echo "$body" | grep -q '"mock":false' || echo "  ! внимание: сервер в mock-режиме"

page=$(curl -sS -m 12 "$BASE/")
echo "$page" | grep -q 'THE' >/dev/null || true
echo "$page" | grep -qi '<title>The Lot' || { echo "  ✗ нет заголовка The Lot"; fail=1; }
echo "$page" | grep -q 'Открыть дом' || { echo "  ✗ лендинг без формы создания"; fail=1; }
echo "$page" | grep -q 'Сесть за стол' || { echo "  ✗ лендинг без формы входа"; fail=1; }

headers=$(curl -sSI -m 12 "$BASE/")
echo "$headers" | grep -qi "content-security-policy" || { echo "  ✗ нет CSP"; fail=1; }
echo "$headers" | grep -qi "x-frame-options: DENY" || { echo "  ✗ нет X-Frame-Options"; fail=1; }

exit "$fail"
