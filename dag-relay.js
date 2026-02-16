#!/usr/bin/env node
/**
 * Kaspa Gravity - DAG Relay Server v2 (Lazy Parent Architecture)
 *
 * Tip blocks arrive instantly from kaspad polling.
 * Parent blocks are lazily fetched in the background — one at a time,
 * never blocking the main poll loop.
 *
 * Usage:   node dag-relay.js
 *
 * .env:
 *   KASPAD_WS_URL  - kaspad wRPC JSON endpoint
 *   RELAY_PORT     - port for browser clients (default: 8765)
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
const KASPAD_URL = process.env.KASPAD_WS_URL || 'ws://127.0.0.1:18110';
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8765');
const STATIC_DIR = path.join(__dirname, 'public');
const BLOCK_BUFFER_SIZE = 300;
const RECONNECT_DELAY = 3000;
const RPC_TIMEOUT = 8000;
const POLL_INTERVAL = 50;
const EXPLORER_BASE = 'https://explorer.kaspa.org';
const KASPA_API = 'https://api.kaspa.org';
const ADDRESS_POLL_INTERVAL = 3000;
const LAZY_FETCH_INTERVAL = 80;

// =============================================
// State
// =============================================
let kaspadWs = null;
let kaspadConnected = false;
let rpcId = 1;
const pendingRpc = new Map();
const blockBuffer = [];
const clients = new Map();
let dagInfo = null;
let knownBlocks = new Set();
let knownStubs = new Set();
let pollTimer = null;
let blockCount = 0;
let polling = false;
let lastSuccessfulPoll = Date.now();

// Lazy fetch queue for parent blocks
const lazyQueue = [];
let lazyTimer = null;
let lazyFetching = false;

// Address monitor
let addressPollTimer = null;
let addressPolling = false;
const lastSeenTxIds = new Map();

// Watchdog
setInterval(function() {
    if (Date.now() - lastSuccessfulPoll > 15000 && kaspadConnected) {
        console.log("[watchdog] No successful poll in 15s, reconnecting...");
        try { kaspadWs.close(); } catch(e) {}
    }
    if (polling && pendingRpc.size === 0) polling = false;
}, 5000);

// =============================================
// kaspad wRPC JSON connection
// =============================================

function connectToKaspad() {
    console.log(`[kaspad] Connecting to ${KASPAD_URL}...`);
    if (kaspadWs) { try { kaspadWs.close(); } catch {} }

    kaspadWs = new WebSocket(KASPAD_URL);

    kaspadWs.on('open', async () => {
        kaspadConnected = true;
        console.log('[kaspad] Connected');
        try {
            dagInfo = await rpc('getBlockDagInfo', {});
            console.log(`[kaspad] DAG synced. virtualDaaScore=${dagInfo.virtualDaaScore}, tips=${dagInfo.tipHashes?.length}`);
            if (dagInfo.tipHashes) dagInfo.tipHashes.forEach(h => knownBlocks.add(h));
            startPolling();
            startLazyFetcher();
            broadcast({ type: 'status', connected: true, dagInfo: sanitizeDagInfo(dagInfo) });
        } catch (err) {
            console.error('[kaspad] Init error:', err.message);
        }
    });

    kaspadWs.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id && pendingRpc.has(msg.id)) {
            const p = pendingRpc.get(msg.id);
            pendingRpc.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.params || msg.result || {});
        }
    });

    kaspadWs.on('close', () => {
        kaspadConnected = false;
        console.log('[kaspad] Disconnected, reconnecting...');
        stopPolling();
        stopLazyFetcher();
        for (const [id, p] of pendingRpc) { clearTimeout(p.timer); p.reject(new Error('Connection lost')); }
        pendingRpc.clear();
        broadcast({ type: 'status', connected: false });
        setTimeout(connectToKaspad, RECONNECT_DELAY);
    });

    kaspadWs.on('error', (err) => console.error('[kaspad] WS error:', err.message));
}

function rpc(method, params) {
    return new Promise((resolve, reject) => {
        if (!kaspadWs || kaspadWs.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
        const id = rpcId++;
        const timer = setTimeout(() => { pendingRpc.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, RPC_TIMEOUT);
        pendingRpc.set(id, { resolve, reject, timer, method });
        kaspadWs.send(JSON.stringify({ id, method, params }));
    });
}

// =============================================
// Tip Polling (fast, never blocks)
// =============================================

function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollForNewBlocks, POLL_INTERVAL);
    console.log(`[poll] Started (${POLL_INTERVAL}ms interval)`);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollForNewBlocks() {
    if (polling || !kaspadConnected) return;
    polling = true;
    try {
        const info = await rpc('getBlockDagInfo', {});
        dagInfo = info;
        lastSuccessfulPoll = Date.now();
        const tips = info.tipHashes || [];

        // Collect new tips first, then fetch — don't interleave with lazy
        const newTips = [];
        for (const tip of tips) {
            if (!knownBlocks.has(tip) && !knownStubs.has(tip)) newTips.push(tip);
        }

        for (const tip of newTips) {
            if (!kaspadConnected) break;
            try {
                const result = await rpc('getBlock', { hash: tip, includeTransactions: true });
                if (!result.block) continue;
                const block = parseBlock(result.block);
                if (!block) continue;

                knownBlocks.add(tip);
                knownStubs.delete(tip);

                blockBuffer.push(block);
                if (blockBuffer.length > BLOCK_BUFFER_SIZE) blockBuffer.shift();
                blockCount++;

                broadcastBlock(block);

                // Queue parents for lazy fetch + send stubs
                if (block.parentHashes) {
                    for (const ph of block.parentHashes) {
                        if (!knownBlocks.has(ph) && !knownStubs.has(ph)) {
                            knownStubs.add(ph);
                            if (lazyQueue.length < 200) lazyQueue.push(ph);
                            broadcastStub(ph, block.daaScore - 1);
                        }
                    }
                }
            } catch (err) { /* skip tip */ }
        }

        if (blockCount % 100 === 0 && blockCount > 0) {
            console.log(`[relay] ${blockCount} blocks, ${clients.size} clients, buf=${blockBuffer.length}, lazyQ=${lazyQueue.length}`);
        }
    } catch (err) {
        if (!err.message.includes('timeout')) console.error('[poll] Error:', err.message);
    }
    polling = false;
}

