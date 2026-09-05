#!/usr/bin/env bash
# release.sh - cross-compile pi-logfwd for every supported platform and
# publish the pi package set to npm in one shot.
#
# Publishing model (esbuild-style companion packages):
#   - main package   @sukeai/pi-logfwd            (pi extension, registers the bash tool that replaces pi's built-in buffered bash)
#   - platform pkgs  @sukeai/pi-logfwd-<os>-<arch> (native binary + package.json
#                                                  with matching os/cpu fields)
# The main package lists all platform packages in optionalDependencies; npm
# installs only the one matching the current os/cpu and skips the rest, so an
# unsupported platform simply ends up without a binary (and the extension
# explains why at runtime).
#
# Usage:
#   scripts/release.sh <version> [--publish] [--main-only|--platforms-only]
#
#   <version>        semver, e.g. 0.1.0  (all packages share one version)
#   --publish        actually run npm publish (default: build + dry-run only)
#   --main-only      only build+publish the main package (skip platform builds)
#                    - requires platforms already published at the same version
#   --platforms-only only build+publish platform packages
#
# Prereqs: go toolchain, npm logged in as the scope owner (sukeai).
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: scripts/release.sh <semver> [--publish] [--main-only|--platforms-only]" >&2
	exit 1
fi
PUBLISH=0
MODE="all"
for arg in "${@:2}"; do
	case "$arg" in
	--publish) PUBLISH=1 ;;
	--main-only) MODE="main" ;;
	--platforms-only) MODE="platforms" ;;
	*)
		echo "unknown arg: $arg" >&2
		exit 1
		;;
	esac
done

SCOPE="@sukeai"
MAIN="pi-logfwd"
# NOTE: no windows - creack/pty returns ErrUnsupported there (see README).
PLATFORMS=("darwin:arm64" "darwin:amd64" "linux:arm64" "linux:amd64")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/.release/$VERSION"
cd "$ROOT"

publish() { # dir [extra args...]
	local dir="$1"
	shift
	if [[ "$PUBLISH" -eq 1 ]]; then
		(cd "$dir" && npm publish --access public "$@")
	else
		# real dry-run: npm packs the tarball locally so we can verify contents
		echo "  [dry-run] $dir:"
		(cd "$dir" && npm pack --dry-run 2>&1 | sed 's/^/    /')
	fi
}

# ---------------------------------------------------------------- 1. version
node scripts/set-version.js "$VERSION"

# ------------------------------------------------- 2. build platform packages
if [[ "$MODE" != "main" ]]; then
	rm -rf "$DIST"
	mkdir -p "$DIST"
	for entry in "${PLATFORMS[@]}"; do
		os="${entry%%:*}"
		arch="${entry##*:}"
		tag="$os-$arch"
		out="$DIST/$tag"
		mkdir -p "$out/bin"
		echo "==> build $tag"
		(
			cd "$ROOT"
			CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -o "$out/bin/pi-logfwd" ./cmd/pi-logfwd
		)
		cat >"$out/package.json" <<EOF
{
	"name": "$SCOPE/$MAIN-$tag",
	"version": "$VERSION",
	"description": "pi-logfwd native binary for $os/$arch (companion of $SCOPE/$MAIN - do not install directly)",
	"license": "MIT",
	"os": ["$os"],
	"cpu": ["$arch"],
	"bin": { "pi-logfwd": "bin/pi-logfwd" },
	"files": ["bin/pi-logfwd"]
}
EOF
		echo "==> verify $tag: $(file -b "$out/bin/pi-logfwd" | cut -d, -f1-2)"
	done

	echo
	echo "platform packages ready in $DIST:"
	for entry in "${PLATFORMS[@]}"; do
		echo "  - $SCOPE/$MAIN-${entry%%:*}-${entry##*:}@$VERSION"
	done
	echo
	for entry in "${PLATFORMS[@]}"; do
		tag="${entry%%:*}-${entry##*:}"
		publish "$DIST/$tag"
	done
else
	echo "==> main-only: skipping platform builds (platforms must already be at $VERSION)"
fi

# ------------------------------------------------------------ 3. main package
if [[ "$MODE" != "platforms" ]]; then
	publish "$ROOT"
fi

echo
if [[ "$PUBLISH" -eq 1 ]]; then
	echo "published $SCOPE/$MAIN@$VERSION + ${#PLATFORMS[@]} platform packages."
else
	echo "dry-run finished. Re-run with --publish to actually publish."
	echo "Next: git tag v$VERSION && git push --tags  (GitHub release optional)"
fi
