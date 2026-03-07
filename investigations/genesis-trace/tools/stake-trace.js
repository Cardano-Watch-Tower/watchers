require('dotenv').config();
const { createClient, rateLimited } = require('./src/blockfrost-client');
const { getStakeInfo } = require('./src/governance');
const fs = require('fs');
const path = require('path');

const api = createClient();

/**
 * Stake Key Analyzer
 *
 * Takes Shelley addresses found by deep/wide trace,
 * expands by stake key to find ALL addresses under each key,
 * then sums total ADA and checks governance.
 */

async function getAccountAddresses(stakeAddress, maxPages = 5) {
  const addresses = [];
  let page = 1;
  while (page <= maxPages) {
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

async function getAccountInfo(stakeAddress) {
  try {
    return await rateLimited(() => api.accounts(stakeAddress));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

async function analyzeStakeKey(stakeAddress, sourceEntity) {
  console.log(`\n  Analyzing stake key: ${stakeAddress}`);

  // Get account info (delegation, rewards, controlled stake)
  const account = await getAccountInfo(stakeAddress);
  if (!account) {
    console.log(`    [!] Account not found`);
    return null;
  }

  const controlledAda = Number(BigInt(account.controlled_amount) / 1_000_000n);
  const rewardsAda = Number(BigInt(account.rewards_sum) / 1_000_000n);
  const withdrawnAda = Number(BigInt(account.withdrawals_sum) / 1_000_000n);

  console.log(`    Active: ${account.active}`);
  console.log(`    Pool: ${account.pool_id || 'none'}`);
  console.log(`    DRep: ${account.drep_id || 'none'}`);
  console.log(`    Controlled: ${controlledAda.toLocaleString()} ADA`);
  console.log(`    Total rewards: ${rewardsAda.toLocaleString()} ADA`);
  console.log(`    Withdrawn: ${withdrawnAda.toLocaleString()} ADA`);

  // Get all addresses under this stake key
  const addresses = await getAccountAddresses(stakeAddress);
  console.log(`    Addresses: ${addresses.length}`);

  // Get balances for top addresses
  let totalBalance = 0;
  const addrDetails = [];
  for (const addrObj of addresses.slice(0, 50)) {
    try {
      const info = await rateLimited(() => api.addresses(addrObj.address));
      const lovelace = info.amount.find(a => a.unit === 'lovelace');
      const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
      totalBalance += ada;
      if (ada > 0) {
        addrDetails.push({ address: addrObj.address, ada });
      }
    } catch (err) {
      // skip
    }
  }

  if (addrDetails.length > 0) {
    console.log(`    Addresses with balance:`);
    for (const d of addrDetails.sort((a, b) => b.ada - a.ada).slice(0, 10)) {
      console.log(`      ${d.ada.toLocaleString().padStart(15)} ADA | ${d.address.substring(0, 50)}...`);
    }
  }

  // Liquid staking: ADA stays in wallet. Delegation without ADA = empty/meaningless
  const hasDelegation = !!(account.pool_id || account.drep_id);
  const isGovActive = hasDelegation && controlledAda > 0;

  return {
    stakeAddress,
    sourceEntity,
    active: account.active,
    poolId: account.pool_id,
    drepId: account.drep_id,
    controlledAda,
    totalRewards: rewardsAda,
    withdrawnRewards: withdrawnAda,
    addressCount: addresses.length,
    totalBalance,
    governanceActive: isGovActive,
    topAddresses: addrDetails.sort((a, b) => b.ada - a.ada).slice(0, 20)
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   STAKE KEY ANALYZER                                    ║');
  console.log('║   Expanding from known Shelley addresses               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const outputDir = path.join(__dirname, 'output');

  // Load deep trace results
  const deepFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('deep-trace-'));
  const latestDeep = deepFiles.sort().pop();
  const deepTrace = JSON.parse(fs.readFileSync(path.join(outputDir, latestDeep), 'utf8'));

  // Collect all unique stake keys from deep trace
  const stakeKeys = new Map(); // stakeAddress -> { entity, addresses }

  for (const [entity, data] of Object.entries(deepTrace)) {
    if (!data?.shelleyHits) continue;
    for (const hit of data.shelleyHits) {
      if (hit.stakeAddress && !stakeKeys.has(hit.stakeAddress)) {
        stakeKeys.set(hit.stakeAddress, {
          entity: data.entityName,
          foundAt: hit.address,
          flowedAda: hit.flowedAda,
          depth: hit.depth
        });
      }
    }
  }

  console.log(`\nFound ${stakeKeys.size} unique stake keys from deep trace\n`);

  const results = [];

  for (const [stakeAddr, meta] of stakeKeys) {
    const analysis = await analyzeStakeKey(stakeAddr, meta.entity);
    if (analysis) {
      analysis.traceContext = meta;
      results.push(analysis);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  STAKE KEY ANALYSIS SUMMARY');
  console.log('='.repeat(60));

  let totalControlled = 0;
  let totalGov = 0;
  let totalNoGov = 0;

  const sorted = results.sort((a, b) => b.controlledAda - a.controlledAda);
  for (const r of sorted) {
    totalControlled += r.controlledAda;
    if (r.governanceActive) totalGov += r.controlledAda;
    else totalNoGov += r.controlledAda;

    const hasDel = !!(r.poolId || r.drepId);
    let govLabel;
    if (r.controlledAda > 0 && hasDel) govLabel = 'STAKED';       // Real stake + delegation
    else if (r.controlledAda > 0 && !hasDel) govLabel = 'IDLE';   // ADA exists but not delegated
    else if (r.controlledAda === 0 && hasDel) govLabel = 'GHOST';  // Empty delegation, 0 weight
    else govLabel = 'EMPTY';                                        // Nothing
    console.log(`  ${r.controlledAda.toLocaleString().padStart(15)} ADA | ${govLabel.padEnd(6)} | ${r.addressCount} addrs | Pool: ${(r.poolId || 'none').substring(0, 20)}... | DRep: ${(r.drepId || 'none').substring(0, 20)}... | ${r.sourceEntity}`);
  }

  console.log(`\n  Total stake keys:     ${results.length}`);
  console.log(`  Total controlled:     ${totalControlled.toLocaleString()} ADA`);
  console.log(`  In governance:        ${totalGov.toLocaleString()} ADA`);
  console.log(`  NOT in governance:    ${totalNoGov.toLocaleString()} ADA`);
  console.log(`  Governance rate:      ${((totalGov / Math.max(totalControlled, 1)) * 100).toFixed(1)}%`);

  // Save
  const savePath = path.join(outputDir, `stake-analysis-${Date.now()}.json`);
  fs.writeFileSync(savePath, JSON.stringify({ stakeKeys: sorted, summary: { totalControlled, totalGov, totalNoGov, keyCount: results.length }}, null, 2));
  console.log(`\nSaved: ${savePath}`);
}

main().catch(console.error);
