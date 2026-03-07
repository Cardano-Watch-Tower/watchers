// Known founding entity genesis addresses (Byron era)
// Source: https://forum.cardano.org/t/cardano-foundation-and-emurgo-ada-holdings/15991
// Verified against cardano.org/genesis allocation amounts

const FOUNDING_ENTITIES = {
  emurgo: {
    name: 'Emurgo',
    genesisAda: 2_074_165_644,
    byronAddresses: [
      'Ae2tdPwUPEZGcVv9qJ3KSTx5wk3dHKNn6G3a3eshzqX2y3N9LzL3ZTBEApq'
    ],
    shelleyAddresses: [], // populated by tracer
    notes: 'Commercial arm. Built Yoroi wallet. 40% of dev pool.'
  },
  cardanoFoundation: {
    name: 'Cardano Foundation',
    genesisAda: 648_176_761,
    byronAddresses: [
      'Ae2tdPwUPEZ9dH9VC4iVXZRNYe5HGc73AKVMYHExpgYBmDMkgCUgnJGqqqq'
    ],
    shelleyAddresses: [],
    notes: 'Swiss non-profit. 12% of dev pool. Published 2024 Financial Report via Reeve.'
  },
  iohk: {
    name: 'IOHK / Input Output',
    genesisAda: 2_463_071_701,
    byronAddresses: [
      'DdzFFzCqrhsytyf2oUxqFNXDX9MfAFBWk9pTBXViZbSwxEi7PYcq9LSjBDcW6BVcA7KxgeixYWospQKn68P9PaviM2FvhTFvsEezT8qg'
    ],
    shelleyAddresses: [],
    notes: 'Engineering company. 48% of dev pool. Built Cardano.'
  }
};

// Known reference transaction from genesis distribution
const GENESIS_TX = 'fa2d2a70c0b5fd45cb6c3989f02813061f9d27f15f30ecddd38780c59f413c62';

// Genesis totals from cardano.org/genesis
const GENESIS_STATS = {
  totalAtLaunch: 31_112_484_646,
  publicSale: 25_927_070_538,
  devPool: 5_185_414_108,
  maxSupply: 45_000_000_000,
  tranches: {
    T1: { btc: 9080.1, ada: 1_255_160_024, invoices: 277 },
    T2: { btc: 40202.2, ada: 7_729_842_852, invoices: 4100 },
    T3: { btc: 24278.9, ada: 5_923_771_020, invoices: 2903 },
    T3_5: { btc: 2462.6, ada: 721_948_412, invoices: 301 },
    T4: { btc: 32820.7, ada: 10_296_348_230, invoices: 6821 }
  },
  totalVouchers: 14_402,
  btcExodusWallets: {
    T1: '3LZU6nDHGFfNrcs15qZcPA7xDDMHBbDN28',
    T2: '37UmWw8rQpmomsHmq62AiE6EXgbi59UFAe',
    T3a: '37jFLuEE5E7Cg3H72GQyDbkBGPgfeT4jYW',
    T3b: '38fsdtpzNv1nsoc4ho9wDBBdtqHCy72wKR',
    T4: '3KJUJUQS3XwYiiZ9uzVdqJwbnnUjPYLcmy'
  }
};

// Known CEX hot/deposit wallet patterns
// Sources: community databases, known exchange addresses from explorers
const KNOWN_CEX_ADDRESSES = {
  binance: {
    name: 'Binance',
    // Binance hot wallet addresses (known from large volume patterns)
    patterns: ['addr1z8snz7c4974vzdpxu65ruphl3zjdvtxw8strf2c2tmqnxz'],
    stakeKeys: []
  },
  coinbase: {
    name: 'Coinbase',
    patterns: [],
    stakeKeys: []
  },
  kraken: {
    name: 'Kraken',
    patterns: [],
    stakeKeys: []
  },
  bitfinex: {
    name: 'Bitfinex',
    patterns: [],
    stakeKeys: []
  },
  // Will be populated as we discover more through the rich list
};

// Known custodian addresses
const KNOWN_CUSTODIANS = {
  // These will be populated through rich list analysis
};

module.exports = {
  FOUNDING_ENTITIES,
  GENESIS_TX,
  GENESIS_STATS,
  KNOWN_CEX_ADDRESSES,
  KNOWN_CUSTODIANS
};
