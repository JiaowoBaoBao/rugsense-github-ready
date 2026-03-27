const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { id, nowIso, round } = require('../utils/helpers');

const execFileAsync = promisify(execFile);

function createSimulatedReceipt({ amountUsdc, payer, payee, decisionId, token }) {
  return {
    id: id('x402'),
    ts: nowIso(),
    payer,
    payee,
    amountUsdc: round(amountUsdc, 6),
    status: 'SETTLED_SIMULATED',
    txRef: `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    decisionId,
    token,
    paymentMode: 'SIMULATED'
  };
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text, fromIndex = 0) {
  const start = text.indexOf('{', fromIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

function parseSettlement(stdout = '') {
  const marker = 'Settlement:';
  const idx = stdout.indexOf(marker);
  if (idx === -1) return null;
  const maybeJson = extractJsonObject(stdout, idx + marker.length);
  return safeJsonParse(maybeJson);
}

function parsePaymentResponseHeader(headerValue = '') {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parsePaymentRequiredHeader(headerValue = '') {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isSolanaNetwork(network = '') {
  const n = String(network || '').toLowerCase();
  return n.startsWith('solana:') || n.startsWith('sol:');
}

function resolveX402ScriptPath(x402Cfg = {}) {
  const configured = x402Cfg.scriptPath || process.env.RUGSENSE_X402_SCRIPT_PATH;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }

  // rugsense-v3 -> ../skills/bitget-wallet/scripts/x402_pay.py
  return path.resolve(process.cwd(), '../skills/bitget-wallet/scripts/x402_pay.py');
}

function resolvePrivateKeyOptions({ x402Cfg, args, env, solana = false }) {
  const fileCandidates = [
    solana ? (x402Cfg.privateKeyFileSol || process.env.RUGSENSE_X402_PRIVATE_KEY_FILE_SOL) : null,
    x402Cfg.privateKeyFile || process.env.RUGSENSE_X402_PRIVATE_KEY_FILE
  ].filter(Boolean);

  if (fileCandidates.length) {
    const privateKeyFile = fileCandidates[0];
    const resolved = path.isAbsolute(privateKeyFile)
      ? privateKeyFile
      : path.resolve(process.cwd(), privateKeyFile);

    if (!fs.existsSync(resolved)) {
      throw new Error(`x402 private key file not found: ${resolved}`);
    }

    args.push('--private-key-file', resolved);
    return;
  }

  const keyCandidates = [
    solana ? (x402Cfg.privateKeySol || process.env.RUGSENSE_X402_PRIVATE_KEY_SOL) : null,
    x402Cfg.privateKey || process.env.RUGSENSE_X402_PRIVATE_KEY || process.env.X402_PRIVATE_KEY
  ].filter(Boolean);

  if (!keyCandidates.length) {
    throw new Error(
      solana
        ? 'Missing Solana x402 private key. Set reward.x402.privateKeyFileSol / RUGSENSE_X402_PRIVATE_KEY_FILE_SOL or reward.x402.privateKeySol / RUGSENSE_X402_PRIVATE_KEY_SOL.'
        : 'Missing x402 private key. Set reward.x402.privateKeyFile / RUGSENSE_X402_PRIVATE_KEY_FILE or reward.x402.privateKey / RUGSENSE_X402_PRIVATE_KEY.'
    );
  }

  env.X402_PRIVATE_KEY = keyCandidates[0];
}

function buildRequestPayload({ amountUsdc, payer, payee, decisionId, token, x402Cfg }) {
  return x402Cfg.data || {
    reward: {
      decisionId,
      token,
      amountUsdc: round(amountUsdc, 6),
      payer,
      payee,
      ts: nowIso()
    }
  };
}

function buildHeaderObject(x402Cfg = {}) {
  const headers = x402Cfg.headers || {};
  return Object.fromEntries(
    Object.entries(headers).filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
  );
}

async function httpRequest({ url, method = 'POST', bodyObj = null, headers = {}, timeoutMs = 60000 }) {
  const upperMethod = String(method || 'POST').toUpperCase();
  const hasBody = upperMethod !== 'GET' && bodyObj !== null && bodyObj !== undefined;

  const resp = await fetch(url, {
    method: upperMethod,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: hasBody ? JSON.stringify(bodyObj) : undefined,
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 60000))
  });

  const text = await resp.text();
  return { resp, text };
}

async function createBitgetSkillReceiptEvm({ amountUsdc, payer, payee, decisionId, token, rewardCfg }) {
  const x402Cfg = rewardCfg?.x402 || {};
  const endpointUrl = x402Cfg.url || process.env.RUGSENSE_X402_PAY_URL;

  if (!endpointUrl) {
    throw new Error('reward.x402.url is required for real x402 settlement');
  }

  const scriptPath = resolveX402ScriptPath(x402Cfg);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`bitget x402 script not found: ${scriptPath}`);
  }

  const method = String(x402Cfg.method || process.env.RUGSENSE_X402_METHOD || 'POST').toUpperCase();
  const chainId = Number(x402Cfg.chainId || process.env.RUGSENSE_X402_CHAIN_ID || 0) || null;
  const timeoutMs = Number(x402Cfg.timeoutMs || process.env.RUGSENSE_X402_TIMEOUT_MS || 60_000);

  const requestPayload = buildRequestPayload({ amountUsdc, payer, payee, decisionId, token, x402Cfg });

  const args = [
    scriptPath,
    'pay',
    '--url', endpointUrl,
    '--method', method,
    '--auto'
  ];

  if (chainId) {
    args.push('--chain-id', String(chainId));
  }

  if (method !== 'GET' && requestPayload) {
    args.push('--data', JSON.stringify(requestPayload));
  }

  const headerObj = buildHeaderObject(x402Cfg);
  const headerEntries = Object.entries(headerObj);
  if (headerEntries.length) {
    args.push('--header', ...headerEntries.map(([k, v]) => `${k}: ${v}`));
  }

  const env = { ...process.env };
  resolvePrivateKeyOptions({ x402Cfg, args, env, solana: false });

  let stdout;
  let stderr;
  try {
    const out = await execFileAsync('python3', args, {
      cwd: process.cwd(),
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    stdout = out.stdout || '';
    stderr = out.stderr || '';
  } catch (err) {
    const errOut = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').slice(0, 800);
    throw new Error(`bitget x402 payment failed: ${errOut}`);
  }

  const responseStatus = Number((stdout.match(/Response:\s*(\d+)/) || [])[1] || 0);
  const settlement = parseSettlement(stdout);
  const txRef = settlement?.transaction || settlement?.txHash || settlement?.txid || null;

  const settled = responseStatus === 200 && settlement?.success !== false;

  return {
    id: id('x402'),
    ts: nowIso(),
    payer,
    payee,
    amountUsdc: round(amountUsdc, 6),
    status: settled ? 'SETTLED_ONCHAIN' : 'SETTLEMENT_FAILED',
    txRef,
    decisionId,
    token,
    paymentMode: 'BITGET_SKILL_X402',
    endpointUrl,
    responseStatus,
    settlement,
    error: settled ? null : (stderr || stdout || 'unknown payment failure').slice(0, 800)
  };
}

function extractSolanaSerializedTx(requirement = {}) {
  const extra = requirement.extra || {};
  return (
    extra.serializedTransaction
    || extra.transaction
    || requirement.serializedTransaction
    || requirement.transaction
    || null
  );
}

function extractSolanaPayer(payload = {}, fallback = null) {
  return payload?.payload?.publicKey
    || payload?.payload?.payer
    || payload?.payload?.from
    || fallback;
}

async function createBitgetSkillReceiptSolana({ amountUsdc, payer, payee, decisionId, token, rewardCfg }) {
  const x402Cfg = rewardCfg?.x402 || {};
  const endpointUrl = x402Cfg.url || process.env.RUGSENSE_X402_PAY_URL;
  if (!endpointUrl) {
    throw new Error('reward.x402.url is required for Solana x402 settlement');
  }

  const scriptPath = resolveX402ScriptPath(x402Cfg);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`bitget x402 script not found: ${scriptPath}`);
  }

  const method = String(x402Cfg.method || process.env.RUGSENSE_X402_METHOD || 'POST').toUpperCase();
  const timeoutMs = Number(x402Cfg.timeoutMs || process.env.RUGSENSE_X402_TIMEOUT_MS || 60_000);
  const verifyMode = String(x402Cfg.verifyMode || 'mock').toLowerCase();

  const requestPayload = buildRequestPayload({ amountUsdc, payer, payee, decisionId, token, x402Cfg });
  const headers = buildHeaderObject(x402Cfg);

  // Step 1: get payment-required challenge
  const first = await httpRequest({
    url: endpointUrl,
    method,
    bodyObj: method === 'GET' ? null : requestPayload,
    headers,
    timeoutMs
  });

  if (first.resp.status !== 402) {
    throw new Error(`solana x402 expected 402 challenge, got ${first.resp.status}: ${(first.text || '').slice(0, 300)}`);
  }

  const requiredHeader = first.resp.headers.get('payment-required') || '';
  const paymentRequired = parsePaymentRequiredHeader(requiredHeader);
  const accepted = paymentRequired?.accepts?.[0];
  if (!accepted) {
    throw new Error('solana x402 missing payment-required accepts[0]');
  }

  let payload;
  if (verifyMode === 'mock') {
    // In mock mode, real signatures are optional to simplify end-to-end validation
    payload = {
      x402Version: 2,
      accepted,
      payload: {
        publicKey: x402Cfg.payerPublicKey || null,
        mock: true,
        ts: nowIso()
      }
    };
  } else {
    // Strict mode requires a signable transaction in the challenge
    const serializedTx = extractSolanaSerializedTx(accepted);
    if (!serializedTx) {
      throw new Error('solana strict mode requires payment-required.accepts[0].extra.serializedTransaction (or transaction)');
    }

    const signArgs = [scriptPath, 'sign-solana', '--transaction', serializedTx];
    const env = { ...process.env };
    resolvePrivateKeyOptions({ x402Cfg, args: signArgs, env, solana: true });

    const signedOut = await execFileAsync('python3', signArgs, {
      cwd: process.cwd(),
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });

    const signedTx = String(signedOut.stdout || '').trim();
    if (!signedTx) {
      throw new Error('solana sign-solana returned empty signature payload');
    }

    payload = {
      x402Version: 2,
      accepted,
      payload: {
        transaction: signedTx,
        signedTransaction: signedTx,
        serializedTransaction: signedTx
      }
    };
  }

  // Step 2: retry with PAYMENT-SIGNATURE
  const paySig = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const secondHeaders = {
    ...headers,
    'PAYMENT-SIGNATURE': paySig
  };

  const second = await httpRequest({
    url: endpointUrl,
    method,
    bodyObj: method === 'GET' ? null : requestPayload,
    headers: secondHeaders,
    timeoutMs
  });

  const settlement = parsePaymentResponseHeader(second.resp.headers.get('payment-response') || '') || null;
  const txRef = settlement?.transaction || settlement?.txHash || settlement?.txid || null;
  const settled = second.resp.status === 200 && settlement?.success !== false;

  return {
    id: id('x402'),
    ts: nowIso(),
    payer,
    payee,
    amountUsdc: round(amountUsdc, 6),
    status: settled ? 'SETTLED_ONCHAIN' : 'SETTLEMENT_FAILED',
    txRef,
    decisionId,
    token,
    paymentMode: 'BITGET_SKILL_X402_SOLANA',
    endpointUrl,
    responseStatus: second.resp.status,
    settlement: settlement || {
      network: accepted.network,
      payer: extractSolanaPayer(payload, null),
      success: second.resp.status === 200,
      transaction: txRef
    },
    error: settled ? null : (second.text || 'unknown payment failure').slice(0, 800)
  };
}

async function createBitgetSkillReceipt({ amountUsdc, payer, payee, decisionId, token, rewardCfg }) {
  const network = rewardCfg?.x402?.network || '';
  if (isSolanaNetwork(network)) {
    return createBitgetSkillReceiptSolana({ amountUsdc, payer, payee, decisionId, token, rewardCfg });
  }
  return createBitgetSkillReceiptEvm({ amountUsdc, payer, payee, decisionId, token, rewardCfg });
}

function loadEthers() {
  try {
    return require('ethers');
  } catch {
    const fallback = path.resolve(process.cwd(), '../evohive/node_modules/ethers');
    return require(fallback);
  }
}

function readKeychainSecret({ service, account }) {
  const out = execFileSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
    encoding: 'utf8'
  });
  const mnemonic = String(out || '').trim();
  if (!mnemonic) throw new Error('empty mnemonic from keychain');
  return mnemonic;
}

function resolvePrivateKeyFromCfg(cfg = {}) {
  if (cfg.privateKey) return String(cfg.privateKey).trim();

  const envName = cfg.privateKeyEnv || 'RUGSENSE_DIRECT_TRANSFER_PRIVATE_KEY';
  if (process.env[envName]) return String(process.env[envName]).trim();

  const privateKeyFile = cfg.privateKeyFile || process.env.RUGSENSE_DIRECT_TRANSFER_PRIVATE_KEY_FILE;
  if (!privateKeyFile) return null;

  const resolved = path.isAbsolute(privateKeyFile)
    ? privateKeyFile
    : path.resolve(process.cwd(), privateKeyFile);

  if (!fs.existsSync(resolved)) {
    throw new Error(`direct transfer private key file not found: ${resolved}`);
  }

  return String(fs.readFileSync(resolved, 'utf8')).trim();
}

function deriveEvmWalletsFromKeychain(cfg = {}) {
  const ethers = loadEthers();
  const service = cfg.keychainService || 'openclaw.bitget.wallet.mnemonic';
  const account = cfg.keychainAccount || 'openclaw-bitget';
  const mnemonic = readKeychainSecret({ service, account });

  const fromPath = cfg.fromDerivationPath || "m/44'/60'/0'/0/0";
  const toPath = cfg.toDerivationPath || "m/44'/60'/0'/0/1";

  const fromWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, fromPath);
  const toWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, toPath);

  return {
    fromPrivateKey: fromWallet.privateKey,
    fromAddress: fromWallet.address,
    toAddress: toWallet.address
  };
}

async function createDirectTransferReceipt({ amountUsdc, payer, payee, decisionId, token, rewardCfg }) {
  const ethers = loadEthers();
  const transferCfg = rewardCfg?.directTransfer || {};

  const network = String(transferCfg.network || rewardCfg?.x402?.network || 'eip155:8453');
  if (isSolanaNetwork(network)) {
    throw new Error('DIRECT_TRANSFER currently supports EVM only in this build.');
  }

  const rpcUrl = transferCfg.rpcUrl || process.env.RUGSENSE_DIRECT_TRANSFER_RPC_URL || 'https://mainnet.base.org';
  const chainId = Number(transferCfg.chainId || 8453);
  const dryRun = transferCfg.dryRun !== false;

  let fromPrivateKey = resolvePrivateKeyFromCfg(transferCfg);
  let fromAddress = transferCfg.fromAddress || null;
  let toAddress = transferCfg.toAddress || transferCfg.payTo || rewardCfg?.x402?.payTo || null;

  if (!fromPrivateKey && transferCfg.useKeychain !== false) {
    const derived = deriveEvmWalletsFromKeychain(transferCfg);
    fromPrivateKey = derived.fromPrivateKey;
    fromAddress = fromAddress || derived.fromAddress;
    toAddress = toAddress || derived.toAddress;
  }

  if (!fromPrivateKey) {
    throw new Error('DIRECT_TRANSFER missing sender private key (set reward.directTransfer.privateKey/privateKeyFile or enable keychain derivation).');
  }

  if (!toAddress) {
    throw new Error('DIRECT_TRANSFER missing toAddress/payTo.');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(fromPrivateKey, provider);

  if (!fromAddress) {
    fromAddress = wallet.address;
  }

  const amountBaseUnits = String(
    Number.isFinite(Number(transferCfg.amountBaseUnits))
      ? Number(transferCfg.amountBaseUnits)
      : Number.isFinite(Number(rewardCfg?.x402AmountBaseUnits))
        ? Number(rewardCfg.x402AmountBaseUnits)
        : Math.max(1, Math.round(Number(amountUsdc || 0.001) * 1_000_000))
  );

  const asset = transferCfg.asset || rewardCfg?.x402?.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const nativeAsset = String(asset).toLowerCase() === 'native';

  if (dryRun) {
    return {
      id: id('x402'),
      ts: nowIso(),
      payer,
      payee,
      amountUsdc: round(amountUsdc, 6),
      status: 'SETTLED_SIMULATED',
      txRef: `direct_dryrun_${Date.now().toString(36)}`,
      decisionId,
      token,
      paymentMode: 'DIRECT_TRANSFER_DRY_RUN',
      endpointUrl: rpcUrl,
      responseStatus: 200,
      settlement: {
        network,
        payer: fromAddress,
        payTo: toAddress,
        success: true,
        transaction: null,
        asset,
        amountBaseUnits,
        dryRun: true
      },
      error: null
    };
  }

  let tx;
  if (nativeAsset) {
    tx = await wallet.sendTransaction({
      to: toAddress,
      value: BigInt(amountBaseUnits)
    });
  } else {
    const erc20 = new ethers.Contract(
      asset,
      ['function transfer(address to, uint256 value) returns (bool)'],
      wallet
    );
    tx = await erc20.transfer(toAddress, BigInt(amountBaseUnits));
  }

  const receipt = await tx.wait(1);
  const ok = Boolean(receipt?.status === 1 || receipt?.status === undefined);

  return {
    id: id('x402'),
    ts: nowIso(),
    payer,
    payee,
    amountUsdc: round(amountUsdc, 6),
    status: ok ? 'SETTLED_ONCHAIN' : 'SETTLEMENT_FAILED',
    txRef: tx.hash,
    decisionId,
    token,
    paymentMode: 'DIRECT_TRANSFER',
    endpointUrl: rpcUrl,
    responseStatus: ok ? 200 : 500,
    settlement: {
      network,
      payer: fromAddress,
      payTo: toAddress,
      success: ok,
      transaction: tx.hash,
      asset,
      amountBaseUnits,
      blockNumber: receipt?.blockNumber || null
    },
    error: ok ? null : 'direct transfer failed'
  };
}

async function createX402RewardReceipt({ amountUsdc, payer = 'risk_agent', payee = 'yield_agent', decisionId, token, rewardCfg = {} }) {
  const mode = String(rewardCfg.paymentMode || 'BITGET_SKILL_X402').toUpperCase();
  if (mode === 'SIMULATED') {
    return createSimulatedReceipt({ amountUsdc, payer, payee, decisionId, token });
  }

  if (mode === 'DIRECT_TRANSFER') {
    return createDirectTransferReceipt({ amountUsdc, payer, payee, decisionId, token, rewardCfg });
  }

  return createBitgetSkillReceipt({ amountUsdc, payer, payee, decisionId, token, rewardCfg });
}

module.exports = { createX402RewardReceipt };
