require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();
const outputDir = path.join(__dirname, 'output');
const progressFile = path.join(outputDir, 'drep-delegator-progress.json');

/**
 * DREP DELEGATOR GENESIS TRACER
 *
 * For the Emurgo DRep (drep1ytvlwvy...):
 * 1. Get ALL 400 delegators via governance API
 * 2. Get DRep info + metadata + voting history
 * 3. For each delegator stake key, check if it appears in our genesis trace results
 * 4. For those that DON'T match directly, sample their tx history to look for
 *    connections to known genesis-linked stake keys
 */

const DREP_ID = 'drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug';
const SAVE_INTERVAL = 50;

// Load our known genesis-linked stake keys from prior analysis
function loadGenesisKeys() {
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('drep-check-'));
  if (files.length === 0) return new Map();

  const latest = files.sort().pop();
  const data = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));
  const map = new Map();
  for (const sk of data.stakeKeys) {
    map.set(sk.stakeKey, {
      totalAdaFlowed: sk.totalAdaFlowed,
      controlledAda: sk.controlledAda,
      label: sk.label,
      drep: sk.drep,
      pool: sk.pool
    });
  }
  return map;
}

// Load neighborhood data for extended matching
function loadNeighborhood() {
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('neighborhood-scan-'));
  if (files.length === 0) return new Map();

  const latest = files.sort().pop();
  const data = JSON.parse(fs.readFileSync(path.join(outputDir, latest), 'utf8'));
  const neighborKeys = new Map();

  // All neighbors from the scan
  for (const result of data.results) {
    for (const n of result.neighbors) {
      if (!neighborKeys.has(n.stakeKey)) {
        neighborKeys.set(n.stakeKey, {
          connectedGenesisKeys: [],
          totalTxs: 0,
          controlledAda: n.controlledAda
        });
      }
      const entry = neighborKeys.get(n.stakeKey);
      entry.connectedGenesisKeys.push(result.stakeKey);
      entry.totalTxs += n.txCount;
    }
  }
  return neighborKeys;
}

function loadProgress() {
  if (fs.existsSync(progressFile)) {
    return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  }
  return null;
}

function saveProgress(state) {
  fs.writeFileSync(progressFile, JSON.stringify(state, null, 2));
}

