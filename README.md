# Ember

Open-source Windows mod manager. [Source](https://github.com/Ember-Mod-Loader/Ember) · [Releases](https://github.com/Ember-Mod-Loader/Ember/releases/latest) · [Contributing](CONTRIBUTING.md)

Ember is a Windows desktop app for browsing Thunderstore, downloading mods and their dependencies, and managing game profiles. The beta supports modded and vanilla launch for the Windows Steam edition of Lethal Company after game setup.

## Get started

1. On Windows x64, run `Ember-0.5.0-Windows-x64-Setup.exe` to install for your user account, or open `Ember-0.5.0-Windows-x64.exe` directly. Both builds save profiles and downloads in local app data. Use the installer for automatic client updates.
2. Select a game and choose or create a profile. Use **Browse mods** to search the Thunderstore catalog, then choose **Download** on a package.
3. Use **Installed mods** to enable, disable, or update packages in the active profile. Choose **Open downloads** to find the ZIP archives.

| Game | Beta support |
| --- | --- |
| Lethal Company | Browse, download, and launch modded or vanilla through Steam |
| R.E.P.O. | Browse, download, and manage profiles |
| PEAK | Browse, download, and manage profiles |

## Set up Lethal Company

1. Install Lethal Company in Steam and close the game.
2. Open **Settings → Lethal Company setup**. Use **Choose game folder** if you need to select the installation.
3. Download and enable your mods, then choose **Prepare profile**. Use **Open profile folder** to inspect the prepared files and find the BepInEx configuration directory.
4. Choose **Launch modded** or **Launch vanilla**. On a clean installation, **Set up modded launch** asks before adding Doorstop files to the Steam game folder. An existing compatible loader can be reused after confirmation.

Use the arrow beside the launch button to select the launch mode. Ember remembers approval for an existing loader in that game folder and asks again if the loader files change.

Keep the profile’s BepInExPack and the game’s Doorstop loader on the same major version. If Steam’s custom launch options interfere, clear them in **Steam → Lethal Company → Properties → Launch Options**.

Use **Settings → Lethal Company setup → Remove loader** to remove a loader installed by Ember before uninstalling the app.

Enable mods you trust. The game loads mod code with your Windows account's permissions. For package-specific compatibility, check its Thunderstore listing.

## Profiles and downloads

- Use **Profiles → Share profile → Create share code** for a short `EMBER-…` code that works on another device running Ember. This uploads the selected profile to Thunderstore's sharing service; anyone with the code can import it. Creating and resolving short codes requires internet access. These are Ember profile codes; native Thunderstore/r2modman archive codes are not supported.
- **Download JSON** keeps an offline export. **Import profile** accepts short Ember codes, older `MR1-…` codes, and Ember JSON exports, and downloads the profile's package versions.
- Removing a package from a profile changes that profile's package list. Manage ZIP archives separately through **Installed mods → Open downloads**.
- Disabling a required mod offers **Disable affected mods** to turn off its enabled dependents, or **Disable anyway** to turn off only that mod. Removing a required mod lists all installed dependents, including disabled mods. Choose **Delete anyway** to remove only the selected mod, or remove all affected mods together. Delete anyway leaves the other mods installed; they may not work until you reinstall the missing requirement. Dependency removal warnings always appear, even when ordinary removal confirmation is disabled.

## Release information

Installed Windows clients check GitHub Releases automatically at startup and download newer stable releases. Ember restarts to install when the game is closed and no download, profile operation, or editing dialog is active. **Settings → Update client** shows progress and allows manual checking and **Install and restart**. A network failure leaves the workspace usable and can be retried. Portable and development builds link to Releases for manual updates.

**Coming from 0.4.x:** install 0.5.0 once using the installer. Earlier builds have no working updater and cannot bootstrap this upgrade automatically. Existing profiles, mods, wallpaper preferences, and caches are preserved in the same local app-data directory.

To publish an update, bump the version in package.json and package-lock.json and update RELEASE-NOTES.md, then push to main. The Windows release workflow tests and builds the exact commit, uploads installer/portable builds, updater metadata, blockmap, and checksums into a draft, then publishes the complete stable release. Never overwrite an existing release/version. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release procedure.

The Ember source is MIT licensed; third-party libraries, game artwork, mod branding, and trademarks retain their own licenses and ownership. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Windows builds are currently unsigned; signing credentials are not stored in the repository.

[Release notes](RELEASE-NOTES.md) · [Privacy](PRIVACY.md) · [Third-party notices](THIRD-PARTY-NOTICES.md)

Ember is an independent app. Thunderstore provides the catalog and downloads. Steam and the game developers provide their respective platforms and games.

## Run from source

Use Node.js 22.12 or newer and run these commands from the project folder.

```powershell
npm ci
npm start
```

Use `npm run dev` for layout development. The desktop app connects to Thunderstore. Run `npm test` for the offline checks or `npm run package` to test and build Windows x64 artifacts locally.

The catalog loads more mods automatically as you scroll. Use the search field and category menu to narrow results.

Use **Sort mods** for Most downloaded, Recently updated, Top rated, or Newest. Choose **Default order** or **Clear sorting** to remove the custom sort; the catalog then uses Thunderstore's standard most-downloaded order.

Open **Downloads** to see per-package progress and the target profile. Completed entries clear automatically after 30 seconds, or immediately with **Clear completed** for the selected game. Expired entries also clear when Ember reopens. Active downloads and failed transfers remain visible; clearing completed entries does not remove installed mods, profiles, or cached ZIP files.

When a toggle affects dependencies, Ember explains which mods are required. Choose **Enable required mods** to enable the dependency chain, **Enable anyway** to override it, or **Cancel**. Overrides are saved with the profile.

Choose **Settings → Wallpapers** for six backgrounds: **Main**, **Ember Flow**, **Aurora**, **Obsidian**, **Crimson Dunes**, and **Solar Drift**. Main, the original mountain background, stays the default. Your choice is saved across app restarts and used by the loading screen too. The expanded picker includes thumbnail previews and scrolls on smaller windows.
