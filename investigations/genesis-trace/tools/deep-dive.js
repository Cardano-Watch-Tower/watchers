require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();
const outputDir = path.join(__dirname, 'output');

/**
 * DEEP DIVE INVESTIGATIONS
 *
 * 1. The 1.89B ADA Treasury — stake1u9zjr6e... sends 32M chunks to abstain keys
 * 2. The Hub Wallet — stake1u89hxtux... connects to 7 genesis-linked keys
 * 3. The Single DRep — drep1ytvlwvy... controls all "actual DRep" genesis ADA
 */

// === TARGET KEYS ===
const TREASURY_KEY = 'stake1u9zjr6e37w53a474puhx606ayr3rz2l6jljrmzvlzkk3cmg0m2zw0';
const HUB_KEY = 'stake1u89hxtuxvfdqda90w2aw2mluxcsgyctfe2lz52n986lrc2cumssr9';
const DREP_ID = 'drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug';
const NO_CONF_KEY = 'stake1u9phffdh79gc8lrlk3vmxjgtedrhcfnrhc8u6wpz3zrlkxqvehgsq';

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

// =============================================
// INVESTIGATION 1: THE 1.89B ADA TREASURY
// =============================================
async function investigateTreasury() {
  console.log('\n' + '═'.repeat(70));
  console.log('  INVESTIGATION 1: THE 1.89 BILLION ADA TREASURY');
  console.log('  ' + TREASURY_KEY);
  console.log('═'.repeat(70));

  // Get stake info
  const stakeInfo = await getStakeInfo(TREASURY_KEY);
  console.log(`\n  Current balance:  ${stakeInfo.ada.toLocaleString()} ADA`);
  console.log(`  Pool:             ${stakeInfo.poolId || 'NONE'}`);
  console.log(`  DRep:             ${stakeInfo.drepId || 'NONE'}`);
  console.log(`  Active:           ${stakeInfo.active}`);
  console.log(`  Rewards sum:      ${stakeInfo.rewardsAvailable}`);

  // Get all addresses under this key
  const addresses = await getAccountAddresses(TREASURY_KEY);
  console.log(`\n  Addresses under key: ${addresses.length}`);

  // Sample transactions from main address(es)
  const allDestinations = new Map(); // stakeKey -> { ada, txCount, addresses, pool, drep }
  const txsSeen = new Set();
  let totalOutflows = 0n;

  for (const addrObj of addresses) {
    const addr = addrObj.address || addrObj;
    console.log(`\n  Scanning address: ${addr.substring(0, 50)}...`);

    const txs = await getAllAddressTxs(addr);
    console.log(`    ${txs.length} transactions found`);

    for (const tx of txs) {
      if (txsSeen.has(tx.tx_hash)) continue;
      txsSeen.add(tx.tx_hash);

      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;

      // Check if WE are in the inputs (outgoing tx)
      const weAreInput = utxos.inputs.some(i => {
        const info = addresses.find(a => (a.address || a) === i.address);
        return !!info;
      });

      if (!weAreInput) continue; // only care about outflows

      // Find external outputs
      const ownAddrSet = new Set(addresses.map(a => a.address || a));
      for (const out of utxos.outputs) {
        if (ownAddrSet.has(out.address)) continue; // skip change outputs

        const adaAmount = out.amount.find(a => a.unit === 'lovelace');
        const ada = adaAmount ? BigInt(adaAmount.quantity) / 1_000_000n : 0n;
        totalOutflows += ada;

        // Resolve stake key
        let destStake = null;
        if (!out.address.startsWith('Ae2') && !out.address.startsWith('Ddz') && !out.address.startsWith('addr1w')) {
          const info = await getAddressInfo(out.address);
          destStake = info?.stake_address || 'ENTERPRISE';
        } else if (out.address.startsWith('addr1w')) {
          destStake = 'SCRIPT';
        } else {
          destStake = 'BYRON';
        }

        if (!allDestinations.has(destStake)) {
          allDestinations.set(destStake, {
            stakeKey: destStake,
            totalAda: 0n,
            txCount: 0,
            sampleAddresses: [],
            pool: null,
            drep: null
          });
        }
        const dest = allDestinations.get(destStake);
        dest.totalAda += ada;
        dest.txCount++;
        if (dest.sampleAddresses.length < 3) dest.sampleAddresses.push(out.address);
      }
    }
  }

  console.log(`\n  Total transactions scanned: ${txsSeen.size}`);
  console.log(`  Total outflows: ${totalOutflows.toLocaleString()} ADA`);
  console.log(`  Unique destination stake keys: ${allDestinations.size}`);

  // Enrich destinations with governance info
  const enriched = [];
  for (const [key, dest] of allDestinations) {
    if (key === 'BYRON' || key === 'SCRIPT' || key === 'ENTERPRISE') {
      enriched.push({ ...dest, totalAda: Number(dest.totalAda) });
      continue;
    }
    const info = await getStakeInfo(key);
    dest.pool = info?.poolId || null;
    dest.drep = info?.drepId || null;
    dest.controlledAda = info?.ada || 0;
    dest.active = info?.active || false;
    enriched.push({ ...dest, totalAda: Number(dest.totalAda) });
  }

  // Sort by ADA sent
  enriched.sort((a, b) => b.totalAda - a.totalAda);

  console.log('\n  TREASURY OUTFLOW DESTINATIONS:');
  console.log('  ' + '-'.repeat(65));
  let abstainCount = 0;
  let abstainAda = 0;
  let noConfCount = 0;
  let noDrepCount = 0;

  for (const d of enriched) {
    const drepLabel = d.drep
      ? (d.drep === 'drep_always_abstain' ? 'ABSTAIN' :
         d.drep === 'drep_always_no_confidence' ? 'NO_CONF' :
         d.drep.substring(0, 20) + '...')
      : (d.stakeKey === 'BYRON' || d.stakeKey === 'SCRIPT' || d.stakeKey === 'ENTERPRISE')
        ? d.stakeKey
        : 'NO DRep';

    if (d.drep === 'drep_always_abstain') { abstainCount++; abstainAda += d.controlledAda || 0; }
    if (d.drep === 'drep_always_no_confidence') noConfCount++;
    if (!d.drep && d.stakeKey !== 'BYRON' && d.stakeKey !== 'SCRIPT' && d.stakeKey !== 'ENTERPRISE') noDrepCount++;

    console.log(`    ${d.totalAda.toLocaleString().padStart(15)} ADA | ${d.txCount} txs | ${drepLabel.padEnd(20)} | ${(d.controlledAda || '').toLocaleString().padStart(15)} held | ${(d.stakeKey || '').substring(0, 35)}...`);
  }

  console.log('\n  TREASURY SUMMARY:');
  console.log(`    Abstain destinations:     ${abstainCount} keys (${abstainAda.toLocaleString()} ADA currently held)`);
  console.log(`    No-confidence:            ${noConfCount} keys`);
  console.log(`    No DRep:                  ${noDrepCount} keys`);
  console.log(`    Total unique destinations: ${enriched.length}`);

  return { destinations: enriched, totalOutflows: Number(totalOutflows) };
}