async function getAllAddressTxs(address) {
  const allTxs = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.addressesTransactions(address, { count: 100, page, order: 'desc' })
      );
      if (!batch || batch.length === 0) break;
      allTxs.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return allTxs;
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

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   EMURGO DREP DELEGATOR GENESIS TRACER                     ║');
  console.log('║   Tracing 400 delegators back to genesis funds             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Load known genesis data
  const genesisKeys = loadGenesisKeys();
  const neighborKeys = loadNeighborhood();
  console.log(`\nLoaded ${genesisKeys.size} genesis-linked stake keys`);
  console.log(`Loaded ${neighborKeys.size} neighborhood stake keys`);

  // === STEP 1: Get DRep Info ===
  console.log('\n--- DRep Registration Info ---');
  try {
    const drepInfo = await rateLimited(() => api.governance.drepsById(DREP_ID));
    console.log(`  DRep ID:     ${drepInfo.drep_id}`);
    console.log(`  Hex:         ${drepInfo.hex || 'N/A'}`);
    console.log(`  Active:      ${drepInfo.active}`);
    console.log(`  Has script:  ${drepInfo.has_script}`);
    console.log(`  Amount:      ${drepInfo.amount ? (Number(BigInt(drepInfo.amount) / 1_000_000n)).toLocaleString() + ' ADA' : 'N/A'}`);
    console.log(`  Live power:  ${drepInfo.live_power || 'N/A'}`);
    console.log(`  Live stake:  ${drepInfo.live_stake ? (Number(BigInt(drepInfo.live_stake) / 1_000_000n)).toLocaleString() + ' ADA' : 'N/A'}`);

    // Get metadata
    try {
      const meta = await rateLimited(() => api.governance.drepsByIdMetadata(DREP_ID));
      if (meta && meta.length > 0) {
        const latest = meta[meta.length - 1];
        console.log(`\n  Metadata URL:  ${latest.json_url || latest.url || 'N/A'}`);
        console.log(`  Metadata hash: ${latest.hash || 'N/A'}`);
      }
    } catch (err) {
      console.log(`  Metadata: unavailable (${err.status_code || err.message})`);
    }

    // Get votes
    try {
      const votes = await rateLimited(() =>
        api.governance.drepsByIdVotes(DREP_ID, { count: 20, order: 'desc' })
      );
      if (votes && votes.length > 0) {
        console.log(`\n  Recent votes: ${votes.length}`);
        for (const v of votes) {
          console.log(`    ${(v.vote || '').padEnd(12)} | tx: ${v.tx_hash.substring(0, 20)}...`);
        }
      }
    } catch (err) {
      console.log(`  Votes: unavailable (${err.status_code || err.message})`);
    }
  } catch (err) {
    console.log(`  DRep info error: ${err.message || err.status_code}`);
  }

  // === STEP 2: Get ALL delegators ===
  console.log('\n--- Fetching All Delegators ---');
  let allDelegators = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.governance.drepsByIdDelegators(DREP_ID, { page, count: 100 })
      );
      if (!batch || batch.length === 0) break;
      allDelegators.push(...batch);
      console.log(`  Page ${page}: ${batch.length} delegators (total: ${allDelegators.length})`);
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      console.log(`  Error fetching page ${page}: ${err.message || err.status_code}`);
      break;
    }
  }

  console.log(`\n  Total delegators: ${allDelegators.length}`);

  // Sort by ADA amount
  allDelegators.sort((a, b) => {
    const aAda = BigInt(a.amount || '0');
    const bAda = BigInt(b.amount || '0');
    return bAda > aAda ? 1 : bAda < aAda ? -1 : 0;
  });

  let totalDelegatedAda = 0n;
  for (const d of allDelegators) {
    totalDelegatedAda += BigInt(d.amount || '0') / 1_000_000n;
  }
  console.log(`  Total ADA delegated: ${Number(totalDelegatedAda).toLocaleString()}`);

  // === STEP 3: Check each delegator against genesis data ===
  console.log('\n--- Checking Delegators Against Genesis Data ---');

  const saved = loadProgress();
  const completed = new Set(saved?.completed || []);
  const results = saved?.results || [];
  let directGenesisMatch = saved?.directGenesisMatch || 0;
  let neighborMatch = saved?.neighborMatch || 0;
  let noMatch = saved?.noMatch || 0;
  let genesisAdaTotal = saved?.genesisAdaTotal || 0;
  let neighborAdaTotal = saved?.neighborAdaTotal || 0;
  let noMatchAdaTotal = saved?.noMatchAdaTotal || 0;
  let processed = completed.size;

  for (const delegator of allDelegators) {
    const stakeKey = delegator.address;
    if (completed.has(stakeKey)) continue;
    processed++;

    const ada = Number(BigInt(delegator.amount || '0') / 1_000_000n);

    // Check 1: Direct genesis match
    if (genesisKeys.has(stakeKey)) {
      const gk = genesisKeys.get(stakeKey);
      directGenesisMatch++;
      genesisAdaTotal += ada;
      results.push({
        stakeKey,
        ada,
        match: 'DIRECT_GENESIS',
        genesisAdaFlowed: gk.totalAdaFlowed,
        genesisControlled: gk.controlledAda
      });
      console.log(`  [${processed}/${allDelegators.length}] DIRECT GENESIS | ${ada.toLocaleString().padStart(15)} ADA | flowed: ${gk.totalAdaFlowed.toLocaleString()} | ${stakeKey.substring(0, 40)}...`);
      completed.add(stakeKey);
      continue;
    }

    // Check 2: Neighborhood match (1-hop from genesis key)
    if (neighborKeys.has(stakeKey)) {
      const nk = neighborKeys.get(stakeKey);
      neighborMatch++;
      neighborAdaTotal += ada;
      results.push({
        stakeKey,
        ada,
        match: 'NEIGHBOR',
        connectedGenesisKeys: nk.connectedGenesisKeys.length,
        totalTxsWithGenesis: nk.totalTxs
      });
      console.log(`  [${processed}/${allDelegators.length}] NEIGHBOR       | ${ada.toLocaleString().padStart(15)} ADA | ${nk.connectedGenesisKeys.length} genesis connections | ${stakeKey.substring(0, 40)}...`);
      completed.add(stakeKey);
      continue;
    }

    // Check 3: EXHAUSTIVE trace — check ALL addresses and ALL transactions
    // Look for any tx counterparties that ARE genesis keys or neighbors
    let foundConnection = false;
    const addresses = await getAccountAddresses(stakeKey);

    for (const addrObj of addresses) {
      if (foundConnection) break;
      const addr = addrObj.address || addrObj;
      const txs = await getAllAddressTxs(addr);

      for (const tx of txs) {
        const utxos = await getTxUtxos(tx.tx_hash);
        if (!utxos) continue;

        // Check all counterparty addresses
        for (const part of [...utxos.inputs, ...utxos.outputs]) {
          if (part.address === addr) continue;
          if (part.address.startsWith('Ae2') || part.address.startsWith('Ddz') || part.address.startsWith('addr1w')) continue;

          const info = await getAddressInfo(part.address);
          const cpStake = info?.stake_address;
          if (!cpStake) continue;

          if (genesisKeys.has(cpStake)) {
            foundConnection = true;
            neighborMatch++;
            neighborAdaTotal += ada;
            results.push({
              stakeKey,
              ada,
              match: 'TX_LINK_TO_GENESIS',
              linkedGenesisKey: cpStake,
              viaTxHash: tx.tx_hash
            });
            console.log(`  [${processed}/${allDelegators.length}] TX→GENESIS     | ${ada.toLocaleString().padStart(15)} ADA | via ${cpStake.substring(0, 30)}... | ${stakeKey.substring(0, 40)}...`);
            break;
          }
          if (neighborKeys.has(cpStake)) {
            foundConnection = true;
            neighborMatch++;
            neighborAdaTotal += ada;
            results.push({
              stakeKey,
              ada,
              match: 'TX_LINK_TO_NEIGHBOR',
              linkedNeighborKey: cpStake,
              viaTxHash: tx.tx_hash
            });
            console.log(`  [${processed}/${allDelegators.length}] TX→NEIGHBOR    | ${ada.toLocaleString().padStart(15)} ADA | via neighbor | ${stakeKey.substring(0, 40)}...`);
            break;
          }
        }
        if (foundConnection) break;
      }
    }

    if (!foundConnection) {
      noMatch++;
      noMatchAdaTotal += ada;
      results.push({
        stakeKey,
        ada,
        match: 'NO_GENESIS_LINK'
      });
      if (ada > 100000) {
        console.log(`  [${processed}/${allDelegators.length}] NO LINK        | ${ada.toLocaleString().padStart(15)} ADA | ${stakeKey.substring(0, 40)}...`);
      }
    }

    completed.add(stakeKey);

    if (processed % SAVE_INTERVAL === 0) {
      saveProgress({
        completed: [...completed],
        results,
        directGenesisMatch,
        neighborMatch,
        noMatch,
        genesisAdaTotal,
        neighborAdaTotal,
        noMatchAdaTotal,
        timestamp: new Date().toISOString()
      });
      console.log(`  === SAVED: ${processed}/${allDelegators.length} delegators checked ===`);
    }
  }

  // Final save
  saveProgress({
    completed: [...completed],
    results,
    directGenesisMatch,
    neighborMatch,
    noMatch,
    genesisAdaTotal,
    neighborAdaTotal,
    noMatchAdaTotal,
    complete: true,
    timestamp: new Date().toISOString()
  });

  // === SUMMARY ===
  console.log('\n' + '='.repeat(70));
  console.log('  EMURGO DREP DELEGATOR GENESIS TRACE SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total delegators:         ${allDelegators.length}`);
  console.log(`  Total ADA delegated:      ${Number(totalDelegatedAda).toLocaleString()}`);
  console.log('');
  console.log(`  DIRECT genesis match:     ${directGenesisMatch} delegators (${genesisAdaTotal.toLocaleString()} ADA)`);
  console.log(`  1-2 hop genesis link:     ${neighborMatch} delegators (${neighborAdaTotal.toLocaleString()} ADA)`);
  console.log(`  No genesis link found:    ${noMatch} delegators (${noMatchAdaTotal.toLocaleString()} ADA)`);
  console.log('');

  const genesisLinkedPct = allDelegators.length > 0
    ? (((directGenesisMatch + neighborMatch) / allDelegators.length) * 100).toFixed(1)
    : '0';
  const genesisLinkedAdaPct = Number(totalDelegatedAda) > 0
    ? (((genesisAdaTotal + neighborAdaTotal) / Number(totalDelegatedAda)) * 100).toFixed(1)
    : '0';

  console.log(`  Genesis-linked delegators: ${genesisLinkedPct}%`);
  console.log(`  Genesis-linked ADA:        ${genesisLinkedAdaPct}%`);

  // Top delegators
  console.log('\n  TOP 20 DELEGATORS:');
  for (const d of allDelegators.slice(0, 20)) {
    const ada = Number(BigInt(d.amount || '0') / 1_000_000n);
    const matchResult = results.find(r => r.stakeKey === d.address);
    const matchLabel = matchResult?.match || 'UNKNOWN';
    console.log(`    ${ada.toLocaleString().padStart(15)} ADA | ${matchLabel.padEnd(22)} | ${d.address.substring(0, 45)}...`);
  }

  const savePath = path.join(outputDir, `drep-delegator-trace-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify({
    drepId: DREP_ID,
    totalDelegators: allDelegators.length,
    totalDelegatedAda: Number(totalDelegatedAda),
    directGenesisMatch,
    neighborMatch,
    noMatch,
    genesisAdaTotal,
    neighborAdaTotal,
    noMatchAdaTotal,
    genesisLinkedPct: parseFloat(genesisLinkedPct),
    genesisLinkedAdaPct: parseFloat(genesisLinkedAdaPct),
    results,
    topDelegators: allDelegators.slice(0, 50).map(d => ({
      stakeKey: d.address,
      ada: Number(BigInt(d.amount || '0') / 1_000_000n)
    }))
  }, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);
