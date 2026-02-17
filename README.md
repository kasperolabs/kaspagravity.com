# Kaspa Gravity

### 3D BlockDAG Visualizer | Kaspathon Submission

**Live:** [kaspagravity.com](https://kaspagravity.com)

Kaspa Gravity renders the Kaspa BlockDAG as a real-time 3D helix — showing parallel blocks, parent-child relationships, and transaction flow as they happen on mainnet. It connects directly to a Kaspa full node via wRPC Borsh push subscriptions and visualizes the DAG structure that makes Kaspa unique.

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
┌─────────────┐   wRPC Borsh (push)  ┌──────────────┐   WebSocket      ┌─────────────┐
│   kaspad     │◄────────────────────►│  dag-relay   │◄────────────────►│   Browser    │
│  full node   │   port 17110         │   (Node.js)  │   port 8765      │  (Three.js)  │
│              │   subscribeBlockAdded │              │   batched blocks  │              │
│  --rpclisten │   getBlock            │  2500-block   │   address alerts  │  3D helix    │
│  -borsh      │   getBlockDagInfo     │  sliding      │   server-driven   │  rendering   │
│  -json       │                      │  window       │   pruning         │              │
└─────────────┘                       └──────────────┘                   └─────────────┘
```

### Relay Server (`dag-relay.js`)

The relay is a lightweight Node.js process that bridges kaspad to browser clients. It uses the Kaspa WASM SDK to subscribe to block events — blocks are pushed, not polled.

**How it receives blocks:**
1. Connects to kaspad via wRPC Borsh using the Kaspa SDK `RpcClient`
2. Subscribes to `blockAdded` events — kaspad pushes every new block instantly
3. Also subscribes to `virtualDaaScoreChanged` for accurate DAA tracking
4. Parses block headers, parent hashes, and transaction data from each event
5. Queues blocks and flushes to clients every 200ms as batched messages
6. Each batch includes blocks to add and old block hashes to remove
7. Server maintains a per-client sliding window (2500 blocks) — the frontend just obeys

**Fallback:** A JSON wRPC connection (port 18110) is maintained for `getBlock` calls when the SDK event doesn't include full transaction data.

**Per-client address matching:**
Each browser client can watch unlimited Kaspa addresses. The relay matches addresses against every block's transactions and sends directional data (incoming/outgoing/both) with KAS amounts per match. A REST API poller against `api.kaspa.org` provides confirmed transaction alerts with accurate amounts.

**Reliability:**
- Disconnect/error listeners on the SDK connection trigger automatic reconnection
- A watchdog timer detects stalled push subscriptions (no blocks for 30s) and force-reconnects
- Address polling has safety timeouts to prevent stuck flags
- BigInt values from the Borsh decoder are serialized safely for JSON transport

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

**Performance:**
All block geometries, glow geometries, edge materials, and glow materials are shared instances — no per-object allocation. Raycasting for hover detection is throttled to every 3rd frame with a cached mesh array. The server controls the block count, so the frontend never accumulates unbounded objects.

**Camera Modes:**
- **Follow** — tracks the latest blocks, looking forward along the DAG. Scroll to zoom.
- **Orbit** — cinematic rotation around the current tip. Scroll to zoom.
- **Free** — FPS-style camera: left-drag to look, right-drag to pan, scroll to fly forward/backward. Completely untethered — explore the full DAG history.

**Block Interactions:**
- Hover any block to see DAA score, blue score, transaction count, parent count
- Click any block to open it in the Kaspa block explorer

---

## Running Your Own Instance

### Prerequisites

- A Kaspa full node (`kaspad`) with wRPC Borsh and JSON enabled
- Node.js 18+

### 1. Configure kaspad

Your kaspad node needs both RPC listener flags:

```bash
kaspad --rpclisten-borsh=0.0.0.0:17110 --rpclisten-json=0.0.0.0:18110 --utxoindex
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
KASPAD_BORSH_URL=ws://YOUR_KASPAD_NODE_IP:17110
KASPAD_JSON_URL=ws://YOUR_KASPAD_NODE_IP:18110
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

**`history`** — block buffer sent after welcome
```json
{ "type": "history", "blocks": [{ "hash": "abc...", "daaScore": 356799000, "parentHashes": ["def..."], "txCount": 3 }] }
```

**`batch`** — primary real-time message, sent every 200ms
```json
{
  "type": "batch",
  "blocks": [{ "hash": "abc...", "daaScore": 356800001, "parentHashes": ["xyz..."], "txCount": 5 }],
  "matches": [null, [{ "address": "kaspa:qr...", "incomingKAS": 5.0, "direction": "incoming" }]],
  "remove": ["old_hash_1...", "old_hash_2..."]
}
```
`blocks` and `matches` are parallel arrays. `remove` contains hashes the frontend should delete (server-driven pruning).

**`addressAlert`** — confirmed transaction from REST API
```json
{ "type": "addressAlert", "match": { "address": "kaspa:qr...", "incomingKAS": 5.0, "direction": "incoming", "txId": "abc..." }, "blockHash": "def..." }
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
| Node runtime | kaspad full node with `--rpclisten-borsh` and `--rpclisten-json` |
| Relay server | Node.js + Kaspa WASM SDK + `ws` |
| Frontend | Vanilla JS + Three.js r128 (CDN) |
| 3D rendering | Three.js with shared Phong materials, fog, point lights |
| Hosting | Nginx reverse proxy, Cloudflare CDN |
| Block data | Kaspa SDK `subscribeBlockAdded` (push) + `getBlock` (fetch) |

Zero build tools. Zero frameworks. Two files.

---

## Known Limitations

- **No UTXO resolution for inputs** — input addresses require resolving previous outpoints, which `blockAdded` events don't include. The REST API poller partially addresses this for watched addresses, but block-level input matching is limited.
- **REST address monitor polls one address per cycle** — with many watched addresses, detection latency increases proportionally. A future upgrade to `subscribeUtxosChanged` would make this instant.

---

## License

MIT — do whatever you want with it.

---

Built by [Kaspero Labs](https://kasperolabs.com) for the Kaspa ecosystem.

*Kaspa Gravity visualizes the invisible — showing that "10 blocks per second" isn't just a number, it's a living, breathing, parallel structure.*
