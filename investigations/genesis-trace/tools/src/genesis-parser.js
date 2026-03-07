const fs = require('fs');
const path = require('path');

function parseGenesisFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const genesis = JSON.parse(raw);

  const avvmEntries = genesis.avvmDistr || {};
  const nonAvvm = genesis.nonAvvmBalances || {};

  const avvmKeys = Object.keys(avvmEntries);
  let totalLovelace = BigInt(0);

  const entries = avvmKeys.map(key => {
    const lovelace = BigInt(avvmEntries[key]);
    totalLovelace += lovelace;
    return {
      avvmKey: key, // base64-encoded Ed25519 public key
      lovelace: lovelace.toString(),
      ada: Number(lovelace / 1_000_000n)
    };
  });

  // Sort by ADA amount descending
  entries.sort((a, b) => Number(BigInt(b.lovelace) - BigInt(a.lovelace)));

  return {
    totalEntries: entries.length,
    totalAda: Number(totalLovelace / 1_000_000n),
    totalLovelace: totalLovelace.toString(),
    nonAvvmCount: Object.keys(nonAvvm).length,
    topEntries: entries.slice(0, 20),
    allEntries: entries,
    // Boot stakeholders might indicate genesis key holders
    bootStakeholders: genesis.bootStakeholders || {},
    heavyDelegation: genesis.heavyDelegation || {}
  };
}

function printGenesisSummary(parsed) {
  console.log('\n=== CARDANO GENESIS BLOCK ANALYSIS ===\n');
  console.log(`AVVM Entries:       ${parsed.totalEntries.toLocaleString()}`);
  console.log(`Total ADA (AVVM):   ${parsed.totalAda.toLocaleString()} ADA`);
  console.log(`Non-AVVM Entries:   ${parsed.nonAvvmCount}`);
  console.log(`Boot Stakeholders:  ${Object.keys(parsed.bootStakeholders).length}`);
  console.log(`Heavy Delegations:  ${Object.keys(parsed.heavyDelegation).length}`);

  console.log('\n--- Top 10 Largest AVVM Entries ---');
  parsed.topEntries.slice(0, 10).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.ada.toLocaleString()} ADA  [key: ${e.avvmKey.substring(0, 20)}...]`);
  });
}

module.exports = { parseGenesisFile, printGenesisSummary };
