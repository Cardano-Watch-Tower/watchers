require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { analyzeAddressPattern } = require('./src/cex-detector');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * DRAIN TRACER
 *
 * For Shelley addresses/stake keys that received genesis-linked funds
 * but now hold 0 (or near-0) ADA — trace where the money went OUT to.
 *
 * This answers: "They received genesis money... then what?"
 *
 * Sources:
 * 1. Ghost delegations (GHOST) — 0 ADA but pool/DRep delegation still registered
 * 2. Empty keys (EMPTY) — 0 ADA, no delegation
 * 3. Shelley hits from full-trace with 0 balance
 * 4. Addresses under IDLE stake keys that have 0 balance (funds concentrated elsewhere)
 *
 * For each drained address:
 * - Get all outgoing transactions
 * - Sum up where the ADA went
 * - Classify destinations (CEX heuristic, self-custody, script, etc.)
 * - Build a picture of the "drain map"
 */

const outputDir = path.join(__dirname, 'output');
const progressFile = path.join(outputDir, 'drain-trace-progress.json');
const SAVE_INTERVAL = 25;

function loadProgress() {
  if (fs.existsSync(progressFile)) {
    return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  }
  return null;
}

function saveProgress(state) {
  fs.writeFileSync(progressFile, JSON.stringify(state, null, 2));
}

async function getAddressTxs(address, count = 100, page = 1) {
  try {
    return await rateLimited(() =>
      api.addressesTransactions(address, { count, page, order: 'asc' })
    );
  } catch (err) {
    if (err.status_code === 404) return [];
    throw err;
  }
}

