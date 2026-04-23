# Wiwave

LAN voice chat, no accounts, no cloud, no noise.

Wiwave is a tiny self-hosted voice chat you run on your own Wi-Fi. Everyone opens the same URL on the same network, picks a name, joins a room, and talks. Audio goes **peer-to-peer** through the browser (WebRTC) — the server only helps people find each other. Built-in **RNNoise** and an **adjustable noise gate** keep fans, keyboards, and background hum out of the call.

You can even host it from your **Android phone** using Termux.

---

## What you get

- 🔒 **LAN-only** — nothing leaves your network, no sign-up, no tracking
- 🎙️ **Clean audio** — RNNoise (neural noise suppression) + a noise gate with a threshold slider and live meter
- 📱 **Works on phones** — iPhone Safari, Android Chrome, any modern browser
- ⚡ **Low latency** — peer-to-peer WebRTC audio over the LAN
- 🧰 **Tiny stack** — Node + Express + one WebSocket. Two dependencies that matter.

---

## Requirements

- **Node.js 20.6 or newer** (for native `--env-file` support)
- A device to run the server on — a laptop, desktop, Raspberry Pi, or an Android phone with [Termux](https://termux.dev/)
- All participants on the **same Wi-Fi / hotspot**

---

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/NeilAdrian-0423/Wiwave.git
cd Wiwave
npm install

# 2. Generate a self-signed HTTPS cert (required — mics only work over HTTPS)
npm run cert

# 3. (Optional) pick a port
echo "PORT=3003" > .env

# 4. Start the server
npm start
```

On start you'll see something like:

```
voicechat listening on :3003
  https://192.168.1.42:3003
  https://10.0.0.7:3003
```

Open any of those URLs on your phone or another computer on the same Wi-Fi.

---

## First-time connection (accepting the cert)

Because the cert is self-signed, every browser will warn you the first time:

- **Chrome / Edge** — click *Advanced* → *Proceed to … (unsafe)*
- **Safari (iOS)** — tap *Show Details* → *visit this website*
- **Firefox** — *Advanced* → *Accept the Risk and Continue*

This is safe — the warning just means your browser hasn't seen this cert before. Each device does it once.

> **iOS tip:** if the mic doesn't prompt, make sure the URL starts with `https://`. Audio only works in secure contexts.

---

## Using it

1. Type your name, tap **Continue**
2. Pick a room — you'll see who's already in each one
3. Grant microphone access
4. Talk!

**Controls inside a room:**

| Control   | What it does |
|-----------|-----|
| **Mute**  | Stops sending your mic without leaving |
| **Audio** | Opens the DSP panel |
| **RNNoise** | Neural noise suppression (on by default) |
| **Noise gate** | Mutes you when you're below the threshold |
| **Threshold** | dB level below which the gate closes. Drag until your quiet breathing is *just* below the tick, then talking opens the gate cleanly. |
| **Meter** | Shows your live level. Green = gate open. |
| **Leave**  | Disconnect and return to the room list |

---

## Running on an Android phone (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs git
git clone https://github.com/NeilAdrian-0423/Wiwave.git
cd Wiwave
npm install
npm run cert
npm start
```

Then on the same phone (or any device on the same Wi-Fi), open the `https://<phone-ip>:<port>` URL printed at startup.

> Turn on **Wi-Fi hotspot** if there's no router — Wiwave will print hotspot interfaces too.

---

## Configuration

Everything fits in one `.env` file:

```env
PORT=3003
```

That's it. Rooms are hardcoded to `general`, `room-2`, `room-3` — edit the `ROOMS` array in `server.js` if you want more.

---

## Troubleshooting

**"Missing cert.pem / key.pem"** — run `npm run cert` once.

**Mic permission denied on iPhone** — the page must be opened over `https://` (not `http://`) and you must accept the self-signed cert first. Try reloading after accepting.

**"RNNoise unavailable (sample-rate-44100)"** — your browser refused to open a 48 kHz audio context. The noise gate still works; RNNoise doesn't. Common on some older Android devices.

**I hear myself** — don't use speakers on both sides — use headphones. Browser echo cancellation helps but can't fix a mic pointed at a loud speaker.

**Works for me, not for my friend on the same Wi-Fi** — some routers isolate client devices ("AP isolation"). Turn that off, or use a phone hotspot.

---

## How it's built

- `server.js` — HTTPS + Express + one WebSocket. Handles signaling only.
- `public/client.js` — UI state, room list, WebRTC mesh, DSP wiring.
- `public/worklet-processor.js` — AudioWorklet that runs RNNoise + the noise gate.
- `public/index.html` / `style.css` — dark, phone-friendly UI.
- `generate-cert.js` — writes a 10-year self-signed cert.

Audio signal path on every device:

```
mic → MediaStreamSource → AudioWorklet (RNNoise → gate) → MediaStreamDestination → RTCPeerConnection → peers
```

---

## License

MIT — do whatever you want with it.
