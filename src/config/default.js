module.exports = {
  app: {
    name: 'RugSense v3.1',
    port: Number(process.env.PORT || 3781)
  },
  runtime: {
    demoMode: false,
    verificationDelayMs: 30_000,
    collectorIntervalMs: 5 * 60_000,
    positionWatchIntervalMs: 15_000,
    evolutionIntervalMs: 12 * 60 * 60_000,
    sseIntervalMs: 5_000,
    collector: {
      dynamic: true,
      candidatesPerRun: 5,
      launchpadFetchLimit: 40,
      ageMaxSec: 7200,
      minLiquidityUsd: 0,
      hideHighRisk: false,
      fallbackTargets: ['SOL', 'BONK', 'WIF']
    },
    autoAnalyze: {
      enabled: false,
      intervalMs: 5 * 60_000,
      candidatesPerRun: 1,
      launchpadFetchLimit: 20,
      ageMaxSec: 1800,
      minLiquidityUsd: 20_000,
      hideHighRisk: true,
      allowDegraded: false,
      allowSyntheticCandidates: false,
      candidateCooldownMs: 30 * 60_000,
      userVotes: ['NO_BUY', 'NO_BUY'],
      orderPct: 1,
      tickMs: 30_000
    },
    demoPresets: {
      safe: {
        simulation: {
          minLiquidityUsdByChain: { sol: 1000 },
          maxSlippagePctByChain: { sol: 3 }
        },
        autoAnalyze: {
          enabled: true,
          candidatesPerRun: 3,
          ageMaxSec: 7200,
          minLiquidityUsd: 1000,
          hideHighRisk: false,
          candidateCooldownMs: 300000,
          orderPct: 1
        },
        yield: {
          allocationMode: 'reward_only',
          balanceReinvestPct: 0,
          balanceReinvestCapPct: 0
        }
      },
      demo: {
        simulation: {
          minLiquidityUsdByChain: { sol: 500 },
          maxSlippagePctByChain: { sol: 12 }
        },
        autoAnalyze: {
          enabled: true,
          candidatesPerRun: 4,
          ageMaxSec: 7200,
          minLiquidityUsd: 500,
          hideHighRisk: false,
          candidateCooldownMs: 120000,
          orderPct: 1
        },
        yield: {
          allocationMode: 'reward_plus_balance_pct',
          balanceReinvestPct: 1,
          balanceReinvestCapPct: 2
        },
        launchpad: {
          limit: 30,
          ageMaxSec: 7200,
          minLiquidityUsd: 0,
          hideHighRisk: false
        },
        orderPct: 1
      }
    }
  },
  market: {
    defaultChain: 'sol',
    launchpad: {
      // SOL-focused scanner defaults
      defaultLimit: 20,
      defaultAgeMaxSec: 7200,
      defaultMinLiquidityUsd: 0,
      defaultHideHighRisk: false,
      cacheTtlMs: 30000
    }
  },
  voting: {
    buyThreshold: 3,
    defaultUserVotes: ['NO_BUY', 'NO_BUY']
  },
  simulation: {
    totalCapitalUsdc: 10_000,
    defaultOrderPct: 1,
    stopLossPct: -8,
    takeProfitPct: 12,
    maxHoldMinutes: 360,
    softRugDropPct15m: -35,
    riskExitScore: 75,
    minLiquidityUsd: 20_000,
    minLiquidityUsdByChain: {
      sol: 1_000
    },
    maxSlippagePct: 3,
    maxSlippagePctByChain: {
      sol: 3
    },
    minOrderNotionalUsdc: 25,
    maxConsecutiveLossesPause: 4,
    maxDrawdownPausePct: 35,
    equityStopPct: 30,
    takerFeeBps: 10,
    baseSlippageBps: 8,
    impactSlippageMultiplier: 0.35,
    maxExecutionSlippageBps: 120
  },
  reward: {
    x402AmountUsdc: 0.001,
    x402AmountBaseUnits: 1000,
    dailyRewardCapCount: 30,
    tokenCooldownHours: 24,
    paymentMode: 'BITGET_SKILL_X402',
    directTransfer: {
      // EVM direct transfer (wallet1 -> wallet2). Set paymentMode=DIRECT_TRANSFER to enable.
      network: 'eip155:8453',
      chainId: 8453,
      rpcUrl: 'https://mainnet.base.org',
      // USDC on Base; set 'native' for native coin transfer
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      // if empty, derive wallet2 from keychain path
      toAddress: '',
      // preferred: derive wallet1/wallet2 from keychain mnemonic
      useKeychain: true,
      keychainService: 'rugsense.wallet.mnemonic',
      keychainAccount: 'rugsense-wallet',
      fromDerivationPath: "m/44'/60'/0'/0/0",
      toDerivationPath: "m/44'/60'/0'/0/1",
      privateKey: '',
      privateKeyFile: '',
      privateKeyEnv: 'RUGSENSE_DIRECT_TRANSFER_PRIVATE_KEY',
      amountBaseUnits: 1000,
      // safety: dry run by default; set false for real transfer
      dryRun: true
    },
    x402: {
      // Demo default uses Pinata x402 endpoint; replace with your own 402 resource service in production
      url: 'https://402.pinata.cloud/v1/pin/private?fileSize=100',
      // Optional local x402 receiver endpoint
      internalEndpoint: 'http://localhost:3781/api/x402/reward',
      method: 'POST',
      chainId: 8453,
      network: 'eip155:8453',
      // EVM: Base USDC, Solana: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '',
      // In Solana mock mode you may provide payer public key for receipt display
      payerPublicKey: '',
      // In Solana strict mode, serialized tx template can come from upstream or local injection
      serializedTransaction: '',
      feePayer: '',
      maxTimeoutSeconds: 300,
      verifyMode: 'mock',
      security: {
        requireAuth: false,
        authHeader: 'x-rugsense-token',
        authToken: ''
      },
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        max: 60
      },
      idempotency: {
        enabled: true,
        ttlMs: 86400000
      },
      facilitator: {
        // Strict mode uses CDP x402 facilitator by default
        baseUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
        verifyPath: '/verify',
        settlePath: '/settle',
        timeoutMs: 15000,
        // authMode: bearer | headers
        authMode: 'bearer',
        apiKeyEnv: 'CDP_API_KEY',
        apiSecretEnv: 'CDP_API_SECRET',
        apiKeyHeader: 'x-api-key',
        apiSecretHeader: 'x-api-secret',
        extraHeaders: {},
        retry: {
          maxAttempts: 2,
          backoffMs: 250
        }
      },
      data: { fileSize: 100 },
      // Resolved relative to the rugsense-v3 directory
      scriptPath: '../skills/bitget-wallet/scripts/x402_pay.py',
      // Prefer environment variables; do not store private keys in plain text
      privateKeyFile: '',
      privateKey: '',
      timeoutMs: 60000,
      headers: {}
    }
  },
  yield: {
    killSwitch: false,
    allocationMode: 'reward_only',
    balanceReinvestPct: 0,
    balanceReinvestCapPct: 0,
    minApyPct: 3,
    singleOrderCapPct: 3,
    dailyNewExposureCapPct: 10,
    perProtocolExposureCapPct: 20,
    riskTvlDropExitPct1h: 20,
    riskScoreJumpExit: 20,
    riskAbsoluteExitScore: 88,
    riskConsecutiveHitsExit: 2,
    liveProducts: {
      enabled: true,
      endpoint: 'https://yields.llama.fi/pools',
      timeoutMs: 8000,
      cacheTtlMs: 300000,
      staleTtlMs: 3600000,
      minTvlUsd: 100000,
      maxRows: 800
    },
    whitelist: [
      { id: 'aave-usdc-lend', category: 'stable_lending', protocol: 'Aave', symbol: 'USDC', apyPct: 4.5, riskScore: 22 },
      { id: 'compound-usdc-lend', category: 'stable_lending', protocol: 'Compound', symbol: 'USDC', apyPct: 4.1, riskScore: 24 },
      { id: 'eth-major-staking', category: 'major_staking', protocol: 'Lido', symbol: 'ETH', apyPct: 3.4, riskScore: 28 },
      { id: 'curve-usdc-usdt', category: 'low_vol_stable_pool', protocol: 'Curve', symbol: 'USDC-USDT', apyPct: 5.0, riskScore: 30 }
    ],
    forbiddenCategories: ['leverage', 'meme', 'derivatives', 'high_risk_farm']
  },
  evolution: {
    includeSyntheticInFitness: false,
    agentMemory: {
      summaryIntervalMs: 6 * 60 * 60_000,
      maxExperiences: 160,
      maxSummaries: 40,
      maxLongTerm: 24,
      maxLifecycle: 120,
      minSamplesForReplacement: 12,
      replaceFitnessThreshold: 0.46,
      replaceGapThreshold: 0.08
    }
  },
  bitget: {
    baseUrl: 'https://copenapi.bgwapi.io',
    reliability: {
      timeoutMs: 9000,
      retries: 2,
      retryBackoffMs: 350,
      retryMaxBackoffMs: 5000,
      retryJitterMs: 250,
      circuitBreakerFailures: 4,
      circuitBreakerCooldownMs: 45_000,
      signalCacheTtlMs: 15_000,
      signalStaleTtlMs: 120_000,
      signalCacheMaxEntries: 1000,
      minSignalParts: 3
    },
    headers: {
      channel: 'toc_agent',
      brand: 'toc_agent',
      clientversion: '10.0.0',
      language: 'en',
      token: 'toc_agent'
    }
  }
};
