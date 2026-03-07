const { createClient, rateLimited } = require('./blockfrost-client');

const api = createClient();

// Known exchange address patterns and stake keys
// These are built up from community knowledge + rich list analysis
const CEX_IDENTIFIERS = {
  // Stake keys associated with major exchanges
  // Populated through rich list analysis and known exchange patterns
  stakeKeys: new Map(),
  // Address prefix patterns (first ~60 chars tend to be unique per entity)
  addressPrefixes: new Map(),
  // Full addresses confirmed as exchange
  confirmedAddresses: new Set()
};

// Heuristic: detect if an address is likely a CEX based on patterns
// Large number of small incoming txs + few large outgoing = exchange deposit
async function analyzeAddressPattern(address) {
  try {
    const info = await rateLimited(() => api.addresses(address));
    const txCount = info.tx_count || 0;

    // High tx count with no stake = likely exchange
    const isHighVolume = txCount > 100;
    const hasNoStake = !info.stake_address;
    const isScript = info.script;

    return {
      address,
      txCount,
      hasStakeKey: !!info.stake_address,
      stakeAddress: info.stake_address,
      isScript,
      likelyCex: isHighVolume && hasNoStake,
      confidence: calculateCexConfidence(txCount, !!info.stake_address, isScript)
    };
  } catch (err) {
    return { address, likelyCex: false, confidence: 0 };
  }
}

function calculateCexConfidence(txCount, hasStake, isScript) {
  let score = 0;
  if (txCount > 1000) score += 40;
  else if (txCount > 100) score += 20;
  else if (txCount > 50) score += 10;

  if (!hasStake) score += 30; // Exchanges rarely stake
  if (isScript) score += 10; // Many exchange addresses are scripts

  return Math.min(score, 100);
}

// Classify a set of destination addresses
async function classifyDestinations(destinations) {
  console.log('\n=== CEX / CUSTODIAN DETECTION ===\n');

  const classified = {
    likelyCex: [],
    likelySelfCustody: [],
    unknown: [],
    totalToCex: 0,
    totalToSelfCustody: 0,
    totalUnknown: 0
  };

  for (const dest of destinations) {
    const analysis = await analyzeAddressPattern(dest.address);
    dest.cexAnalysis = analysis;

    if (analysis.likelyCex || analysis.confidence >= 50) {
      classified.likelyCex.push(dest);
      classified.totalToCex += dest.totalAda;
    } else if (analysis.hasStakeKey) {
      classified.likelySelfCustody.push(dest);
      classified.totalToSelfCustody += dest.totalAda;
    } else {
      classified.unknown.push(dest);
      classified.totalUnknown += dest.totalAda;
    }
  }

  console.log(`  Likely CEX:           ${classified.likelyCex.length} addresses (${classified.totalToCex.toLocaleString()} ADA)`);
  console.log(`  Likely Self-Custody:  ${classified.likelySelfCustody.length} addresses (${classified.totalToSelfCustody.toLocaleString()} ADA)`);
  console.log(`  Unknown:              ${classified.unknown.length} addresses (${classified.totalUnknown.toLocaleString()} ADA)`);

  return classified;
}

// Enrich CEX database from Cardanoscan rich list (manual bootstrap)
// This would ideally scrape/fetch known addresses, but for now uses known patterns
function getKnownCexStakeKeys() {
  return [
    // These would be populated from Cardanoscan top addresses analysis
    // Format: { stakeKey, label, confidence }
  ];
}

module.exports = { analyzeAddressPattern, classifyDestinations, getKnownCexStakeKeys };