// =============================================
// Lazy Parent Fetcher (background, one at a time)
// =============================================

function startLazyFetcher() {
    stopLazyFetcher();
    lazyTimer = setInterval(lazyFetchOne, LAZY_FETCH_INTERVAL);
}

function stopLazyFetcher() {
    if (lazyTimer) { clearInterval(lazyTimer); lazyTimer = null; }
}

async function lazyFetchOne() {
    // Yield to tip poller — tips always have priority
    if (lazyFetching || polling || !kaspadConnected || pendingRpc.size > 0) return;
    if (lazyQueue.length === 0) return;

    lazyFetching = true;
    const hash = lazyQueue.shift();

    if (knownBlocks.has(hash)) { lazyFetching = false; return; }

    try {
        const result = await rpc('getBlock', { hash, includeTransactions: true });
        if (result.block) {
            const block = parseBlock(result.block);
            if (block) {
                knownBlocks.add(hash);
                knownStubs.delete(hash);

                blockBuffer.push(block);
                if (blockBuffer.length > BLOCK_BUFFER_SIZE) blockBuffer.shift();
                blockCount++;

                broadcastBlockFill(block);

                // Queue this block's parents too
                if (block.parentHashes) {
                    for (const ph of block.parentHashes) {
                        if (!knownBlocks.has(ph) && !knownStubs.has(ph) && lazyQueue.length < 200) {
                            knownStubs.add(ph);
                            lazyQueue.push(ph);
                            broadcastStub(ph, block.daaScore - 1);
                        }
                    }
                }
            }
        }
    } catch (err) {
        if (err.message.includes('timeout') && lazyQueue.length < 200) lazyQueue.push(hash);
    }
    lazyFetching = false;
}

