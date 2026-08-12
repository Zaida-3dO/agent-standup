#!/usr/bin/env node
/**
 * Turns a release tag (`v1.2.3`) into the npm version to publish (`1.2.3`).
 *
 * Row #89 (MILESTONES.md): the npm package publishes on the **same version
 * tag** that publishes the image, so the two artefacts of a release can
 * never drift apart. `.github/workflows/release.yml` triggers both the
 * image build and the npm publish from one `push: tags: ["v*"]` event —
 * this script is what the npm-publish job uses to turn that one tag into
 * the version it publishes, so there is nothing else for a release to keep
 * in sync. `package.json`'s own checked-in `version` field is not the
 * source of truth for what gets published — the tag is — so a release
 * never depends on someone remembering to bump it in a separate commit.
 * `npm run version:from-tag <tag>` prints the version and is what the
 * workflow feeds into `npm version --no-git-tag-version` before publishing.
 *
 * The image side of the same tag is `docker/metadata-action`'s
 * `type=semver,pattern={{version}}` (release.yml), which extracts the same
 * shape of version from the same tag — optional leading `v`, then
 * MAJOR.MINOR.PATCH with an optional `-PRERELEASE`. This script deliberately
 * mirrors that contract rather than inventing its own, so both artefacts of
 * one release are versioned from the same reading of the tag. Build
 * metadata (`+build`) is not supported on either side of that pairing, so
 * it is rejected here too rather than silently dropped — a tag using it
 * would need a decision about whether it belongs in the published version,
 * and refusing is safer than guessing.
 *
 * ── What "invalid" means here, precisely ────────────────────────────────
 *
 * Anything that is not `v` followed by a valid MAJOR.MINOR.PATCH[-PRERELEASE]
 * is refused: no leading `v` (npm's `latest` dist-tag convention is not a
 * release tag), a partial version (`v1.2`), a non-numeric component, or
 * build metadata. A refusal returns `null` rather than guessing at a close
 * version — publishing something a tag didn't actually say is exactly the
 * drift this row exists to prevent, so an unparsed tag must fail loudly
 * (the CLI below exits 1) rather than fall back to anything.
 *
 * Usage:
 *   node scripts/version-from-tag.mjs v1.2.3        # prints 1.2.3, exit 0
 *   node scripts/version-from-tag.mjs v1.2.3-rc.1    # prints 1.2.3-rc.1
 *   node scripts/version-from-tag.mjs not-a-tag       # prints nothing, exit 1
 */
import { fileURLToPath } from "node:url";

// Anchored: the whole string must be `v` + semver core + optional
// prerelease, nothing before or after. Build metadata is deliberately not
// in this pattern — see the header.
const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/**
 * Returns the npm version for a release tag, or `null` if the tag is not a
 * valid `v`-prefixed semver release tag.
 */
export function versionFromTag(tag) {
  if (typeof tag !== "string") return null;
  const match = TAG_PATTERN.exec(tag.trim());
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  return prerelease === undefined
    ? `${major}.${minor}.${patch}`
    : `${major}.${minor}.${patch}-${prerelease}`;
}

function main(argv) {
  const tag = argv[2];
  if (tag === undefined) {
    console.error("Usage: node scripts/version-from-tag.mjs <tag>");
    return 1;
  }

  const version = versionFromTag(tag);
  if (version === null) {
    console.error(
      `"${tag}" is not a valid release tag (expected v<major>.<minor>.<patch>` +
        "[-prerelease], e.g. v1.2.3 or v1.2.3-rc.1). Refusing to guess a version — " +
        "fix the tag rather than publish something it didn't say.",
    );
    return 1;
  }

  console.log(version);
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
