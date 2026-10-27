#!/usr/bin/env bash
# Builds release packages for Windows, macOS and Linux into ./dist
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-1.0.0}"
LDFLAGS="-s -w -X main.version=${VERSION}"
OUT=dist
rm -rf "$OUT" && mkdir -p "$OUT/tmp"
build() { # os arch output [extra ldflags]
  echo "→ $1/$2"
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "$LDFLAGS ${4:-}" -o "$3" .
}

for arch in amd64 arm64; do
  d="$OUT/tmp/windows-$arch"; mkdir -p "$d"
  build windows $arch "$d/etcd-browser.exe" "-H windowsgui"
  cp README.md "$d/"
  (cd "$d" && zip -qr "../../etcd-browser-${VERSION}-windows-${arch}.zip" .)
done

for arch in amd64 arm64; do
  d="$OUT/tmp/linux-$arch/etcd-browser-${VERSION}"; mkdir -p "$d"
  build linux $arch "$d/etcd-browser"
  cp README.md build/etcd-browser.desktop "$d/"
  cp build/icon-256.png "$d/etcd-browser.png"
  tar -C "$OUT/tmp/linux-$arch" -czf "$OUT/etcd-browser-${VERSION}-linux-${arch}.tar.gz" "etcd-browser-${VERSION}"
done

d="$OUT/tmp/macos"; mkdir -p "$d"
build darwin amd64 "$d/etcd-browser-amd64"
build darwin arm64 "$d/etcd-browser-arm64"
app="$d/pkg/etcd browser.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
go run ./tools/lipo "$app/Contents/MacOS/etcd-browser" "$d/etcd-browser-amd64" "$d/etcd-browser-arm64"
sed "s/VERSION/${VERSION}/g" build/Info.plist > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp build/app.icns "$app/Contents/Resources/app.icns"
cp README.md "$d/pkg/"
(cd "$d/pkg" && zip -qry "../../../etcd-browser-${VERSION}-macos-universal.zip" .)

rm -rf "$OUT/tmp"
ls -la "$OUT"
