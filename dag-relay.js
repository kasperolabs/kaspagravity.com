#!/usr/bin/env node
/**
 * Kaspa Gravity - DAG Relay Server v3 (Push Subscription Architecture)
 *
 * WHAT CHANGED FROM v2:
 *   v2: Poll kaspad JSON wRPC every 50ms for tips, then fetch each block
 *   v3: Subscribe to blockAdded via Kaspa SDK Borsh endpoint — blocks are PUSHED
 *
 * The browser-facing WebSocket API is IDENTICAL — no frontend changes needed.
 *
 * Requirements:
 *   - kaspa npm package with WASM SDK (nodejs/kaspa) installed
 *   - kaspad running with Borsh endpoint (default :17110)
 *
 * .env:
 *   KASPAD_BORSH_URL  - kaspad wRPC Borsh endpoint (default: ws://127.0.0.1:17110)
 *   KASPAD_JSON_URL   - kaspad wRPC JSON endpoint for getBlock fallback (default: ws://127.0.0.1:18110)
 *   RELAY_PORT        - port for browser clients (default: 8765)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const [key, ...rest] = line.split('=');
        if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
}

// =============================================
// Config
// =============================================
const KASPAD_BORSH_URL = process.env.KASPAD_BORSH_URL || 'ws://127.0.0.1:17110';
const KASPAD_JSON_URL = process.env.KASPAD_JSON_URL || process.env.KASPAD_WS_URL || 'ws://127.0.0.1:18110';
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8765');
const STATIC_DIR = path.join(__dirname, 'public');
const BLOCK_BUFFER_SIZE = 300;
const RECONNECT_DELAY = 3000;
const RPC_TIMEOUT = 8000;
const EXPLORER_BASE = 'https://explorer.kaspa.org';
const KASPA_API = 'https://api.kaspa.org';
const ADDRESS_POLL_INTERVAL = 3000;

// =============================================
// State
// =============================================
let kaspaRpc = null;           // Kaspa SDK RpcClient (Borsh)
let kaspadConnected = false;

// JSON wRPC fallback for getBlock (with transactions)
let jsonWs = null;
let jsonConnected = false;
let jsonRpcId = 1;
const jsonPendingRpc = new Map();

const blockBuffer = [];
const clients = new Map();
let dagInfo = null;
let knownBlocks = new Set();
let blockCount = 0;

// Address monitor (REST API — still polling, subscribeUtxosChanged is next upgrade)
let addressPollTimer = null;
let addressPolling = false;
const lastSeenTxIds = new Map();

// =============================================
// Kaspa SDK - Borsh Push Connection
// =============================================

async function connectKaspaSdk() {
    console.log(`[borsh] Connecting to ${KASPAD_BORSH_URL}...`);

    try {
        const kaspa = require('kaspa');
        const { RpcClient, Encoding } = kaspa;

        kaspaRpc = new RpcClient({
            url: KASPAD_BORSH_URL,
            encoding: Encoding.Borsh,
            networkId: 'mainnet'
        });

        await kaspaRpc.connect();
        kaspadConnected = true;
        console.log('[borsh] Connected');

        // Get initial DAG info
        const info = await kaspaRpc.getInfo();
        console.log(`[borsh] synced=${info.isSynced} utxoIndexed=${info.isUtxoIndexed} v=${info.serverVersion}`);

        const dagResult = await kaspaRpc.getBlockDagInfo();
        dagInfo = {
            network: dagResult.networkName,
            blockCount: dagResult.blockCount,
            headerCount: dagResult.headerCount,
            tipHashes: dagResult.tipHashes,
            difficulty: dagResult.difficulty,
            virtualDaaScore: dagResult.virtualDaaScore
        };
        console.log(`[borsh] DAG: virtualDaaScore=${dagInfo.virtualDaaScore}, tips=${dagInfo.tipHashes?.length}`);

        broadcast({ type: 'status', connected: true, dagInfo: sanitizeDagInfo(dagInfo) });

        // Register event listeners BEFORE subscribing
        kaspaRpc.addEventListener("block-added", (event) => {
            try {
                handleBlockAdded(event);
            } catch (err) {
                console.error('[borsh] block-added handler error:', err.message);
            }
        });

        kaspaRpc.addEventListener("virtual-daa-score-changed", (event) => {
            try {
                if (event && event.virtualDaaScore) {
                    dagInfo.virtualDaaScore = event.virtualDaaScore;
                }
            } catch (err) {}
        });

        kaspaRpc.addEventListener("virtual-chain-changed", (event) => {
            // Could use acceptedTransactionIds for address matching in future
        });

        // Subscribe
        await kaspaRpc.subscribeBlockAdded();
        console.log('[borsh] ✓ subscribeBlockAdded');

        try {
            await kaspaRpc.subscribeVirtualDaaScoreChanged();
            console.log('[borsh] ✓ subscribeVirtualDaaScoreChanged');
        } catch (e) {
            console.log('[borsh] ⚠ subscribeVirtualDaaScoreChanged:', e?.message);
        }

        try {
            await kaspaRpc.subscribeVirtualChainChanged(true);
            console.log('[borsh] ✓ subscribeVirtualChainChanged');
        } catch (e) {
            console.log('[borsh] ⚠ subscribeVirtualChainChanged:', e?.message);
        }

        // Fetch initial history via getBlock on tips
        await loadInitialHistory();

    } catch (err) {
        console.error('[borsh] Connection failed:', err.message);
        kaspadConnected = false;
        broadcast({ type: 'status', connected: false });
        console.log(`[borsh] Retrying in ${RECONNECT_DELAY / 1000}s...`);
        setTimeout(connectKaspaSdk, RECONNECT_DELAY);
    }
}

// Handle push block-added event
function handleBlockAdded(event) {
    // The event contains the full block data
    const blockData = event?.block || event?.data?.block || event;
    if (!blockData) return;

    const block = parseBlockFromSdk(blockData);
    if (!block) return;
    if (knownBlocks.has(block.hash)) return;

    knownBlocks.add(block.hash);
    blockBuffer.push(block);
    if (blockBuffer.length > BLOCK_BUFFER_SIZE) blockBuffer.shift();
    blockCount++;

    // Update DAA from block
    if (block.daaScore > (dagInfo?.virtualDaaScore || 0)) {
        if (dagInfo) dagInfo.virtualDaaScore = block.daaScore;
    }

    broadcastBlock(block);

    if (blockCount % 100 === 0) {
        console.log(`[relay] ${blockCount} blocks pushed, ${clients.size} clients, buf=${blockBuffer.length}`);
    }
}

// Parse block from SDK event format (different from JSON wRPC format)
function parseBlockFromSdk(blockData) {
    try {
        // SDK block-added event structure:
        // { header: { hash, daaScore, timestamp, blueScore, parents [...] }, transactions: [...] }
        // OR it might be wrapped: { block: { header: ..., transactions: ... } }
        let block = blockData.block || blockData;
        let header = block.header || block;

        const hash = header.hash || header.hashMerkleRoot;
        if (!hash) return null;

        // Parents can be in different formats
        let parentHashes = [];
        if (header.parents && Array.isArray(header.parents)) {
            // SDK format: parents is array of { parentHashes: [...] }
            for (const level of header.parents) {
                if (level.parentHashes) {
                    parentHashes = level.parentHashes;
                    break;
                }
            }
            if (parentHashes.length === 0 && typeof header.parents[0] === 'string') {
                parentHashes = header.parents;
            }
        } else if (header.parentsByLevel && header.parentsByLevel[0]) {
            parentHashes = header.parentsByLevel[0];
        } else if (header.directParents) {
            parentHashes = header.directParents;
        }

        const txs = block.transactions || [];

        return {
            hash: hash,
            daaScore: parseInt(header.daaScore || '0'),
            timestamp: parseInt(header.timestamp || '0'),
            blueScore: parseInt(header.blueScore || '0'),
            parentHashes: parentHashes,
            txCount: txs.length,
            addressHits: txs.length > 0 ? extractAddressHitsFromSdk(txs) : {}
        };
    } catch (err) {
        console.error('[parse] SDK block parse error:', err.message);
        return null;
    }
}

function extractAddressHitsFromSdk(transactions) {
    const hits = {};
    for (const tx of transactions) {
        // SDK transaction format may differ from JSON wRPC
        const inputs = tx.inputs || [];
        const outputs = tx.outputs || [];

        for (const input of inputs) {
            // Try various SDK field names for address
            const addr = input?.previousOutpoint?.address
                || input?.verboseData?.address
                || input?.address;
            if (addr && addr.startsWith('kaspa:')) {
                if (!hits[addr]) hits[addr] = { incoming: 0, outgoing: 0 };
                const amount = parseInt(input?.verboseData?.amount || input?.amount || '0');
                hits[addr].outgoing += amount;
            }
        }

        for (const output of outputs) {
            const addr = output?.verboseData?.scriptPublicKeyAddress
                || output?.address
                || output?.scriptPublicKeyAddress;
            if (addr && addr.startsWith('kaspa:')) {
                if (!hits[addr]) hits[addr] = { incoming: 0, outgoing: 0 };
                const amount = parseInt(output.value || output.amount || '0');
                hits[addr].incoming += amount;
            }
        }
    }
    return hits;
}

// Load initial block history so new viewers see existing DAG
async function loadInitialHistory() {
    if (!kaspaRpc) return;

    try {
        const dagResult = await kaspaRpc.getBlockDagInfo();
        const tips = dagResult.tipHashes || [];

        console.log(`[history] Loading from ${tips.length} tips...`);

        // Fetch tip blocks and their parents (2 levels deep)
        const toFetch = new Set(tips);
        let fetched = 0;

        // Level 1: tips
        for (const hash of tips) {
            if (fetched >= BLOCK_BUFFER_SIZE) break;
            try {
                const result = await kaspaRpc.getBlock(hash, true);
                const block = parseBlockFromSdk(result);
                if (block && !knownBlocks.has(block.hash)) {
                    knownBlocks.add(block.hash);
                    blockBuffer.push(block);
                    fetched++;
                    // Add parents to fetch list
                    if (block.parentHashes) {
                        for (const ph of block.parentHashes) toFetch.add(ph);
                    }
                }
            } catch (e) { /* skip */ }
        }

        // Level 2: parents of tips
        for (const hash of toFetch) {
            if (knownBlocks.has(hash) || fetched >= BLOCK_BUFFER_SIZE) continue;
            try {
                const result = await kaspaRpc.getBlock(hash, true);
                const block = parseBlockFromSdk(result);
                if (block && !knownBlocks.has(block.hash)) {
                    knownBlocks.add(block.hash);
                    blockBuffer.push(block);
                    fetched++;
                    if (block.parentHashes) {
                        for (const ph of block.parentHashes) toFetch.add(ph);
                    }
                }
            } catch (e) { /* skip */ }
        }

        // Level 3: grandparents
        for (const hash of toFetch) {
            if (knownBlocks.has(hash) || fetched >= BLOCK_BUFFER_SIZE) continue;
            try {
                const result = await kaspaRpc.getBlock(hash, true);
                const block = parseBlockFromSdk(result);
                if (block && !knownBlocks.has(block.hash)) {
                    knownBlocks.add(block.hash);
                    blockBuffer.push(block);
                    fetched++;
                }
            } catch (e) { /* skip */ }
        }

        // Sort by DAA score
        blockBuffer.sort((a, b) => a.daaScore - b.daaScore);
        if (blockBuffer.length > BLOCK_BUFFER_SIZE) blockBuffer.splice(0, blockBuffer.length - BLOCK_BUFFER_SIZE);

        console.log(`[history] Loaded ${blockBuffer.length} blocks`);

        // Hide loading overlay for any already-connected clients
        broadcast({ type: 'history', blocks: blockBuffer.map(stripBlock) });

    } catch (err) {
        console.error('[history] Failed to load:', err.message);
    }
}