// Prune memory
setInterval(function() {
    if (knownBlocks.size > 5000) {
        const iter = knownBlocks.values();
        for (let i = 0; i < 1000; i++) knownBlocks.delete(iter.next().value);
    }
    if (knownStubs.size > 3000) {
        const iter = knownStubs.values();
        for (let i = 0; i < 1000; i++) knownStubs.delete(iter.next().value);
    }
}, 30000);

// =============================================
// Block parsing
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
// Broadcasting
// =============================================

function broadcastBlock(block) {
    for (const [ws, session] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const matches = matchAddresses(block.addressHits, session.addresses);
        const payload = {
            type: 'block',
            block: { hash: block.hash, daaScore: block.daaScore, timestamp: block.timestamp, blueScore: block.blueScore, parentHashes: block.parentHashes, txCount: block.txCount },
            matches: matches.length > 0 ? matches : undefined
        };
        try { ws.send(JSON.stringify(payload)); } catch {}
    }
}

function broadcastBlockFill(block) {
    const payload = {
        type: 'blockFill',
        block: { hash: block.hash, daaScore: block.daaScore, timestamp: block.timestamp, blueScore: block.blueScore, parentHashes: block.parentHashes, txCount: block.txCount }
    };
    const data = JSON.stringify(payload);
    for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch {} }
    }
}

function broadcastStub(hash, estimatedDaa) {
    const payload = { type: 'blockStub', hash: hash, estimatedDaa: estimatedDaa };
    const data = JSON.stringify(payload);
    for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch {} }
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
// HTTP Server
// =============================================

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', kaspadConnected, clients: clients.size, blocksRelayed: blockCount, bufferSize: blockBuffer.length, lazyQueue: lazyQueue.length }));
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
// WebSocket Server (browser clients)
// =============================================

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const clientId = 'c_' + Math.random().toString(36).substring(2, 10);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[client] ${clientId} connected from ${ip}`);

    clients.set(ws, { addresses: new Set(), id: clientId });

    ws.send(JSON.stringify({ type: 'welcome', clientId, kaspadConnected, dagInfo: sanitizeDagInfo(dagInfo), explorerBase: EXPLORER_BASE, bufferSize: blockBuffer.length }));

    if (blockBuffer.length > 0) {
        ws.send(JSON.stringify({
            type: 'history',
            blocks: blockBuffer.map(b => ({ hash: b.hash, daaScore: b.daaScore, timestamp: b.timestamp, blueScore: b.blueScore, parentHashes: b.parentHashes, txCount: b.txCount }))
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
// Address Monitor (REST API, fully independent)
// =============================================

function startAddressMonitor() {
    if (addressPollTimer) return;
    addressPollTimer = setInterval(pollWatchedAddresses, ADDRESS_POLL_INTERVAL);
    console.log('[addr-monitor] Started');
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
   Kaspa Gravity - DAG Relay v2
 ============================================
   Relay:   http://0.0.0.0:${RELAY_PORT}
   kaspad:  ${KASPAD_URL}
   Static:  ${STATIC_DIR}
   Tip Poll:    ${POLL_INTERVAL}ms
   Parent Fill: ${LAZY_FETCH_INTERVAL}ms
 ============================================
    `);
    connectToKaspad();
    startAddressMonitor();
});

process.on('SIGTERM', () => { stopPolling(); stopLazyFetcher(); if (kaspadWs) kaspadWs.close(); wss.close(); httpServer.close(); process.exit(0); });
process.on('SIGINT', () => { stopPolling(); stopLazyFetcher(); if (kaspadWs) kaspadWs.close(); wss.close(); httpServer.close(); process.exit(0); });
