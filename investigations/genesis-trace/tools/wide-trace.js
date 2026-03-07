require('dotenv').config();
const { getAddressBalance, getAddressInfo, getAddressTransactions, getTxUtxos } = require('./src/tracer');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

/**
 * Wide BFS tracer — follows ALL significant outflows breadth-first
 * instead of depth-first top-3. Tracks total ADA coverage.
 *
 * Strategy:
 * - BFS queue sorted by ADA amount (biggest flows first)
 * - Follow ALL outflows above minAda threshold
 * - Track total genesis ADA accounted for
 * - Stop when queue is empty or coverage target met
 * - Save progress incrementally
 */

const MIN_ADA_FLOW = 50_000;     // Only follow flows > 50k ADA
const MAX_ADDRESSES = 500;        // Max addresses to visit per entity
const MAX_DEPTH = 25;             // Allow deeper tracing

async function wideTrace(startAddress, entityName, genesisAda) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  WIDE TRACE: ${entityName}`);
  console.log(`  Genesis allocation: ${genesisAda.toLocaleString()} ADA`);
  console.log(`  Starting: ${startAddress.substring(0, 50)}...`);
  console.log(`  Min flow threshold: ${MIN_ADA_FLOW.toLocaleString()} ADA`);
  console.log(`${'='.repeat(70)}`);

  const visited = new Set();
  const shelleyHits = [];
  const byronTerminals = [];  // Byron addresses where we couldn't trace further
  const stakeKeyMap = new Map();  // stake key -> { addresses, totalAda, governance }
  let totalAdaAtShelley = 0;
  let totalAdaAtByronTerminals = 0;
  let apiCalls = 0;

  // BFS queue: { address, depth, flowedAda }
  const queue = [{ address: startAddress, depth: 0, flowedAda: genesisAda }];

  while (queue.length > 0 && visited.size < MAX_ADDRESSES) {
    // Sort queue by flowedAda descending — trace biggest flows first
    queue.sort((a, b) => b.flowedAda - a.flowedAda);
    const { address, depth, flowedAda } = queue.shift();

    if (visited.has(address) || depth > MAX_DEPTH) continue;
    visited.add(address);

    const isShelley = address.startsWith('addr1') || address.startsWith('addr_');
    const indent = '  '.repeat(Math.min(depth, 8));

    // Get balance
    const balance = await getAddressBalance(address);
    apiCalls++;

    if (isShelley) {
      // SHELLEY HIT — check governance and record
      const info = await getAddressInfo(address);
      apiCalls++;

      const entry = {
        depth,
        address,
        type: 'SHELLEY',
        currentBalance: balance.ada,
        stakeAddress: info?.stakeAddress || null,
        flowedAda
      };

      if (info?.stakeAddress) {
        const stakeInfo = await getStakeInfo(info.stakeAddress);
        apiCalls++;

        entry.governance = {
          pool: stakeInfo?.poolId || null,
          drep: stakeInfo?.drepId || null,
          active: stakeInfo?.active || false,
          controlledAda: stakeInfo?.ada || 0
        };

        // Aggregate by stake key
        if (!stakeKeyMap.has(info.stakeAddress)) {
          stakeKeyMap.set(info.stakeAddress, {
            stakeAddress: info.stakeAddress,
            addresses: [],
            totalFlowedAda: 0,
            totalCurrentAda: 0,
            governance: entry.governance
          });
        }
        const sk = stakeKeyMap.get(info.stakeAddress);
        sk.addresses.push(address);
        sk.totalFlowedAda += flowedAda;
        sk.totalCurrentAda += balance.ada;
      }

      shelleyHits.push(entry);
      totalAdaAtShelley += balance.ada;

      const govLabel = entry.governance?.pool || entry.governance?.drep ? 'GOV' : 'no-gov';
      console.log(`${indent}[S] ${balance.ada.toLocaleString().padStart(15)} ADA | ${govLabel.padEnd(6)} | depth ${depth} | ${address.substring(0, 40)}...`);
      continue; // Don't follow past Shelley addresses
    }

    // BYRON address — get outflows
    const txs = await getAddressTransactions(address, 3); // fewer pages for speed
    apiCalls++;

    if (txs.length === 0) {
      // Dead end
      byronTerminals.push({ address, depth, currentBalance: balance.ada, flowedAda });
      totalAdaAtByronTerminals += balance.ada;
      if (balance.ada > 0) {
        console.log(`${indent}[B-DEAD] ${balance.ada.toLocaleString().padStart(12)} ADA | depth ${depth} | ${address.substring(0, 40)}...`);
      }
      continue;
    }

    // Analyze outgoing destinations
    const destinations = new Map();
    const txLimit = Math.min(txs.length, 30);

    for (let i = 0; i < txLimit; i++) {
      const utxos = await getTxUtxos(txs[i].tx_hash);
      apiCalls++;
      if (!utxos) continue;

      for (const out of utxos.outputs) {
        if (out.address === address) continue;
        const lovelace = out.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada < MIN_ADA_FLOW) continue;

        if (!destinations.has(out.address)) {
          destinations.set(out.address, { address: out.address, totalAda: 0, txCount: 0 });
        }
        const d = destinations.get(out.address);
        d.totalAda += ada;
        d.txCount++;
      }
    }

    // Queue ALL destinations above threshold
    const sorted = [...destinations.values()].sort((a, b) => b.totalAda - a.totalAda);
    let queued = 0;
    for (const dest of sorted) {
      if (!visited.has(dest.address)) {
        queue.push({ address: dest.address, depth: depth + 1, flowedAda: dest.totalAda });
        queued++;
      }
    }

    if (depth <= 5 || queued > 0) {
      console.log(`${indent}[B] depth ${depth} | ${txs.length} txs | ${sorted.length} dests > ${MIN_ADA_FLOW.toLocaleString()} ADA | queued ${queued} | ${address.substring(0, 35)}...`);
    }

    // Progress report every 50 addresses
    if (visited.size % 50 === 0) {
      const coverage = ((totalAdaAtShelley / genesisAda) * 100).toFixed(2);
      console.log(`\n  --- Progress: ${visited.size} addresses | ${shelleyHits.length} Shelley | ${coverage}% coverage | ${apiCalls} API calls | queue: ${queue.length} ---\n`);
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${entityName} — Wide Trace Summary`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Addresses visited:    ${visited.size}`);
  console.log(`  Shelley endpoints:    ${shelleyHits.length}`);
  console.log(`  Byron dead-ends:      ${byronTerminals.length}`);
  console.log(`  Unique stake keys:    ${stakeKeyMap.size}`);
  console.log(`  API calls made:       ${apiCalls}`);
  console.log(`  ADA at Shelley:       ${totalAdaAtShelley.toLocaleString()}`);
  console.log(`  ADA at Byron ends:    ${totalAdaAtByronTerminals.toLocaleString()}`);

  if (stakeKeyMap.size > 0) {
    console.log(`\n  Stake Key Clusters:`);
    const clusters = [...stakeKeyMap.values()].sort((a, b) => b.totalFlowedAda - a.totalFlowedAda);
    for (const c of clusters) {
      const govStatus = c.governance?.pool || c.governance?.drep ? 'GOV' : 'NO-GOV';
      console.log(`    ${c.totalFlowedAda.toLocaleString().padStart(18)} ADA flowed | ${c.totalCurrentAda.toLocaleString().padStart(12)} ADA now | ${govStatus.padEnd(6)} | ${c.addresses.length} addrs | ${c.stakeAddress.substring(0, 30)}...`);
    }
  }

  return {
    entityName,
    genesisAda,
    visited: visited.size,
    apiCalls,
    shelleyHits,
    byronTerminals: byronTerminals.filter(b => b.currentBalance > 0),
    stakeKeyClusters: [...stakeKeyMap.values()].map(c => ({
      stakeAddress: c.stakeAddress,
      addressCount: c.addresses.length,
      totalFlowedAda: c.totalFlowedAda,
      totalCurrentAda: c.totalCurrentAda,
      governance: c.governance
    })),
    summary: {
      totalAdaAtShelley,
      totalAdaAtByronTerminals,
      coveragePercent: ((totalAdaAtShelley / genesisAda) * 100).toFixed(4)
    }
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   WIDE GENESIS FUND TRACE (BFS)                        ║');
  console.log('║   Following ALL significant flows breadth-first         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const outputDir = path.join(__dirname, 'output');
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('genesis-trace-'));
  const latest = files.sort().pop();
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));

  const entities = [
    { key: 'emurgo', genesisAda: 2_074_165_644 },
    { key: 'cardanoFoundation', genesisAda: 648_176_761 },
    { key: 'iohk', genesisAda: 2_463_071_701 }
  ];

  const results = {};

  for (const { key, genesisAda } of entities) {
    const traceData = report.entities[key];
    if (!traceData?.topDestinations?.length) continue;

    const primaryDest = traceData.topDestinations[0];
    results[key] = await wideTrace(primaryDest.address, traceData.name, genesisAda);

    // Save after each entity (incremental!)
    const savePath = path.join(outputDir, `wide-trace-${key}-${Date.now()}.json`);
    fs.writeFileSync(savePath, JSON.stringify(results[key], null, 2));
    console.log(`\n  Saved: ${savePath}\n`);
  }

  // Combined summary
  console.log('\n' + '='.repeat(60));
  console.log('  COMBINED WIDE TRACE SUMMARY');
  console.log('='.repeat(60));

  let totalShelley = 0, totalStakeKeys = 0, totalGov = 0;
  for (const [key, r] of Object.entries(results)) {
    totalShelley += r.shelleyHits.length;
    totalStakeKeys += r.stakeKeyClusters.length;
    totalGov += r.stakeKeyClusters.filter(c => c.governance?.pool || c.governance?.drep).length;
    console.log(`  ${r.entityName}: ${r.shelleyHits.length} Shelley | ${r.stakeKeyClusters.length} stake keys | ${r.summary.coveragePercent}% coverage`);
  }
  console.log(`\n  Total Shelley endpoints: ${totalShelley}`);
  console.log(`  Total unique stake keys: ${totalStakeKeys}`);
  console.log(`  Governance-active keys: ${totalGov}`);
}

main().catch(console.error);
