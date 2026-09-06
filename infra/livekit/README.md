# LiveKit

The voice server. It does the SFU, TURN, echo cancellation, device handling and
screen share; the chat server only mints tokens and listens for webhooks.

## Install (once)

There is no Docker on this box, so LiveKit runs as a plain Windows binary.

1. Download `livekit_<version>_windows_amd64.zip` from
   <https://github.com/livekit/livekit/releases> (the official repo — check the
   URL before you run anything you downloaded).
2. Unzip it and put `livekit-server.exe` in `infra/livekit/bin/`.
   That folder is gitignored; the binary is not committed.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File infra\livekit\start.ps1
```

It runs in the foreground and logs to the console. Leave it open; Ctrl-C stops
it. `ws://localhost:7880` is then live, and the chat server's
`POST /api/channels/:id/voice-token` mints tokens LiveKit will accept.

Check it answers:

```powershell
curl http://localhost:7880
```

`OK` means the server is up.

## Ports to open for people outside your network

| Port | Protocol | What |
|---|---|---|
| 7880 | TCP | Signalling (the `ws://` the client connects to) |
| 7881 | TCP | WebRTC over TCP, the fallback when UDP is blocked |
| 3478 | UDP | TURN, the relay for anyone UDP-blocked entirely |
| 50000–50100 | UDP | The media itself |

## The one setting that will otherwise cost you an evening

`rtc.use_external_ip: true` in `livekit.yaml`. Without it LiveKit advertises the
address of its own network interface — behind a router, a `192.168.x.x` nobody
outside can reach. The failure looks like success: everyone connects, the UI
shows them in the channel, and no audio ever arrives.

## Keys

`livekit.yaml` holds this deployment's own API key and secret, and
`apps/server/.env` holds the same pair. They must match — the chat server signs
join tokens with them and LiveKit verifies the signature.

`--dev` mode is deliberately not used: its key pair is published in LiveKit's
own repository, so anyone who could reach port 7880 could mint themselves a
valid token.

## Prove it works before blaming your own code

Worth half an hour, once. Clone `livekit-examples/meet`, run it locally, point
it at `ws://<your-ip>:7880`, and call someone on another ISP. Use the local
copy, not the hosted `meet.livekit.io` — that page is HTTPS and browsers block
a plain `ws://` connection from it.

After that, every voice problem is in the app, not the setup, and you never have
to wonder which.
