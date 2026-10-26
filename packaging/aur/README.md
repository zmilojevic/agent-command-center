# AUR package: hearth-bin

`hearth-bin/PKGBUILD` repackages the `.deb` that CI attaches to the GitHub release
(`hearth-<ver>-linux-amd64.deb`, built by electron-builder) and the repo's `LICENSE` at the same tag.
The checksums in the repo are placeholders because the release artifact is built by CI.

## Release steps

1. Bump `version` in `package.json`, commit, tag `v<ver>` and push the tag. CI builds the artifacts and a draft release;
   publish the release (the tag must contain `LICENSE`).
2. In `packaging/aur/hearth-bin/` set `pkgver=<ver>` and `pkgrel=1`, then:

   ```sh
   updpkgsums
   makepkg -f            # optional local test build
   makepkg --printsrcinfo > .SRCINFO
   ```

3. Push to the AUR (first time: `git clone ssh://aur@aur.archlinux.org/hearth-bin.git`):

   ```sh
   cp PKGBUILD .SRCINFO <aur clone>/ && cd <aur clone>
   git add PKGBUILD .SRCINFO && git commit -m "Update to <ver>" && git push
   ```

Do not commit `src/`, `pkg/` or `*.pkg.tar.*` build output. Claude Code does not have to be installed (the SDK ships its
binary), but the user must be logged in to Claude Code.