async function getTxUtxos(txHash) {
  try {
    return await rateLimited(() => api.txsUtxos(txHash));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

async function getAddressInfo(address) {
  try {
    return await rateLimited(() => api.addresses(address));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

async function getAccountAddresses(stakeAddress) {
  const addresses = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.accountsAddresses(stakeAddress, { page, count: 100 })
      );
      if (!batch || batch.length === 0) break;
      addresses.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return addresses;
}

/**
 * For a single address, find all outgoing destinations and amounts.
 * An "outgoing" tx is one where this address appears as an INPUT.
 */
async function traceOutflows(address) {
  const destinations = new Map(); // destAddress -> { totalAda, txCount, txHashes }
  let totalOutflow = 0;
  let txsProcessed = 0;

  // Get ALL transactions (oldest first) — no page cap
  let page = 1;
  while (true) {
    const txs = await getAddressTxs(address, 100, page);
    if (txs.length === 0) break;

    for (const tx of txs) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;

      // Check if this address is an INPUT (meaning it sent money)
      const isInput = utxos.inputs.some(inp => inp.address === address);
      if (!isInput) continue; // This tx only received, didn't send

      txsProcessed++;

      // Collect all outputs NOT going back to the same address (actual outflows)
      for (const out of utxos.outputs) {
        if (out.address === address) continue; // change back to self

        const lovelace = out.amount.find(a => a.unit === 'lovelace');
        const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
        if (ada < 1) continue;

        if (!destinations.has(out.address)) {
          destinations.set(out.address, {
            address: out.address,
            totalAda: 0,
            txCount: 0,
            txHashes: []
          });
        }
        const dest = destinations.get(out.address);
        dest.totalAda += ada;
        dest.txCount++;
        if (dest.txHashes.length < 5) dest.txHashes.push(tx.tx_hash);
        totalOutflow += ada;
      }
    }

    if (txs.length < 100) break;
    page++;
  }

  return { destinations, totalOutflow, txsProcessed };
}

/**
 * Classify a destination address
 */
async function classifyAddress(address) {
  const info = await getAddressInfo(address);
  if (!info) return { type: 'unknown', label: 'NOT_FOUND' };

  const isShelley = address.startsWith('addr1') || address.startsWith('addr_');
  const isByron = address.startsWith('Ae2') || address.startsWith('Ddz');
  const hasStake = !!info.stake_address;
  const txCount = info.tx_count || 0;
  const lovelace = info.amount?.find(a => a.unit === 'lovelace');
  const currentAda = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;

  let type, label;

  if (isByron) {
    type = 'byron';
    label = 'BYRON';
  } else if (info.script) {
    type = 'script';
    label = 'SCRIPT';
  } else if (txCount > 500 && !hasStake) {
    type = 'likely_cex';
    label = 'LIKELY_CEX';
  } else if (txCount > 100 && !hasStake) {
    type = 'possible_cex';
    label = 'POSSIBLE_CEX';
  } else if (hasStake) {
    type = 'shelley_staked';
    label = 'SHELLEY_STAKED';
  } else {
    type = 'shelley_no_stake';
    label = 'SHELLEY_NO_STAKE';
  }

  return {
    type,
    label,
    isShelley,
    isByron,
    hasStake,
    stakeAddress: info.stake_address || null,
    txCount,
    currentAda,
    isScript: !!info.script
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   DRAIN TRACER                                              ║');
  console.log('║   Where did the 0-balance Shelley endpoints send funds?     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load sources of drained addresses
  // 1. From stake analysis — GHOST + EMPTY + addresses under IDLE keys with 0 balance
  const stakeFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('stake-analysis-'));
  const latestStake = stakeFiles.sort().pop();
  const stakeData = JSON.parse(fs.readFileSync(path.join(outputDir, latestStake), 'utf8'));

  // 2. From deep trace — Shelley hits with 0 balance
  const deepFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('deep-trace-'));
  const latestDeep = deepFiles.sort().pop();
  const deepTrace = JSON.parse(fs.readFileSync(path.join(outputDir, latestDeep), 'utf8'));

  // 3. From full trace progress (if exists)
  const fullTraceFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('full-trace-') && f.endsWith('-progress.json'));

  // Collect all drained Shelley addresses to trace
  const drainTargets = new Map(); // address -> { source, stakeKey, flowedAda, entity }

  // PRIMARY SOURCE: Full trace progress files (have currentBalance already)
  for (const ftFile of fullTraceFiles) {
    try {
      const ftData = JSON.parse(fs.readFileSync(path.join(outputDir, ftFile), 'utf8'));
      if (!ftData.shelleyHits) continue;
      for (const hit of ftData.shelleyHits) {
        if (hit.address?.startsWith('addr1') && !drainTargets.has(hit.address)) {
          if ((hit.currentBalance || 0) <= 5) {
            drainTargets.set(hit.address, {
              source: 'full-trace',
              stakeKey: hit.stakeAddress,
              entity: ftData.entityName,
              flowedAda: hit.flowedAda,
              currentAda: hit.currentBalance || 0
            });
          }
        }
      }
    } catch (err) {
      // skip corrupt files
    }
  }

  console.log(`  From full trace progress: ${drainTargets.size} drained addresses`);

  // From stake analysis — GHOST + EMPTY keys (small number, worth the API calls)
  for (const key of stakeData.stakeKeys) {
    const hasDel = !!(key.poolId || key.drepId);

    // Ghost delegations or empty keys with 0 ADA
    if (key.controlledAda === 0) {
      try {
        const addrs = await getAccountAddresses(key.stakeAddress);
        for (const a of addrs) {
          if (!drainTargets.has(a.address)) {
            drainTargets.set(a.address, {
              source: hasDel ? 'ghost-delegation' : 'empty-key',
              stakeKey: key.stakeAddress,
              entity: key.sourceEntity,
              currentAda: 0,
              pool: key.poolId,
              drep: key.drepId
            });
          }
        }
      } catch (err) {
        console.log(`  Could not expand ${key.stakeAddress}: ${err.message}`);
      }
    }
  }

  console.log(`  After stake analysis expansion: ${drainTargets.size} drained addresses`);

  // From deep trace — check live balances (small set, ~18 addresses)
  for (const [entity, data] of Object.entries(deepTrace)) {
    if (!data?.shelleyHits) continue;
    for (const hit of data.shelleyHits) {
      if (hit.address?.startsWith('addr1') && !drainTargets.has(hit.address)) {
        try {
          const info = await getAddressInfo(hit.address);
          const lovelace = info?.amount?.find(b => b.unit === 'lovelace');
          const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
          if (ada <= 5 && (info?.tx_count || 0) > 1) {
            drainTargets.set(hit.address, {
              source: 'deep-trace',
              stakeKey: hit.stakeAddress,
              entity: data.entityName,
              flowedAda: hit.flowedAda,
              currentAda: ada
            });
          }
        } catch (err) {
          // skip
        }
      }
    }
  }

  console.log(`  After deep trace expansion: ${drainTargets.size} drained addresses`);

  console.log(`\nFound ${drainTargets.size} drained Shelley addresses to trace\n`);

  // Check for resume
  const saved = loadProgress();
  const completed = new Set(saved?.completed || []);
  const allResults = saved?.results || [];
  const summary = saved?.summary || {
    totalOutflow: 0,
    byType: {},
    topDestinations: []
  };

  let processed = completed.size;

  for (const [address, meta] of drainTargets) {
    if (completed.has(address)) continue;

    processed++;
    console.log(`\n  [${processed}/${drainTargets.size}] Tracing outflows from ${address.substring(0, 45)}...`);
    console.log(`    Source: ${meta.source} | Entity: ${meta.entity} | Flowed: ${(meta.flowedAda || 0).toLocaleString()} ADA`);

    const { destinations, totalOutflow, txsProcessed } = await traceOutflows(address);

    if (destinations.size === 0) {
      console.log(`    No outflows found (${txsProcessed} txs checked)`);
      completed.add(address);
      continue;
    }

    // Classify top destinations
    const sorted = [...destinations.values()].sort((a, b) => b.totalAda - a.totalAda);
    const result = {
      sourceAddress: address,
      meta,
      totalOutflow,
      txsProcessed,
      destinationCount: sorted.length,
      topDestinations: []
    };

    // Classify ALL destinations by ADA
    for (const dest of sorted) {
      const classification = await classifyAddress(dest.address);
      dest.classification = classification;
      result.topDestinations.push(dest);

      // Aggregate by type
      const t = classification.label;
      if (!summary.byType[t]) summary.byType[t] = { count: 0, totalAda: 0 };
      summary.byType[t].count++;
      summary.byType[t].totalAda += dest.totalAda;

      console.log(`    ${dest.totalAda.toLocaleString().padStart(15)} ADA -> ${t.padEnd(16)} | ${dest.txCount} txs | ${dest.address.substring(0, 40)}...`);
    }

    summary.totalOutflow += totalOutflow;
    allResults.push(result);
    completed.add(address);

    // Save progress
    if (processed % SAVE_INTERVAL === 0) {
      saveProgress({
        completed: [...completed],
        results: allResults,
        summary,
        timestamp: new Date().toISOString()
      });
      console.log(`  === SAVED: ${processed} addresses traced ===`);
    }
  }

  // Final save
  saveProgress({
    completed: [...completed],
    results: allResults,
    summary,
    complete: true,
    timestamp: new Date().toISOString()
  });

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('  DRAIN TRACE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Addresses traced:     ${completed.size}`);
  console.log(`  Total outflow:        ${summary.totalOutflow.toLocaleString()} ADA`);
  console.log(`\n  By destination type:`);

  const typeEntries = Object.entries(summary.byType).sort((a, b) => b[1].totalAda - a[1].totalAda);
  for (const [type, data] of typeEntries) {
    const pct = ((data.totalAda / Math.max(summary.totalOutflow, 1)) * 100).toFixed(1);
    console.log(`    ${type.padEnd(20)} ${data.totalAda.toLocaleString().padStart(20)} ADA (${pct}%) | ${data.count} destinations`);
  }

  // Top individual destinations across all drains
  const globalDests = new Map();
  for (const r of allResults) {
    for (const d of r.topDestinations) {
      if (!globalDests.has(d.address)) {
        globalDests.set(d.address, { ...d, totalAda: 0, txCount: 0 });
      }
      const g = globalDests.get(d.address);
      g.totalAda += d.totalAda;
      g.txCount += d.txCount;
    }
  }

  const topGlobal = [...globalDests.values()].sort((a, b) => b.totalAda - a.totalAda);
  if (topGlobal.length > 0) {
    console.log(`\n  TOP DRAIN DESTINATIONS (across all sources):`);
    for (const d of topGlobal) {
      const label = d.classification?.label || 'UNKNOWN';
      console.log(`    ${d.totalAda.toLocaleString().padStart(20)} ADA | ${label.padEnd(16)} | ${d.address.substring(0, 45)}...`);
    }
  }

  const savePath = path.join(outputDir, `drain-trace-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify({ results: allResults, summary, globalTopDestinations: topGlobal }, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);
