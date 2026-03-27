const crypto = require('crypto');

const runtimeState = {
  rateBuckets: new Map(),
  idempotency: new Map()
};

function b64Json(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function parseB64Json(raw = '') {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getHeader(req, name) {
  return req.get(name) || req.get(name.toLowerCase()) || req.headers?.[name] || req.headers?.[name.toLowerCase()];
}

function isSolanaNetwork(network = '') {
  const n = String(network || '').toLowerCase();
  return n.startsWith('solana:') || n.startsWith('sol:');
}

function sha256Hex(text = '') {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function nowMs() {
  return Date.now();
}

function getClientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequirement(cfg = {}) {
  const rewardCfg = cfg.reward || {};
  const x402 = rewardCfg.x402 || {};

  const chainId = Number(x402.chainId || 8453);
  const network = x402.network || `eip155:${chainId}`;
  const amount = String(
    Number.isFinite(Number(rewardCfg.x402AmountBaseUnits))
      ? Number(rewardCfg.x402AmountBaseUnits)
      : Math.max(1, Math.round(Number(rewardCfg.x402AmountUsdc || 0.001) * 1_000_000))
  );

  if (isSolanaNetwork(network)) {
    const extra = {
      assetTransferMethod: 'solana-partial-sign',
      ...(x402.feePayer ? { feePayer: x402.feePayer } : {}),
      ...(x402.serializedTransaction ? { serializedTransaction: x402.serializedTransaction } : {})
    };

    return {
      scheme: 'exact',
      network,
      amount,
      // Solana USDC mint by default
      asset: x402.asset || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: x402.payTo || '',
      maxTimeoutSeconds: Number(x402.maxTimeoutSeconds || 300),
      extra
    };
  }

  return {
    scheme: 'exact',
    network,
    amount,
    asset: x402.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: x402.payTo || '',
    maxTimeoutSeconds: Number(x402.maxTimeoutSeconds || 300),
    extra: {
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: 'eip3009'
    }
  };
}

function challenge402(req, res, cfg) {
  const requirement = buildRequirement(cfg);
  const isSolana = isSolanaNetwork(requirement.network);

  const message = requirement.payTo
    ? 'Payment required for reward settlement.'
    : 'Payment required, but reward.x402.payTo is empty. Configure receiver payTo before paying.';

  const paymentRequired = {
    x402Version: 2,
    error: 'payment_required',
    message,
    accepts: [requirement]
  };

  if (isSolana && !requirement.extra?.serializedTransaction) {
    paymentRequired.warning = 'Solana strict mode requires a serialized transaction template in accepts[0].extra.serializedTransaction';
  }

  return res
    .status(402)
    .set('payment-required', b64Json(paymentRequired))
    .json({
      ok: false,
      error: 'PAYMENT_REQUIRED',
      message,
      x402Version: 2,
      accepts: [requirement],
      ...(paymentRequired.warning ? { warning: paymentRequired.warning } : {})
    });
}

function extractPayerFromPayload(payload = {}) {
  return payload?.payload?.authorization?.from
    || payload?.payload?.publicKey
    || payload?.payload?.payer
    || payload?.payload?.from
    || payload?.payer
    || null;
}

function settleMock(cfg, payload) {
  const requirement = buildRequirement(cfg);
  const accepted = payload.accepted || {};

  const amountOk = String(accepted.amount || '') === String(requirement.amount);
  const payToOk = String(accepted.payTo || '').toLowerCase() === String(requirement.payTo || '').toLowerCase();

  if (!amountOk || !payToOk) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'PAYMENT_REQUIREMENT_MISMATCH',
        details: {
          expectedAmount: requirement.amount,
          expectedPayTo: requirement.payTo,
          gotAmount: accepted.amount,
          gotPayTo: accepted.payTo
        }
      }
    };
  }

  const settlement = {
    network: requirement.network,
    payer: extractPayerFromPayload(payload),
    success: true,
    transaction: `mock_${Date.now().toString(36)}`
  };

  return {
    status: 200,
    settlement,
    body: { ok: true, settled: true, mode: 'mock', settlement }
  };
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${base}/${p}`;
}

function buildFacilitatorAuthHeaders(cfg = {}) {
  const headers = { ...(cfg.extraHeaders || {}) };
  const mode = String(cfg.authMode || 'bearer').toLowerCase();

  const keyName = cfg.apiKeyEnv || 'CDP_API_KEY';
  const secretName = cfg.apiSecretEnv || 'CDP_API_SECRET';

  const apiKey = process.env[keyName] || '';
  const apiSecret = process.env[secretName] || '';

  if (mode === 'bearer') {
    if (!apiKey) {
      throw new Error(`missing facilitator api key env: ${keyName}`);
    }
    headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  if (!apiKey) {
    throw new Error(`missing facilitator api key env: ${keyName}`);
  }

  headers[cfg.apiKeyHeader || 'x-api-key'] = apiKey;
  if (apiSecret) {
    headers[cfg.apiSecretHeader || 'x-api-secret'] = apiSecret;
  }
  return headers;
}

async function postJson(url, body, { headers = {}, timeoutMs = 15000 } = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000))
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text
  };
}

async function postJsonWithRetry(url, body, { headers = {}, timeoutMs = 15000, retry = {} } = {}) {
  const maxAttempts = Math.max(1, Number(retry.maxAttempts || 1));
  const backoffMs = Math.max(0, Number(retry.backoffMs || 250));

  let lastResp = null;
  let lastErr = null;

  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      const resp = await postJson(url, body, { headers, timeoutMs });
      lastResp = resp;
      const retryableStatus = resp.status >= 500 || resp.status === 429;
      if (!retryableStatus || i === maxAttempts) {
        return resp;
      }
    } catch (err) {
      lastErr = err;
      if (i === maxAttempts) {
        break;
      }
    }

    if (backoffMs > 0) {
      await sleep(backoffMs * i);
    }
  }

  if (lastResp) return lastResp;
  throw lastErr || new Error('postJsonWithRetry failed');
}

function extractSettlement(result, fallbackPayer, network) {
  const fromResult = result || {};
  const nested = fromResult.result || fromResult.data || {};

  const tx = fromResult.transaction || fromResult.txHash || fromResult.txid || nested.transaction || nested.txHash || nested.txid || null;
  const successField =
    fromResult.success !== undefined ? fromResult.success
      : nested.success !== undefined ? nested.success
        : fromResult.settled !== undefined ? fromResult.settled
          : nested.settled !== undefined ? nested.settled
            : true;

  return {
    network,
    payer: fromResult.payer || nested.payer || fallbackPayer || null,
    success: Boolean(successField),
    transaction: tx
  };
}

async function settleStrict(cfg, payload) {
  const requirement = buildRequirement(cfg);
  const accepted = payload.accepted || {};

  const amountOk = String(accepted.amount || '') === String(requirement.amount);
  const payToOk = String(accepted.payTo || '').toLowerCase() === String(requirement.payTo || '').toLowerCase();

  if (!amountOk || !payToOk) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'PAYMENT_REQUIREMENT_MISMATCH',
        details: {
          expectedAmount: requirement.amount,
          expectedPayTo: requirement.payTo,
          gotAmount: accepted.amount,
          gotPayTo: accepted.payTo
        }
      }
    };
  }

  const facilitator = cfg?.reward?.x402?.facilitator || {};
  const baseUrl = facilitator.baseUrl || 'https://api.cdp.coinbase.com/platform/v2/x402';
  if (!baseUrl) {
    return { status: 501, body: { ok: false, error: 'FACILITATOR_NOT_CONFIGURED' } };
  }

  let authHeaders;
  try {
    authHeaders = buildFacilitatorAuthHeaders(facilitator);
  } catch (err) {
    return {
      status: 501,
      body: {
        ok: false,
        error: 'STRICT_VERIFY_NOT_READY',
        message: err.message
      }
    };
  }

  const verifyUrl = joinUrl(baseUrl, facilitator.verifyPath || '/verify');
  const settleUrl = joinUrl(baseUrl, facilitator.settlePath || '/settle');
  const timeoutMs = Number(facilitator.timeoutMs || 15000);
  const retryCfg = facilitator.retry || {};

  const verifyBody = {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirement,
    accepted,
    // Compatibility with alternative facilitator field naming
    payload,
    requirement
  };

  let verifyResp;
  try {
    verifyResp = await postJsonWithRetry(verifyUrl, verifyBody, { headers: authHeaders, timeoutMs, retry: retryCfg });
  } catch (err) {
    return {
      status: 502,
      body: {
        ok: false,
        error: 'FACILITATOR_VERIFY_REQUEST_FAILED',
        details: String(err.message || err)
      }
    };
  }

  if (!verifyResp.ok) {
    return {
      status: 402,
      body: {
        ok: false,
        error: 'FACILITATOR_VERIFY_FAILED',
        status: verifyResp.status,
        details: verifyResp.data || verifyResp.text
      }
    };
  }

  const settleBody = {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirement,
    verifyResult: verifyResp.data,
    accepted,
    payload,
    requirement
  };

  let settleResp;
  try {
    settleResp = await postJsonWithRetry(settleUrl, settleBody, { headers: authHeaders, timeoutMs, retry: retryCfg });
  } catch (err) {
    return {
      status: 502,
      body: {
        ok: false,
        error: 'FACILITATOR_SETTLE_REQUEST_FAILED',
        details: String(err.message || err)
      }
    };
  }

  if (!settleResp.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        error: 'FACILITATOR_SETTLE_FAILED',
        status: settleResp.status,
        details: settleResp.data || settleResp.text
      }
    };
  }

  const settlement = extractSettlement(settleResp.data, extractPayerFromPayload(payload), requirement.network);
  if (!settlement.transaction) {
    settlement.transaction = `unknown_${Date.now().toString(36)}`;
  }

  return {
    status: 200,
    settlement,
    body: { ok: true, settled: true, mode: 'strict', settlement, verify: verifyResp.data || null }
  };
}

function cleanupRateBuckets() {
  const current = nowMs();
  for (const [k, v] of runtimeState.rateBuckets.entries()) {
    if (v.resetAt <= current) runtimeState.rateBuckets.delete(k);
  }
}

function checkRateLimit(req, cfg) {
  const rateCfg = cfg?.reward?.x402?.rateLimit || {};
  const enabled = rateCfg.enabled !== false;
  if (!enabled) {
    return { ok: true };
  }

  cleanupRateBuckets();

  const windowMs = Math.max(1000, Number(rateCfg.windowMs || 60000));
  const max = Math.max(1, Number(rateCfg.max || 60));
  const key = getClientIp(req);
  const current = nowMs();

  const row = runtimeState.rateBuckets.get(key) || { count: 0, resetAt: current + windowMs };
  if (current >= row.resetAt) {
    row.count = 0;
    row.resetAt = current + windowMs;
  }

  row.count += 1;
  runtimeState.rateBuckets.set(key, row);

  if (row.count > max) {
    const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - current) / 1000));
    return {
      ok: false,
      status: 429,
      retryAfterSec,
      body: {
        ok: false,
        error: 'RATE_LIMITED',
        message: `Too many x402 requests from ${key}. Retry later.`
      }
    };
  }

  return { ok: true };
}

function checkReceiverAuth(req, cfg) {
  const secCfg = cfg?.reward?.x402?.security || {};
  const requireAuth = Boolean(secCfg.requireAuth || process.env.RUGSENSE_X402_REQUIRE_AUTH === '1');
  const configuredToken = secCfg.authToken || process.env.RUGSENSE_X402_RECEIVER_TOKEN || '';

  // If auth isn't required and no token configured, bypass.
  if (!requireAuth && !configuredToken) {
    return { ok: true };
  }

  const headerName = String(secCfg.authHeader || 'x-rugsense-token').toLowerCase();
  const directToken = getHeader(req, headerName) || '';
  const authz = getHeader(req, 'authorization') || '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

  const given = directToken || bearer;
  if (!given || !configuredToken || given !== configuredToken) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: 'UNAUTHORIZED_X402_RECEIVER',
        message: `Provide valid ${headerName} or Authorization Bearer token.`
      }
    };
  }

  return { ok: true };
}

function cleanupIdempotency(ttlMs = 24 * 60 * 60 * 1000) {
  const current = nowMs();
  for (const [k, v] of runtimeState.idempotency.entries()) {
    if (current - v.ts > ttlMs) runtimeState.idempotency.delete(k);
  }
}

function checkIdempotencyHit(signatureRaw, cfg) {
  const idemCfg = cfg?.reward?.x402?.idempotency || {};
  const enabled = idemCfg.enabled !== false;
  if (!enabled || !signatureRaw) return null;

  const ttlMs = Math.max(10_000, Number(idemCfg.ttlMs || 24 * 60 * 60 * 1000));
  cleanupIdempotency(ttlMs);

  const key = sha256Hex(signatureRaw);
  const hit = runtimeState.idempotency.get(key);
  if (!hit) return null;

  return {
    key,
    record: hit
  };
}

function storeIdempotency(signatureRaw, cfg, payload = {}) {
  const idemCfg = cfg?.reward?.x402?.idempotency || {};
  const enabled = idemCfg.enabled !== false;
  if (!enabled || !signatureRaw) return;

  const key = sha256Hex(signatureRaw);
  runtimeState.idempotency.set(key, {
    ts: nowMs(),
    mode: payload.mode || payload.body?.mode || 'unknown',
    settlement: payload.settlement || payload.body?.settlement || null,
    verify: payload.verify || payload.body?.verify || null,
    body: payload.body || null
  });
}

async function handleX402RewardRequest(req, res, cfg) {
  const authCheck = checkReceiverAuth(req, cfg);
  if (!authCheck.ok) {
    return res.status(authCheck.status || 401).json(authCheck.body || { ok: false, error: 'UNAUTHORIZED' });
  }

  const rl = checkRateLimit(req, cfg);
  if (!rl.ok) {
    if (rl.retryAfterSec) {
      res.set('retry-after', String(rl.retryAfterSec));
    }
    return res.status(rl.status || 429).json(rl.body || { ok: false, error: 'RATE_LIMITED' });
  }

  const paymentSig = getHeader(req, 'PAYMENT-SIGNATURE');
  if (!paymentSig) return challenge402(req, res, cfg);

  const payload = parseB64Json(paymentSig);
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'INVALID_PAYMENT_SIGNATURE' });
  }

  const idem = checkIdempotencyHit(paymentSig, cfg);
  if (idem?.record) {
    const settlement = idem.record.settlement || null;
    if (settlement) {
      res.set('payment-response', b64Json(settlement));
    }
    return res.status(200).json({
      ok: true,
      settled: true,
      idempotent: true,
      mode: idem.record.mode || 'unknown',
      settlement,
      verify: idem.record.verify || null
    });
  }

  const verifyMode = String(cfg?.reward?.x402?.verifyMode || 'mock').toLowerCase();
  const result = verifyMode === 'strict'
    ? await settleStrict(cfg, payload)
    : settleMock(cfg, payload);

  if (result?.status === 200 && result?.settlement) {
    res.set('payment-response', b64Json(result.settlement));
    storeIdempotency(paymentSig, cfg, result);
  }

  return res.status(result?.status || 500).json(result?.body || { ok: false, error: 'UNKNOWN_X402_ERROR' });
}

module.exports = {
  handleX402RewardRequest,
  buildRequirement
};
