const { createClient, rateLimited, fetchAll } = require('./blockfrost-client');
const { FOUNDING_ENTITIES, GENESIS_TX } = require('./known-addresses');

const api = createClient();

// Get full address info (balance, stake key, type)
async function getAddressInfo(address) {
  try {
    const info = await rateLimited(() => api.addresses(address));
    return {
      address: info.address,
      type: info.type,
      stakeAddress: info.stake_address,
      script: info.script
    };
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

// Get current balance for an address
async function getAddressBalance(address) {
  try {
    const info = await rateLimited(() => api.addresses(address));
    const lovelace = info.amount.find(a => a.unit === 'lovelace');
    return {
      address,
      ada: lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0,
      lovelace: lovelace ? lovelace.quantity : '0',
      tokenCount: info.amount.length - 1
    };
  } catch (err) {
    if (err.status_code === 404) return { address, ada: 0, lovelace: '0', tokenCount: 0 };
    throw err;
  }
}

// Get all transactions for an address (paginated)
async function getAddressTransactions(address, maxPages = 10) {
  const txs = [];
  let page = 1;
  while (page <= maxPages) {
    try {
      const batch = await rateLimited(() =>
        api.addressesTransactions(address, { page, count: 100, order: 'asc' })
      );
      if (!batch || batch.length === 0) break;
      txs.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (err.status_code === 404) break;
      throw err;
    }
  }
  return txs;
}

// Get transaction UTXOs (inputs and outputs)
async function getTxUtxos(txHash) {
  try {
    return await rateLimited(() => api.txsUtxos(txHash));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

// Get transaction details
async function getTxDetails(txHash) {
  try {
    return await rateLimited(() => api.txs(txHash));
  } catch (err) {
    if (err.status_code === 404) return null;
    throw err;
  }
}

// Trace an address: where did funds go in the first N hops?
async function traceAddress(address, entityName, maxHops = 2) {
  console.log(`\n--- Tracing ${entityName}: ${address} ---`);

  // Step 1: Current balance
  const balance = await getAddressBalance(address);
  console.log(`  Current balance: ${balance.ada.toLocaleString()} ADA`);

  // Step 2: Address info (stake key, type)
  const info = await getAddressInfo(address);
  if (info) {
    console.log(`  Type: ${info.type}`);
    if (info.stakeAddress) console.log(`  Stake key: ${info.stakeAddress}`);
  }

  // Step 3: Transaction history
  const txs = await getAddressTransactions(address, 20);
  console.log(`  Total transactions: ${txs.length}`);

  if (txs.length === 0) {
    console.log(`  [!] No transactions found - address may be unredeemed`);
    return {
      entity: entityName,
      address,
      balance,
      info,
      transactions: 0,
      firstHopDestinations: [],
      status: 'unredeemed'
    };
  }

  // Step 4: Analyze first-hop destinations
  const destinations = [];
  const txLimit = Math.min(txs.length, 50); // cap analysis

  for (let i = 0; i < txLimit; i++) {
    const tx = txs[i];
    const utxos = await getTxUtxos(tx.tx_hash);
    if (!utxos) continue;

    // Find outputs that are NOT back to this address (i.e., sent elsewhere)
    const outgoing = utxos.outputs.filter(o => o.address !== address);
    const selfOutputs = utxos.outputs.filter(o => o.address === address);

    for (const out of outgoing) {
      const adaAmount = out.amount.find(a => a.unit === 'lovelace');
      const ada = adaAmount ? Number(BigInt(adaAmount.quantity) / 1_000_000n) : 0;

      if (ada > 0) {
        destinations.push({
          txHash: tx.tx_hash,
          blockHeight: tx.block_height,
          toAddress: out.address,
          ada,
          lovelace: adaAmount ? adaAmount.quantity : '0',
          outputIndex: out.output_index
        });
      }
    }

    // Progress indicator
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  Analyzed ${i + 1}/${txLimit} transactions...\r`);
    }
  }

  console.log(`  First-hop destinations: ${destinations.length}`);

  // Step 5: Aggregate by destination address
  const destMap = {};
  for (const d of destinations) {
    if (!destMap[d.toAddress]) {
      destMap[d.toAddress] = { address: d.toAddress, totalAda: 0, txCount: 0, txHashes: [] };
    }
    destMap[d.toAddress].totalAda += d.ada;
    destMap[d.toAddress].txCount++;
    destMap[d.toAddress].txHashes.push(d.txHash);
  }

  const aggregated = Object.values(destMap).sort((a, b) => b.totalAda - a.totalAda);

  console.log(`  Unique destination addresses: ${aggregated.length}`);
  console.log(`\n  Top 10 destinations:`);
  aggregated.slice(0, 10).forEach((d, i) => {
    const shortAddr = d.address.substring(0, 40) + '...';
    console.log(`    ${i + 1}. ${d.totalAda.toLocaleString()} ADA → ${shortAddr} (${d.txCount} txs)`);
  });

  return {
    entity: entityName,
    address,
    balance,
    info,
    transactions: txs.length,
    firstHopDestinations: aggregated,
    allDestinations: destinations,
    status: 'traced'
  };
}

// Look up the genesis distribution transaction to find IOHK's address
async function findIohkAddress() {
  console.log(`\nLooking up genesis tx: ${GENESIS_TX}`);
  const utxos = await getTxUtxos(GENESIS_TX);
  if (!utxos) {
    console.log('  Genesis TX not found');
    return null;
  }

  console.log(`  Inputs: ${utxos.inputs.length}, Outputs: ${utxos.outputs.length}`);

  const knownAddresses = [
    ...FOUNDING_ENTITIES.emurgo.byronAddresses,
    ...FOUNDING_ENTITIES.cardanoFoundation.byronAddresses
  ];

  const unknownOutputs = utxos.outputs.filter(o => !knownAddresses.includes(o.address));

  for (const out of utxos.outputs) {
    const lovelace = out.amount.find(a => a.unit === 'lovelace');
    const ada = lovelace ? Number(BigInt(lovelace.quantity) / 1_000_000n) : 0;
    const known = knownAddresses.includes(out.address) ? ' [KNOWN]' : ' [?]';
    console.log(`  Output: ${ada.toLocaleString()} ADA → ${out.address.substring(0, 40)}...${known}`);
  }

  // The unknown large output should be IOHK
  const iohkCandidate = unknownOutputs
    .map(o => ({
      address: o.address,
      ada: Number(BigInt(o.amount.find(a => a.unit === 'lovelace')?.quantity || '0') / 1_000_000n)
    }))
    .sort((a, b) => b.ada - a.ada)[0];

  if (iohkCandidate && Math.abs(iohkCandidate.ada - FOUNDING_ENTITIES.iohk.genesisAda) < 1000) {
    console.log(`\n  [!] IOHK address found: ${iohkCandidate.address}`);
    return iohkCandidate.address;
  }

  return unknownOutputs.length > 0 ? unknownOutputs[0].address : null;
}

// Trace all founding entities
async function traceAllEntities() {
  const results = {};

  // Try to find IOHK address first
  const iohkAddr = await findIohkAddress();
  if (iohkAddr) {
    FOUNDING_ENTITIES.iohk.byronAddresses.push(iohkAddr);
  }

  for (const [key, entity] of Object.entries(FOUNDING_ENTITIES)) {
    for (const addr of entity.byronAddresses) {
      const result = await traceAddress(addr, entity.name);
      results[key] = result;
    }
    if (entity.byronAddresses.length === 0) {
      console.log(`\n--- Skipping ${entity.name}: no known addresses ---`);
      results[key] = { entity: entity.name, status: 'unknown_address' };
    }
  }

  return results;
}

module.exports = {
  getAddressInfo,
  getAddressBalance,
  getAddressTransactions,
  getTxUtxos,
  getTxDetails,
  traceAddress,
  findIohkAddress,
  traceAllEntities
};