// =============================================
// INVESTIGATION 2: THE HUB WALLET
// =============================================
async function investigateHub() {
  console.log('\n' + '═'.repeat(70));
  console.log('  INVESTIGATION 2: THE HUB WALLET');
  console.log('  ' + HUB_KEY);
  console.log('═'.repeat(70));

  const stakeInfo = await getStakeInfo(HUB_KEY);
  console.log(`\n  Current balance:  ${stakeInfo.ada.toLocaleString()} ADA`);
  console.log(`  Pool:             ${stakeInfo.poolId || 'NONE'}`);
  console.log(`  DRep:             ${stakeInfo.drepId || 'NONE'}`);
  console.log(`  Active:           ${stakeInfo.active}`);

  const addresses = await getAccountAddresses(HUB_KEY);
  console.log(`  Addresses: ${addresses.length}`);

  // Get pool info
  if (stakeInfo.poolId) {
    try {
      const poolInfo = await rateLimited(() => api.poolsMetadata(stakeInfo.poolId));
      console.log(`\n  Pool metadata:`);
      console.log(`    Name:        ${poolInfo?.name || 'unknown'}`);
      console.log(`    Ticker:      ${poolInfo?.ticker || 'unknown'}`);
      console.log(`    Homepage:    ${poolInfo?.homepage || 'unknown'}`);
      console.log(`    Description: ${(poolInfo?.description || 'unknown').substring(0, 80)}`);
    } catch (err) {
      console.log(`    Pool metadata unavailable`);
    }
  }

  // Sample recent txs to understand what this wallet does
  const counterparties = new Map();
  let txsScanned = 0;

  for (const addrObj of addresses) {
    const addr = addrObj.address || addrObj;
    const txs = await getAllAddressTxs(addr);

    for (const tx of txs) {
      const utxos = await getTxUtxos(tx.tx_hash);
      if (!utxos) continue;
      txsScanned++;

      const ownAddrSet = new Set(addresses.map(a => a.address || a));
      for (const inp of utxos.inputs) {
        if (ownAddrSet.has(inp.address)) continue;
        if (inp.address.startsWith('Ae2') || inp.address.startsWith('Ddz') || inp.address.startsWith('addr1w')) continue;

        const info = await getAddressInfo(inp.address);
        const sk = info?.stake_address;
        if (!sk) continue;

        if (!counterparties.has(sk)) {
          counterparties.set(sk, { stakeKey: sk, sent: 0, received: 0, txCount: 0 });
        }
        counterparties.get(sk).received++;
        counterparties.get(sk).txCount++;
      }
      for (const out of utxos.outputs) {
        if (ownAddrSet.has(out.address)) continue;
        if (out.address.startsWith('Ae2') || out.address.startsWith('Ddz') || out.address.startsWith('addr1w')) continue;

        const info = await getAddressInfo(out.address);
        const sk = info?.stake_address;
        if (!sk) continue;

        if (!counterparties.has(sk)) {
          counterparties.set(sk, { stakeKey: sk, sent: 0, received: 0, txCount: 0 });
        }
        counterparties.get(sk).sent++;
        counterparties.get(sk).txCount++;
      }
    }
  }

  // Enrich top counterparties
  const sorted = [...counterparties.values()].sort((a, b) => b.txCount - a.txCount);
  const enrichedHub = [];
  for (const cp of sorted) {
    const info = await getStakeInfo(cp.stakeKey);
    enrichedHub.push({
      ...cp,
      controlledAda: info?.ada || 0,
      pool: info?.poolId || null,
      drep: info?.drepId || null,
      active: info?.active || false
    });
  }

  console.log(`\n  Transactions scanned: ${txsScanned}`);
  console.log(`  Unique counterparties: ${counterparties.size}`);
  console.log('\n  TOP COUNTERPARTIES:');
  for (const cp of enrichedHub) {
    const dir = cp.sent > cp.received ? '→ SENT' : cp.received > cp.sent ? '← RECV' : '↔ BOTH';
    const drepLabel = cp.drep
      ? (cp.drep === 'drep_always_abstain' ? 'ABSTAIN' :
         cp.drep === 'drep_always_no_confidence' ? 'NO_CONF' :
         cp.drep.substring(0, 15) + '...')
      : 'NO DRep';
    console.log(`    ${dir.padEnd(8)} ${cp.txCount.toString().padStart(4)} txs | ${cp.controlledAda.toLocaleString().padStart(15)} ADA | ${drepLabel.padEnd(18)} | ${cp.stakeKey.substring(0, 35)}...`);
  }

  return enrichedHub;
}

