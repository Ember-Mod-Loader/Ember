# Privacy

Applies to Ember 0.5.2.

## On your device

Profiles, favorites, preferences, game setup information, download progress history, and downloaded ZIPs are stored locally. Ember has no account system, behavioral tracking, or app crash-report upload. Game setup reads the local Steam installation information needed to locate Lethal Company, R.E.P.O., and PEAK.

Completed download-history entries clear automatically after 30 seconds, or when you choose Clear completed. This clears the history entries only; profiles, installed mods, and cached download files stay on your device.

A profile code or JSON export can contain the profile name, game, and package list, along with any settings included in that profile. Anyone who receives an export can read its contents. Review it before sharing.

## Network requests

The **online now** indicator contacts Ember's [presence service](https://ember-presence.onrender.com/v1/online), hosted on Render. While the app is open, it sends a new random session ID generated for that app process, refreshing it about every 30 seconds. The ID is never saved to disk. No name, persistent device identifier, game, profile, or mod list is sent. The service keeps session IDs and expiration times in memory, removes sessions after 90 seconds without a heartbeat, and returns only an aggregate count. Closing the app attempts to remove its session immediately. Counts represent active app sessions rather than verified unique people; multiple devices can count separately. If the service is unavailable, Ember shows an unavailable state instead of an invented count.

Render receives ordinary connection information, including IP addresses, and may retain its own operational logs. Ember's presence service does not record request logs or store IP addresses. See [Render's privacy policy](https://render.com/privacy).

Installed Windows clients contact GitHub Releases at startup to check for stable Ember updates and download a newer installer when available. GitHub receives ordinary connection information such as your IP address and the requested release files; profiles and mod lists are not uploaded as part of updating. Portable builds open the GitHub Releases page only when you choose View releases. Update checks do not require a GitHub login or embedded access token.

Using the live catalog sends the selected game, search text, filters, and package requests to Thunderstore. Loading package artwork or downloading ZIPs also connects to Thunderstore's delivery network. Those services receive ordinary connection information such as your IP address. [Thunderstore privacy policy](https://pages.thunderstore.io/p/privacy-policy)

Choosing **Create share code** uploads the exported profile to Thunderstore's profile-sharing service. The export includes its name, game, package versions, enabled states, and any settings or configuration text saved in the profile. Anyone with the resulting code can retrieve that export. Profiles are uploaded only when you choose this action. Importing a short code retrieves its profile from Thunderstore. JSON file exports and older offline codes remain available without publishing a profile.

Choosing a Steam launch or opening an external package page hands the action to Steam or your browser. Steam handles its own sign-in and game ownership checks. [Steam privacy policy](https://store.steampowered.com/privacy_agreement/)