// =============================================
// JSON wRPC fallback (for getBlock with transactions if SDK doesn't include them)
// =============================================

function connectJsonFallback() {
    console.log(`[json] Connecting to ${KASPAD_JSON_URL}...`);
    jsonWs = new WebSocket(KASPAD_JSON_URL);

    jsonWs.on('open', () => {
        jsonConnected = true;
        console.log('[json] Connected (fallback for detailed block fetching)');
    });

    jsonWs.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id && jsonPendingRpc.has(msg.id)) {
            const p = jsonPendingRpc.get(msg.id);
            jsonPendingRpc.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.params || msg.result || {});
        }
    });

    jsonWs.on('close', () => {
        jsonConnected = false;
        for (const [id, p] of jsonPendingRpc) { clearTimeout(p.timer); p.reject(new Error('Connection lost')); }
        jsonPendingRpc.clear();
        setTimeout(connectJsonFallback, RECONNECT_DELAY);
    });

    jsonWs.on('error', (err) => console.error('[json] WS error:', err.message));
}

function jsonRpc(method, params) {
    return new Promise((resolve, reject) => {
        if (!jsonWs || jsonWs.readyState !== WebSocket.OPEN) return reject(new Error('JSON not connected'));
        const id = jsonRpcId++;
        const timer = setTimeout(() => { jsonPendingRpc.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, RPC_TIMEOUT);
        jsonPendingRpc.set(id, { resolve, reject, timer, method });
        jsonWs.send(JSON.stringify({ id, method, params }));
    });
}

// =============================================
// Block parsing (JSON wRPC format — kept for compatibility)
// =============================================

function parseBlock(blockData) {
    const header = blockData.header;
    if (!header || !header.hash) return null;

    return {
        hash: header.hash,
        daaScore: parseInt(header.daaScore || '0'),
        timestamp: parseInt(header.timestamp || '0'),
        blueScore: parseInt(header.blueScore || '0'),
        parentHashes: (header.parentsByLevel && header.parentsByLevel[0]) || [],
        txCount: blockData.transactions ? blockData.transactions.length : 0,
        addressHits: blockData.transactions ? extractAddressHits(blockData.transactions) : {}
    };
}

function extractAddressHits(transactions) {
    const hits = {};
    for (const tx of transactions) {
        if (tx.inputs) {
            for (const input of tx.inputs) {
                const addr = input?.previousOutpoint?.address || input?.verboseData?.address;
                if (addr && addr.startsWith('kaspa:')) {
                    if (!hits[addr]) hits[addr] = { incoming: 0, outgoing: 0 };
                    hits[addr].outgoing += parseInt(input?.verboseData?.amount || '0');
                }
            }
        }
        if (tx.outputs) {
            for (const output of tx.outputs) {
                const addr = output?.verboseData?.scriptPublicKeyAddress;
                if (addr && addr.startsWith('kaspa:')) {
                    if (!hits[addr]) hits[addr] = { incoming: 0, outgoing: 0 };
                    hits[addr].incoming += parseInt(output.value || '0');
                }
            }
        }
    }
    return hits;
}

function matchAddresses(addressHits, watchedSet) {
    if (!watchedSet || watchedSet.size === 0) return [];
    const matches = [];
    for (const addr of watchedSet) {
        if (addressHits[addr]) {
            const hit = addressHits[addr];
            matches.push({
                address: addr,
                incoming: hit.incoming,
                outgoing: hit.outgoing,
                incomingKAS: hit.incoming / 1e8,
                outgoingKAS: hit.outgoing / 1e8,
                direction: hit.incoming > 0 && hit.outgoing > 0 ? 'both' : hit.incoming > 0 ? 'incoming' : 'outgoing'
            });
        }
    }
    return matches;
}

// =============================================
// Broadcasting (UNCHANGED — same API to browser)
// =============================================

function stripBlock(b) {
    return { hash: b.hash, daaScore: b.daaScore, timestamp: b.timestamp, blueScore: b.blueScore, parentHashes: b.parentHashes, txCount: b.txCount };
}

function broadcastBlock(block) {
    for (const [ws, session] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const matches = matchAddresses(block.addressHits, session.addresses);
        const payload = {
            type: 'block',
            block: stripBlock(block),
            matches: matches.length > 0 ? matches : undefined
        };
        try { ws.send(JSON.stringify(payload)); } catch {}
    }
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch {} }
    }
}