// =============================================
// INVESTIGATION 3: THE SINGLE DREP
// =============================================
async function investigateDrep() {
  console.log('\n' + '═'.repeat(70));
  console.log('  INVESTIGATION 3: THE SINGLE DREP');
  console.log('  ' + DREP_ID);
  console.log('═'.repeat(70));

  // Get DRep info from Blockfrost governance endpoint
  try {
    const drepInfo = await rateLimited(() => api.governanceDreps(DREP_ID));
    console.log('\n  DRep Registration Info:');
    console.log(`    DRep ID:          ${drepInfo.drep_id}`);
    console.log(`    Hex:              ${drepInfo.hex || 'N/A'}`);
    console.log(`    Active:           ${drepInfo.active}`);
    console.log(`    Amount:           ${drepInfo.amount ? (Number(BigInt(drepInfo.amount) / 1_000_000n)).toLocaleString() + ' ADA' : 'N/A'}`);
    console.log(`    Has script:       ${drepInfo.has_script}`);
    console.log(`    Registered epoch: ${drepInfo.registered_epoch || 'N/A'}`);
    console.log(`    Updated epoch:    ${drepInfo.updated_epoch || 'N/A'}`);

    // Get metadata if available
    if (drepInfo.url) {
      console.log(`    Metadata URL:     ${drepInfo.url}`);
      console.log(`    Metadata hash:    ${drepInfo.hash || 'N/A'}`);
    }
  } catch (err) {
    console.log(`  DRep lookup error: ${err.message || err.status_code}`);
  }

  // Get DRep delegators
  try {
    const delegators = await rateLimited(() =>
      api.governanceDrepsDelegators(DREP_ID, { count: 100 })
    );
    console.log(`\n  Delegators: ${delegators ? delegators.length : 0}`);

    if (delegators && delegators.length > 0) {
      let totalDelegated = 0n;
      console.log('\n  TOP DELEGATORS:');
      for (const d of delegators.slice(0, 20)) {
        const ada = BigInt(d.amount || '0') / 1_000_000n;
        totalDelegated += ada;
        console.log(`    ${Number(ada).toLocaleString().padStart(15)} ADA | ${d.address.substring(0, 50)}...`);
      }
      console.log(`\n  Total delegated (top ${Math.min(20, delegators.length)}): ${Number(totalDelegated).toLocaleString()} ADA`);
      if (delegators.length > 20) {
        console.log(`  (${delegators.length - 20} more delegators not shown)`);
      }
    }
  } catch (err) {
    console.log(`  Delegator lookup error: ${err.message || err.status_code}`);
  }

  // Get DRep votes
  try {
    const votes = await rateLimited(() =>
      api.governanceDrepsVotes(DREP_ID, { count: 20, order: 'desc' })
    );
    if (votes && votes.length > 0) {
      console.log(`\n  RECENT VOTES (${votes.length}):`)
      for (const v of votes) {
        console.log(`    ${v.vote.padEnd(12)} | ${v.tx_hash.substring(0, 20)}... | proposal: ${(v.proposal_tx_hash || '').substring(0, 20)}...`);
      }
    } else {
      console.log('\n  No votes found');
    }
  } catch (err) {
    console.log(`  Vote lookup error: ${err.message || err.status_code}`);
  }

  // Try to get DRep metadata content
  try {
    const drepInfo = await rateLimited(() => api.governanceDreps(DREP_ID));
    if (drepInfo?.url) {
      console.log(`\n  Attempting to fetch metadata from: ${drepInfo.url}`);
    }
  } catch (err) {
    // ignore
  }
}

