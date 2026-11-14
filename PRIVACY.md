# Privacy

Applies to Ember 0.6.16.

## On your device

Wallpaper choices and reward unlocks are stored locally and stay available across profiles and games. Redeeming codes does not contact a server, and profile sharing does not transfer unlocks.

Profiles, favorites, preferences, game setup information, download progress history, and downloaded ZIPs are stored locally. Ember has no account system, behavioral tracking, or app crash-report upload. Game setup reads the local Steam installation information needed to locate Lethal Company, R.E.P.O., PEAK, and MIMESIS. Mods that place files in the game folder have their replaced files backed up locally; edited mod files are kept as recovery copies during restoration.

Ember stores a temporary random presence-session lease in local app data. It is valid for 120 seconds after its last renewal, allowing quick restarts to reuse a session rather than briefly count twice. Each app process receives new connection ownership. Expired leases are ignored and replaced with a new random session; this is not a stable device identifier.

Ember also stores a small update-attempt record containing update versions and timing, used to pause repeated automatic restarts when an earlier update handoff may not have completed.

The size-limited local `logs/app.log` file records the app version, startup and shutdown events, updater activity, process exits, and error details. Error details may include local paths. Old log content is trimmed as the file grows. These diagnostics are not uploaded automatically or sent to the presence service.

Completed download entries clear after 30 seconds and failed entries clear after five minutes. **Clear finished** removes both types of entries for the selected game. These actions affect only download history.

A profile code or JSON export can contain the profile name, game, and package list, along with any settings included in that profile. Anyone who receives an export can read its contents. Review it before sharing.

Thunderstore and r2modman profile imports retrieve the shared archive and check package versions and game associations with Thunderstore. Supported configuration files are stored with the local profile and applied to its runtime. Imported configuration templates are included if you later export or share that Ember profile.

## Network requests

The **online now** indicator contacts Ember's [presence service](https://ember-presence.onrender.com/v1/online), hosted on Render. While the app is open, it sends its temporary random session ID and connection-ownership information, refreshing them about every 30 seconds. The session may be reused across brief restarts through the 120-second local lease described above. No name, stable device identifier, game, profile, or mod list is sent. The service keeps active session and expiration information in memory, expires active sessions after 90 seconds without a heartbeat, and returns only an aggregate count. It retains closed-session retirement records for up to 120 seconds to reject delayed heartbeats; these records are not counted as online.

Closing the app waits briefly for a bounded attempt to remove its session. A failed request does not prevent the app from quitting; the active-session expiration still applies. Counts represent active app sessions rather than verified unique people; multiple devices can count separately. If the service is unavailable, Ember shows an unavailable state instead of an invented count.

Render receives ordinary connection information, including IP addresses, and may retain its own operational logs. Ember's presence service does not record request logs or store IP addresses. See [Render's privacy policy](https://render.com/privacy).

Installed Windows clients contact GitHub Releases at startup to check for stable Ember updates and download a newer installer when available. GitHub receives ordinary connection information such as your IP address and the requested release files; profiles and mod lists are not uploaded as part of updating. Portable builds open the GitHub Releases page only when you choose View releases. Update checks do not require a GitHub login or embedded access token.

Using the live catalog sends the selected game, search text, filters, and package requests to Thunderstore. Loading package artwork or downloading ZIPs also connects to Thunderstore's delivery network. Those services receive ordinary connection information such as your IP address. [Thunderstore privacy policy](https://pages.thunderstore.io/p/privacy-policy)

Ember checks the active profile's installed package versions with Thunderstore when you open it and periodically while Ember is open. These lookups request public package identifiers and game communities. The latest known versions are cached locally so update indicators remain visible offline.

Choosing **Create share code** uploads the exported profile to Thunderstore's profile-sharing service. Both code formats include the profile name, package versions, enabled states, and supported saved configuration text. The Ember format also records the game. Anyone with the resulting code can retrieve the export. Ember uploads profiles only when you create a code. JSON file exports and older offline codes remain available without uploading a profile.

Choosing a Steam launch or opening an external package page hands the action to Steam or your browser. Steam handles its own sign-in and game ownership checks. [Steam privacy policy](https://store.steampowered.com/privacy_agreement/)
