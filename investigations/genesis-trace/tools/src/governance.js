const { createClient, rateLimited, fetchAll } = require('./blockfrost-client');

const api = createClient();

// Check if a stake address is delegating to a stake pool
async function getStakeInfo(stakeAddress) {
  try {
    const info = await rateLimited(() => api.accounts(stakeAddress));
    return {
      stakeAddress,
      active: info.active,
      poolId: info.pool_id,
      controlledAmount: info.controlled_amount,
      ada: Number(BigInt(info.controlled_amount || '0') / 1_000_000n),
      rewardsAvailable: info.rewards_sum,
      withdrawalsSum: info.withdrawals_sum,
      reservesSum: info.reserves_sum,
      treasurySum: info.treasury_sum,
      drepId: info.drep_id || null
    };
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

// Check DRep delegation for an address
async function getDrepDelegation(stakeAddress) {
  const info = await getStakeInfo(stakeAddress);
  if (!info) return null;
  return {
    stakeAddress,
    delegatedToDrep: info.drepId,
    delegatedToPool: info.poolId,
    ada: info.ada,
    isActive: info.active
  };
}

// Get governance votes for a stake address
async function getGovernanceVotes(stakeAddress) {
  try {
    // The Blockfrost endpoint for account governance may not exist in all versions
    // Fall back to checking if the address is registered as a DRep
    const drepInfo = await rateLimited(() =>
      api.governanceDreps(stakeAddress)
    );
    return {
      isDrep: true,
      drepInfo
    };
  } catch (err) {
    return { isDrep: false, drepInfo: null };
  }
}

// Analyze governance participation for a set of traced addresses
async function analyzeGovernance(tracedResults) {
  console.log('\n=== GOVERNANCE PARTICIPATION ANALYSIS ===\n');

  const governanceReport = {};

  for (const [entityKey, trace] of Object.entries(tracedResults)) {
    if (!trace || trace.status === 'unknown_address') continue;

    console.log(`\n--- ${trace.entity} ---`);
    const entityReport = {
      entity: trace.entity,
      stakeInfo: null,
      destinations: []
    };

    // Check the source address stake info
    if (trace.info?.stakeAddress) {
      const stakeInfo = await getStakeInfo(trace.info.stakeAddress);
      if (stakeInfo) {
        entityReport.stakeInfo = stakeInfo;
        console.log(`  Stake pool: ${stakeInfo.poolId || 'none'}`);
        console.log(`  DRep delegation: ${stakeInfo.drepId || 'none'}`);
        console.log(`  Controlled: ${stakeInfo.ada.toLocaleString()} ADA`);
      }
    }

    // Check top destination addresses for governance participation
    const topDests = (trace.firstHopDestinations || []).slice(0, 20);
    let govActive = 0;
    let govInactive = 0;
    let totalGovAda = 0;
    let totalNonGovAda = 0;

    for (const dest of topDests) {
      const addrInfo = await rateLimited(() => {
        try { return api.addresses(dest.address); }
        catch { return null; }
      });

      if (addrInfo?.stake_address) {
        const stakeInfo = await getStakeInfo(addrInfo.stake_address);
        if (stakeInfo && (stakeInfo.poolId || stakeInfo.drepId)) {
          govActive++;
          totalGovAda += dest.totalAda;
          dest.governance = {
            active: true,
            pool: stakeInfo.poolId,
            drep: stakeInfo.drepId,
            controlledAda: stakeInfo.ada
          };
        } else {
          govInactive++;
          totalNonGovAda += dest.totalAda;
          dest.governance = { active: false };
        }
      } else {
        govInactive++;
        totalNonGovAda += dest.totalAda;
        dest.governance = { active: false, noStakeKey: true };
      }
      entityReport.destinations.push(dest);
    }

    console.log(`  Destinations with governance: ${govActive}/${topDests.length}`);
    console.log(`  ADA in governance: ${totalGovAda.toLocaleString()}`);
    console.log(`  ADA NOT in governance: ${totalNonGovAda.toLocaleString()}`);

    entityReport.summary = {
      governanceActiveDestinations: govActive,
      governanceInactiveDestinations: govInactive,
      adaInGovernance: totalGovAda,
      adaNotInGovernance: totalNonGovAda,
      governanceRate: topDests.length > 0
        ? ((govActive / topDests.length) * 100).toFixed(1) + '%'
        : 'N/A'
    };

    governanceReport[entityKey] = entityReport;
  }

  return governanceReport;
}

module.exports = { getStakeInfo, getDrepDelegation, getGovernanceVotes, analyzeGovernance };
