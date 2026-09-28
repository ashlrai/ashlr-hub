# Ashlr Verse phone gateway (operator runbook)

The gateway is **off by default**. It binds a separate `127.0.0.1` port, while the main Hub remains on its own loopback port. A phone uses Cloudflare Access, a Mac-approved passkey, and a short device session. Cloudflare Tunnel must point only to the gateway port, never directly to the Hub.

## Activation order

1. Create a Cloudflare Access self-hosted application for the exact HTTPS phone hostname **before** publishing a Tunnel route. Limit its policy to the intended human identity. Record the Access team domain and application AUD. Have that human sign into an Access application in the same Zero Trust account, then find their UUID in Access Users (or the [Access Users API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/users/methods/list/) filtered by email). Cloudflare documents the application JWT `sub` as that account's user ID; use the exact UUID for `allowedSubjects` and verify it against a signed assertion during local acceptance. Never paste or log the full JWT. Service tokens have an empty `sub` and are denied. See Cloudflare's [application-token claim reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
2. Create a private `0600` JSON config owned by the Mac user. Use an unused gateway port distinct from the Hub's. Example fields (replace every example value):

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

3. Start the installed Verse build on the Mac with `ashlr verse --remote-config /absolute/path/to/private-config.json`. The gateway refuses an invalid/private-config failure and never binds a public interface. Check its printed loopback URL and `/remote/session` through a test client with a valid Access assertion. The main Hub read and mutation tokens are held server-side and withheld from this command's service output; never put them in the phone or Tunnel configuration.
4. Configure Cloudflare Tunnel to connect the published hostname to `http://127.0.0.1:<gatewayPort>`. Verify the Access application and its policy are active before adding or changing DNS. Do not point Tunnel at the main Hub port.
   Before testing HTTPS, require an **Active** edge certificate that covers the phone hostname. If Universal SSL remains `Pending Validation (TXT)`, inspect the authoritative DNS for the displayed `_acme-challenge` name. This zone delegates `_acme-challenge.ashlr.ai` to Vercel; add each *current* Cloudflare validation TXT value in the Vercel delegated zone, alongside its existing TXT records. Verify the values at both Vercel nameservers and wait for the certificate to become Active. Do not remove the delegation or existing validation records just to make this phone route work.
5. On the Mac, run `ashlr verse remote invite <Access-subject> act` (or `read`), enter the displayed confirmation, and use the one-use code on the phone. After passkey registration, inspect `ashlr verse remote pending`; approve the exact pending ID locally with `ashlr verse remote approve <id>`. `ashlr verse remote devices` shows paired IDs; `ashlr verse remote revoke <device-id>` revokes one. The operator socket is a private Unix socket; no remote HTTP route performs approval or revocation.
6. From a real iPhone on cellular, verify Access sign-in, passkey login, mobile shell, live read/SSE, Needs-you actions, and fresh device authentication for Stop/merge. Revoke that phone on the Mac and verify reads, writes, and open streams stop. Confirm sleep/offline UI when the Mac is unreachable. Grant push permission on the phone only after push is configured and test a content-free notification for Needs-you/completion.

## Mac availability and limits

The Mac must be awake and online for live reads and actions. Use AC power. For a resident Mac session, configure a user LaunchAgent whose `ProgramArguments` are the absolute paths for `/usr/bin/caffeinate`, `-i`, `-s`, the installed `ashlr` executable, `verse`, `--no-open`, `--remote-config`, and the private config file. Set `RunAtLoad` and `KeepAlive` true, and keep its stdout/stderr log files private. Install and verify that LaunchAgent separately; the command above does not alter existing launchd services. `caffeinate -s` asserts system sleep prevention only on AC, so battery behavior and a closed lid still require a real acceptance check. Supervise `cloudflared` separately, after Access is active. The existing Ashlr daemon service also has an opt-in `keepAwake` path using `caffeinate -i -s`; it does not automatically supervise this Verse gateway.

Explicit `--remote-config` startup generates a private VAPID key once and retains it across restarts; the private key stays on the Mac. The code alone does not establish a Cloudflare account, Access policy, Tunnel, DNS, resident services, or iOS push permission. Treat the phone URL and notifications as live only after those external steps and the real-phone checks pass.