// =============================================
// INVESTIGATION 4: NO-CONFIDENCE WHALE
// =============================================
async function investigateNoConfWhale() {
  console.log('\n' + '═'.repeat(70));
  console.log('  INVESTIGATION 4: THE NO-CONFIDENCE WHALE');
  console.log('  ' + NO_CONF_KEY);
  console.log('═'.repeat(70));

  const stakeInfo = await getStakeInfo(NO_CONF_KEY);
  console.log(`\n  Current balance:  ${stakeInfo.ada.toLocaleString()} ADA`);
  console.log(`  Pool:             ${stakeInfo.poolId || 'NONE'}`);
  console.log(`  DRep:             ${stakeInfo.drepId || 'NONE'}`);
  console.log(`  Active:           ${stakeInfo.active}`);
  console.log(`  ADA flowed:       2,697,696,225 (from genesis trace)`);

  // Get pool info
  if (stakeInfo.poolId) {
    try {
      const poolInfo = await rateLimited(() => api.poolsMetadata(stakeInfo.poolId));
      console.log(`\n  Pool metadata:`);
      console.log(`    Name:        ${poolInfo?.name || 'unknown'}`);
      console.log(`    Ticker:      ${poolInfo?.ticker || 'unknown'}`);
      console.log(`    Homepage:    ${poolInfo?.homepage || 'unknown'}`);
      console.log(`    Description: ${(poolInfo?.description || 'unknown').substring(0, 80)}`);
    } catch (err) {
      console.log(`    Pool metadata unavailable`);
    }
  }

  const addresses = await getAccountAddresses(NO_CONF_KEY);
  console.log(`\n  Addresses under key: ${addresses.length}`);
  for (const a of addresses) {
    console.log(`    ${(a.address || a).substring(0, 60)}...`);
  }
}

// =============================================
// MAIN
// =============================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   DEEP DIVE INVESTIGATIONS                                         ║');
  console.log('║   Following the money from genesis through the network             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const results = {};

  // Run investigations
  results.treasury = await investigateTreasury();
  results.hub = await investigateHub();
  await investigateDrep();
  await investigateNoConfWhale();

  // Save results
  const savePath = path.join(outputDir, `deep-dive-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify(results, (key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  , 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);