function sanitizeDagInfo(info) {
    if (!info) return null;
    return { networkName: info.network, blockCount: info.blockCount, headerCount: info.headerCount, tipHashes: info.tipHashes, difficulty: info.difficulty, virtualDaaScore: info.virtualDaaScore };
}

// =============================================
// Memory pruning
// =============================================
setInterval(function() {
    if (knownBlocks.size > 5000) {
        const iter = knownBlocks.values();
        for (let i = 0; i < 1000; i++) knownBlocks.delete(iter.next().value);
    }
}, 30000);

// =============================================
// HTTP Server
// =============================================

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            mode: 'push-v3',
            kaspadConnected,
            clients: clients.size,
            blocksRelayed: blockCount,
            bufferSize: blockBuffer.length
        }));
    }

    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(STATIC_DIR, filePath);
    if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }); res.end(data); }
    });
});

// =============================================
// WebSocket Server (browser clients) — UNCHANGED API
// =============================================

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const clientId = 'c_' + Math.random().toString(36).substring(2, 10);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[client] ${clientId} connected from ${ip}`);

    clients.set(ws, { addresses: new Set(), id: clientId });

    ws.send(JSON.stringify({
        type: 'welcome',
        clientId,
        kaspadConnected,
        dagInfo: sanitizeDagInfo(dagInfo),
        explorerBase: EXPLORER_BASE,
        bufferSize: blockBuffer.length
    }));

    if (blockBuffer.length > 0) {
        ws.send(JSON.stringify({
            type: 'history',
            blocks: blockBuffer.map(stripBlock)
        }));
    }

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const session = clients.get(ws);
        if (!session) return;

        if (msg.type === 'watchAddresses') {
            const addrs = Array.isArray(msg.addresses) ? msg.addresses : [];
            for (const a of addrs) { if (typeof a === 'string' && a.startsWith('kaspa:')) session.addresses.add(a); }
            ws.send(JSON.stringify({ type: 'watchConfirm', addresses: Array.from(session.addresses), count: session.addresses.size }));
            console.log(`[client] ${session.id} watching ${session.addresses.size} addresses`);
        }
        else if (msg.type === 'unwatchAddresses') {
            const addrs = Array.isArray(msg.addresses) ? msg.addresses : [];
            for (const a of addrs) session.addresses.delete(a);
            ws.send(JSON.stringify({ type: 'watchConfirm', addresses: Array.from(session.addresses), count: session.addresses.size }));
        }
        else if (msg.type === 'unwatchAll') {
            session.addresses.clear();
            ws.send(JSON.stringify({ type: 'watchConfirm', addresses: [], count: 0 }));
        }
        else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
    });

    ws.on('close', () => { console.log(`[client] ${clientId} disconnected`); clients.delete(ws); });
    ws.on('error', () => clients.delete(ws));
});

// =============================================
// Address Monitor (REST API — kept for now, will upgrade to subscribeUtxosChanged)
// =============================================

function startAddressMonitor() {
    if (addressPollTimer) return;
    addressPollTimer = setInterval(pollWatchedAddresses, ADDRESS_POLL_INTERVAL);
    console.log('[addr-monitor] Started (REST polling — upgrade to push pending)');
}

function stopAddressMonitor() {
    if (addressPollTimer) { clearInterval(addressPollTimer); addressPollTimer = null; }
}

function getAllWatchedAddresses() {
    const all = new Set();
    for (const [, session] of clients) {
        for (const addr of session.addresses) all.add(addr);
    }
    return all;
}

async function pollWatchedAddresses() {
    if (addressPolling) return;
    addressPolling = true;

    try {
        const addresses = getAllWatchedAddresses();
        if (addresses.size === 0) { addressPolling = false; return; }

        const addrArr = Array.from(addresses);
        const idx = Math.floor(Date.now() / ADDRESS_POLL_INTERVAL) % addrArr.length;
        const addr = addrArr[idx];

        const txs = await fetchAddressTxs(addr);
        if (!txs || !txs.length) { addressPolling = false; return; }

        if (!lastSeenTxIds.has(addr)) {
            lastSeenTxIds.set(addr, new Set());
            txs.forEach(t => { if (t.transaction_id) lastSeenTxIds.get(addr).add(t.transaction_id); });
            addressPolling = false;
            return;
        }
        const seen = lastSeenTxIds.get(addr);

        for (const tx of txs.slice(0, 5)) {
            const txId = tx.transaction_id;
            if (seen.has(txId)) continue;
            seen.add(txId);

            if (seen.size > 100) {
                const iter = seen.values();
                for (let i = 0; i < 50; i++) seen.delete(iter.next().value);
            }

            let rawIncoming = 0, rawOutgoing = 0;
            if (tx.outputs) {
                for (const out of tx.outputs) {
                    if (out.script_public_key_address === addr) rawIncoming += parseInt(out.amount || '0');
                }
            }
            if (tx.inputs) {
                for (const inp of tx.inputs) {
                    if (inp.previous_outpoint_address === addr) rawOutgoing += parseInt(inp.previous_outpoint_amount || '0');
                }
            }

            let incoming = 0, outgoing = 0;
            if (rawIncoming > 0 && rawOutgoing > 0) {
                const net = rawIncoming - rawOutgoing;
                if (net > 0) incoming = net;
                else if (net < 0) outgoing = Math.abs(net);
                else continue;
            } else {
                incoming = rawIncoming;
                outgoing = rawOutgoing;
            }

            if (incoming === 0 && outgoing === 0) continue;

            const match = {
                address: addr,
                incoming, outgoing,
                incomingKAS: incoming / 1e8,
                outgoingKAS: outgoing / 1e8,
                direction: incoming > 0 && outgoing > 0 ? 'both' : incoming > 0 ? 'incoming' : 'outgoing',
                txId
            };

            for (const [ws, session] of clients) {
                if (ws.readyState !== WebSocket.OPEN) continue;
                if (!session.addresses.has(addr)) continue;
                try {
                    ws.send(JSON.stringify({ type: 'addressAlert', match, blockHash: tx.block_hash ? tx.block_hash[0] : null }));
                } catch {}
            }
        }
    } catch (err) { /* skip */ }
    addressPolling = false;
}

function fetchAddressTxs(addr) {
    return new Promise((resolve) => {
        const url = `${KASPA_API}/addresses/${addr}/full-transactions?limit=5&resolve_previous_outpoints=light`;
        https.get(url, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// =============================================
// Start
// =============================================

httpServer.listen(RELAY_PORT, () => {
    console.log(`
 ============================================
   Kaspa Gravity - DAG Relay v3 (PUSH MODE)
 ============================================
   Relay:    http://0.0.0.0:${RELAY_PORT}
   Borsh:    ${KASPAD_BORSH_URL}
   JSON:     ${KASPAD_JSON_URL}
   Static:   ${STATIC_DIR}
   Mode:     Push subscriptions (no polling!)
 ============================================
    `);
    connectKaspaSdk();
    connectJsonFallback();
    startAddressMonitor();
});

process.on('SIGTERM', () => {
    if (kaspaRpc) try { kaspaRpc.disconnect(); } catch {}
    if (jsonWs) try { jsonWs.close(); } catch {}
    wss.close(); httpServer.close(); process.exit(0);
});
process.on('SIGINT', () => {
    if (kaspaRpc) try { kaspaRpc.disconnect(); } catch {}
    if (jsonWs) try { jsonWs.close(); } catch {}
    wss.close(); httpServer.close(); process.exit(0);
});
