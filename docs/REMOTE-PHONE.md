# Ashlr Verse phone gateway (operator runbook)

The gateway is **off by default**. For full-time desktop and phone use, the installed Ashlr app owns the main Verse server on `127.0.0.1:7777`. Creating the private `~/.ashlr/verse-remote.json` file explicitly opts that app's sidecar into a separate loopback phone gateway. A phone uses Cloudflare Access, a Mac-approved passkey, and a short device session. Cloudflare Tunnel must point only to the gateway port, never directly to the Hub.

## Activation order

1. Create a Cloudflare Access self-hosted application for the exact HTTPS phone hostname **before** publishing a Tunnel route. Limit its policy to the intended human identity. Record the Access team domain and application AUD. Have that human sign into an Access application in the same Zero Trust account, then find their UUID in Access Users (or the [Access Users API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/users/methods/list/) filtered by email). Cloudflare documents the application JWT `sub` as that account's user ID; use the exact UUID for `allowedSubjects` and verify it against a signed assertion during local acceptance. Never paste or log the full JWT. Service tokens have an empty `sub` and are denied. See Cloudflare's [application-token claim reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
2. Create `~/.ashlr/verse-remote.json` as a private `0600` JSON file owned by the Mac user (`~/.ashlr` should be `0700`). The installed app reads this exact path at every sidecar start. Use an unused gateway port distinct from the Hub's. Example fields (replace every example value):

   ```json
   {
     "access": {
       "publicOrigin": "https://phone.example.com",
       "teamDomain": "https://your-team.cloudflareaccess.com",
       "audience": "64-character-Access-application-AUD-hex-value",
       "allowedSubjects": ["exact-Access-subject-ID"]
     },
     "gatewayPort": 7788
   }
   ```

3. Quit and reopen the installed Ashlr app. It starts its own `ashlr verse` sidecar with `--remote-config ~/.ashlr/verse-remote.json` only while that file exists. Invalid ownership, mode, or Access config fails the opted-in startup visibly; the app does not fall back to a server without a phone gateway. Verify that the main Verse window works with its own tokens and that the separate gateway listens only on `127.0.0.1:<gatewayPort>`. Check `/remote/session` through a test client with a valid Access assertion. The main Hub read and mutation tokens stay server-side; never put them in the phone or Tunnel configuration. Stop any separately launched `ashlr verse` on port 7777 before opening the app; the two cannot own the same main server.
4. Configure Cloudflare Tunnel to connect the published hostname to `http://127.0.0.1:<gatewayPort>`. Verify the Access application and its policy are active before adding or changing DNS. Do not point Tunnel at the main Hub port.
   Before testing HTTPS, require an **Active** edge certificate that covers the phone hostname. If Universal SSL remains `Pending Validation (TXT)`, inspect the authoritative DNS for the displayed `_acme-challenge` name. This zone delegates `_acme-challenge.ashlr.ai` to Vercel; add each *current* Cloudflare validation TXT value in the Vercel delegated zone, alongside its existing TXT records. Verify the values at both Vercel nameservers and wait for the certificate to become Active. Do not remove the delegation or existing validation records just to make this phone route work.
5. On the Mac, run `ashlr verse remote invite <Access-subject> act` (or `read`), enter the displayed confirmation, and use the one-use code on the phone. After passkey registration, inspect `ashlr verse remote pending`; approve the exact pending ID locally with `ashlr verse remote approve <id>`. `ashlr verse remote devices` shows paired IDs; `ashlr verse remote revoke <device-id>` revokes one. The operator socket is a private Unix socket; no remote HTTP route performs approval or revocation.
6. From a real iPhone on cellular, verify Access sign-in, passkey login, mobile shell, live read/SSE, Needs-you actions, and fresh device authentication for Stop/merge. Revoke that phone on the Mac and verify reads, writes, and open streams stop. Confirm sleep/offline UI when the Mac is unreachable. Grant push permission on the phone only after push is configured and test a content-free notification for Needs-you/completion.

To disable the phone gateway, rename or remove `~/.ashlr/verse-remote.json`, then quit and reopen Ashlr. Confirm the gateway port has closed; the desktop Verse window should still work. A sidecar crash restart also re-reads the file, so a removed config stays disabled. Keep the file private while it is renamed or stored as a backup. For a one-off CLI test instead of the desktop app, quit Ashlr first and run `ashlr verse --remote-config /absolute/path/to/private-config.json`; stop that process before reopening Ashlr, since both default to main port 7777.

## Mac availability and limits

The Mac must be awake and online, and the installed Ashlr app must remain running, for live reads and actions. Use AC power and verify the app restarts after login if that is part of the intended daily setup. A separate `ashlr verse` LaunchAgent on port 7777 conflicts with the desktop-owned server and must be disabled for this mode. Supervise `cloudflared` separately after Access is active; on this Mac it uses the `ai.ashlr.verse-cloudflared` user LaunchAgent. A `caffeinate -i -s` process can prevent idle system sleep on AC, but battery behavior and a closed lid still require a real acceptance check. The existing Ashlr daemon's `keepAwake` setting does not supervise the desktop app or phone gateway.

Explicit remote-config startup generates a private VAPID key once and retains it across restarts; the private key stays on the Mac. The code alone does not establish a Cloudflare account, Access policy, Tunnel, DNS, resident services, or iOS push permission. Treat the phone URL and notifications as live only after those external steps and the real-phone checks pass.

For `remote.ashlr.ai`, `_acme-challenge.ashlr.ai` is NS-delegated to Vercel. Cloudflare's initial Universal SSL validation required two current TXT values in that delegated Vercel zone alongside the existing TXT records. Keep the existing values and verify the authoritative answers and Cloudflare certificate status before using the hostname. Universal certificates have a 90-day lifetime; Cloudflare starts renewal 30 days before expiry and may fall back from HTTP validation to TXT. Monitor issuance and renewal, and update the delegated TXT values if a future challenge rotates.
