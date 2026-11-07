<div align="center">

<img src="public/art/ember-flame.png" alt="Ember flame" width="80">

# Ember

A Windows mod manager for Lethal Company, R.E.P.O., and PEAK, powered by Thunderstore.

[![Latest release](https://img.shields.io/github/v/release/Ember-Mod-Loader/Ember?style=flat-square&label=latest&color=ff6a00)](https://github.com/Ember-Mod-Loader/Ember/releases/latest)
[![MIT license](https://img.shields.io/badge/license-MIT-20232a?style=flat-square)](LICENSE)

**[Download Ember](https://github.com/Ember-Mod-Loader/Ember/releases/latest)** · [What's new](RELEASE-NOTES.md) · [Report a bug](https://github.com/Ember-Mod-Loader/Ember/issues)

</div>

## Download

**[Windows installer](https://github.com/Ember-Mod-Loader/Ember/releases/latest)** · Recommended, with automatic updates.

[Portable app](https://github.com/Ember-Mod-Loader/Ember/releases/latest) · Run without installing. Update manually.

Windows builds are currently unsigned. Checksums are included with each release.

<img src="docs/images/ember-app.webp" alt="Ember's mod catalog and profile controls" width="1200">

## Supported games

| <img src="public/art/game-lethal-company.jpg" alt="Lethal Company" width="64"><br>Lethal Company | <img src="public/art/game-repo.jpg" alt="R.E.P.O." width="64"><br>R.E.P.O. | <img src="public/art/game-peak.jpg" alt="PEAK" width="64"><br>PEAK |
| :---: | :---: | :---: |

Ember finds supported games in your Steam libraries. If a game isn't found, choose its folder in **Settings**.

## Features

- Browse Thunderstore by search, category, downloads, or recent updates.
- Install mods and their required packages together.
- Enable, disable, update, and remove individual mods, with prompts for affected dependencies.
- Keep separate profiles and share mod lists with an Ember profile code.
- Follow downloads and launch your game with mods or in vanilla mode.
- Choose a wallpaper that stays selected across profiles and games.

No account is required. Profiles, preferences, and downloaded packages are stored on your device. The online indicator shows active app sessions; see [Privacy](PRIVACY.md) for details.

## Getting started

1. Open Ember and select your game.
2. Choose a profile, then install mods from **Browse mods**.
3. Select **Launch modded** and complete game setup if prompted.

Use the arrow beside the launch button to switch between modded and vanilla. Your profile stays intact.

<details>
<summary><strong>Game setup</strong></summary>

Close the game before changing its loader or preparing a profile. The setup panel in **Settings** lets you choose the game folder, prepare a profile, or open its folder.

Ember asks before adding the BepInEx Doorstop loader to a clean game installation. It can reuse a compatible loader and remembers your approval unless the loader files change.

PEAK uses **BepInExPack_PEAK**; Lethal Company and R.E.P.O. use **BepInExPack**. If custom Steam launch options interfere, check **Steam → Properties → Launch Options** for that game.

To remove a loader installed by Ember, choose **Remove loader** in the setup panel before uninstalling the app. Check mod listings for compatibility before installing.

</details>

<details>
<summary><strong>Sharing and importing profiles</strong></summary>

Choose **Profiles → Share profile → Create share code** to send a mod list to another Ember user. This uploads the profile to Thunderstore's sharing service. Anyone with the code can import it; creating and resolving codes requires internet access.

**Download JSON** saves a local export. **Import profile** accepts Ember share codes, older `MR1-…` codes, and Ember JSON files, then downloads the required package versions. Native Thunderstore and r2modman archive codes aren't supported.

Review a profile before sharing it, since exports can include its name, package list, and configuration.

</details>

<details>
<summary><strong>Dependencies and downloads</strong></summary>

If a mod needs a disabled requirement, Ember offers to enable the required mods together. Disabling or deleting a requirement lists the mods that depend on it. You can change just the selected mod or all affected mods. Choosing an override may leave dependent mods unable to load.

The **Downloads** tab shows progress and the destination profile. Completed entries clear after 30 seconds; active downloads and failures stay visible. Clearing download history leaves your mods and cached packages in place.

</details>

<details>
<summary><strong>Client updates</strong></summary>

The installed app checks for updates on its loading screen, shows download progress, and reopens after installation. A running game or active profile work delays installation. Failed or stalled checks let you continue into the workspace.

You can also check **Settings → Update client**. If an automatic restart couldn't finish, use **Install and restart** to try again. Portable builds are updated manually from the release page.

If you're upgrading from 0.4.x, install a current release once to get automatic updates. Your profiles and preferences are preserved.

</details>

## Contributing

Ember's source is MIT licensed. Bug reports and contributions are welcome on [GitHub](https://github.com/Ember-Mod-Loader/Ember/issues).

<details>
<summary><strong>Run from source</strong></summary>

Use **Node.js 24**. Desktop packaging requires Windows.

```powershell
npm ci
npm start
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Develop the renderer |
| `npm test` | Run the test suite |
| `npm run build` | Build the renderer |
| `npm run package` | Test and package the Windows builds |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release instructions, and [SECURITY.md](SECURITY.md) for reporting security issues.

</details>

[License](LICENSE) · [Privacy](PRIVACY.md) · [Third-party notices](THIRD-PARTY-NOTICES.md) · [Contributing](CONTRIBUTING.md)

Ember is an independent project, not affiliated with Thunderstore, Steam, or the game developers. Game artwork, mod branding, and third-party libraries retain their respective ownership and licenses.
