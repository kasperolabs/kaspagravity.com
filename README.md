# Kaspa Gravity

### 3D BlockDAG Visualizer | Kaspathon Submission

**Live:** [kaspagravity.com](https://kaspagravity.com)

Kaspa Gravity renders the Kaspa BlockDAG as a real-time 3D helix — showing parallel blocks, parent-child relationships, and transaction flow as they happen on mainnet. It connects directly to a Kaspa full node via wRPC JSON and visualizes the DAG structure that makes Kaspa unique.

![Kaspa Gravity Screenshot](https://kasperolabs.com/gravity-screenshot.png)

---

## What It Shows

Kaspa produces ~10 blocks per second from independent miners working in parallel. Unlike a traditional blockchain (one block at a time, single file), Kaspa's BlockDAG merges all these parallel blocks together. Kaspa Gravity makes this visible:

- **Parallel blocks** at the same DAA score spread outward from the helix spine — you can literally see multiple miners producing blocks simultaneously
- **Parent-child edges** connect blocks to their parents, showing the DAG topology
- **Address tracking** highlights blocks containing transactions for watched addresses — add any `kaspa:` address and see incoming (green), outgoing (red), or both (amber) in real time
- **The helix structure** rotates blocks around a central axis as DAA score advances, creating a DNA-like visualization of the BlockDAG flowing through time

One surprising thing we discovered while building this: a single transaction doesn't just appear in one block — it shows up across 10-20 parallel blocks simultaneously. That's the DAG at work.

---

## Architecture

```
┌─────────────┐     wRPC JSON      ┌──────────────┐    WebSocket     ┌─────────────┐
│   kaspad     │◄──────────────────►│  dag-relay   │◄────────────────►│   Browser    │
│  full node   │   port 18110       │   (Node.js)  │   port 8765      │  (Three.js)  │
│              │   getBlockDagInfo   │              │   block stream    │              │
│  --rpclisten │   getBlock          │  300-block    │   address alerts  │  3D helix    │
│  -json=18110 │                    │  ring buffer  │   history sync    │  rendering   │
└─────────────┘                     └──────────────┘                   └─────────────┘
```

### Relay Server (`dag-relay.js`)

The relay is a lightweight Node.js process that bridges kaspad's wRPC JSON interface to browser WebSocket clients.

**How it polls for blocks:**
1. Every 50ms, calls `getBlockDagInfo` to get current tip hashes
2. Compares tips against known blocks — new tips get queued for fetching
3. Calls `getBlock` with `includeTransactions: true` for each new block
4. Chases parent hashes to catch blocks that appeared between polls
5. Parses transactions, extracts addresses and amounts from outputs
6. Broadcasts block data to all connected browser clients
7. Maintains a 300-block ring buffer so new clients get instant history

**Per-client address matching:**
Each browser client can watch unlimited Kaspa addresses. The relay matches addresses against every block's transactions and sends directional data (incoming/outgoing/both) with KAS amounts per match. This means the heavy lifting happens server-side once per block, not per-client.

### Frontend (`public/index.html`)

Single-file Three.js application — no build step, no framework, no dependencies beyond Three.js from CDN.

**3D Helix Positioning:**
```
helixAngle = daaOffset * 0.06        // Rotation speed around axis
cx = cos(helixAngle) * helixRadius    // Helix center X
cy = sin(helixAngle) * helixRadius    // Helix center Y
z  = daaOffset * zScale              // Forward flow along Z
```
Blocks at the same DAA score spread outward from the helix center using golden angle distribution for even spacing.

**Camera Modes:**
- **Follow** — tracks the latest blocks, looking forward along the DAG
- **Orbit** — cinematic rotation around the current tip
- **Free** — mouse drag and scroll for manual exploration

**Block Interactions:**
- Hover any block to see DAA score, blue score, transaction count, parent count
- Click any block to open it in the Kaspa block explorer

---

## Running Your Own Instance

### Prerequisites

- A Kaspa full node (`kaspad`) with wRPC JSON enabled
- Node.js 18+
- `ws` npm package (only dependency)

### 1. Configure kaspad

Your kaspad node needs the JSON RPC listener flag:

```bash
kaspad --rpclisten-json=0.0.0.0:18110 --utxoindex
```

The `--utxoindex` flag is required for transaction data in block responses.

### 2. Clone and install

```bash
git clone https://github.com/kasperolabs/kaspagravity.com.git
cd kaspagravity.com
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
KASPAD_WS_URL=ws://YOUR_KASPAD_NODE_IP:18110
RELAY_PORT=8765
```

### 4. Run

```bash
node dag-relay.js
```

Open `http://localhost:8765` in your browser.

### 5. Production deployment (optional)

For running behind Nginx + Cloudflare, see `DEPLOY.conf` for systemd service, Nginx config with WebSocket proxy, and Cloudflare SSL setup.

---

## WebSocket Protocol

Browser clients connect to the relay via WebSocket. The protocol is simple JSON messages:

### Server → Client

**`welcome`** — sent on connect
```json
{ "type": "welcome", "clientId": "c_a1b2c3d4", "kaspadConnected": true, "dagInfo": { "virtualDaaScore": 356800000 } }
```

**`history`** — 300-block buffer sent after welcome
```json
{ "type": "history", "blocks": [{ "hash": "abc...", "daaScore": 356799000, "parentHashes": ["def..."], "txCount": 3 }] }
```

**`block`** — real-time block with optional address matches
```json
{ "type": "block", "block": { "hash": "abc...", "daaScore": 356800001, "parentHashes": ["xyz..."], "txCount": 5 }, "matches": [{ "address": "kaspa:qr...", "incoming": 500000000, "incomingKAS": 5.0, "direction": "incoming" }] }
```

### Client → Server

**`watchAddresses`** — track addresses
```json
{ "type": "watchAddresses", "addresses": ["kaspa:qr..."] }
```

**`unwatchAddresses`** / **`unwatchAll`** — stop tracking

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Node runtime | kaspad full node with `--rpclisten-json` |
| Relay server | Node.js + `ws` (single dependency) |
| Frontend | Vanilla JS + Three.js r128 (CDN) |
| 3D rendering | Three.js with Phong materials, fog, point lights |
| Hosting | Nginx reverse proxy, Cloudflare CDN |
| Block data | kaspad wRPC JSON (`getBlockDagInfo`, `getBlock`) |

Zero build tools. Zero frameworks. Two files.

---

## Known Limitations

- **BPS reads ~5-6** vs node's actual ~10 BPS — polling at 50ms catches most but not all blocks between tip changes. Subscription-based block notifications would solve this but kaspad's wRPC JSON subscribe methods are not yet fully documented.
- **No UTXO resolution for inputs** — input addresses require resolving previous outpoints, which kaspad's `getBlock` response doesn't include in verbose mode. Currently only output (receiving) addresses are tracked.
- **Memory grows with long sessions** — the sliding DAA window keeps ~5000 DAA scores of blocks. Very long sessions may need a page refresh.

---

## License

MIT — do whatever you want with it.

---

Built by [Kaspero Labs](https://kasperolabs.com) for the Kaspa ecosystem.

*Kaspa Gravity visualizes the invisible — showing that "10 blocks per second" isn't just a number, it's a living, breathing, parallel structure.*
