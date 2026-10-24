// background.js — Service Worker 异步获取 Session 数据 + OAuth2 Refresh Token 引擎 + 文件下载
// 符合 Manifest V3 最佳实践，所有中间状态持久化于 chrome.storage.local，避免全局状态丢失

const OPENAI_ISSUER = 'https://auth.openai.com';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const OAUTH_AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`;
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

// 提前 5 分钟触发主动刷新（对齐 codex-rs CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5）
const PROACTIVE_REFRESH_WINDOW_SEC = 5 * 60;

const STORAGE_KEY_OAUTH_STORE = 'codex_oauth_credentials_v1';
const STORAGE_KEY_PENDING_PKCE = 'codex_pending_oauth_pkce_v1';

// ==========================================
// 1. 消息通信路由
// ==========================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetch_session') {
    fetchChatGPTSession({ forceRefresh: Boolean(message.forceRefresh) })
      .then(sessionData => {
        sendResponse({ success: true, data: sessionData });
      })
      .catch(error => {
        console.error('获取 ChatGPT Session 失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'refresh_oauth_token') {
    handleManualOrStoredRefresh(message.refreshToken, message.accountKey)
      .then(result => {
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('刷新 OAuth Token 失败:', error);
        sendResponse({ success: false, error: error.message, code: error.code || 'UNKNOWN' });
      });
    return true;
  }

  if (message.action === 'start_oauth_pkce') {
    startOAuthPkceFlow({ autoDownload: Boolean(message.autoDownload) })
      .then(result => {
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('启动 OAuth PKCE 流程失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'clear_stored_oauth') {
    clearStoredOAuthCredentials(message.accountKey)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'download_auth_json') {
    downloadJsonFile(message.jsonContent, message.filename || 'auth.json')
      .then(downloadId => {
        sendResponse({ success: true, downloadId });
      })
      .catch(error => {
        console.error('下载异常:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// ==========================================
// 2. 监听 OAuth PKCE 回调 URL (免本地 1455 端口服务器)
// ==========================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const targetUrl = changeInfo.url || tab?.url || '';
  if (
    targetUrl.startsWith('http://localhost:1455/auth/callback') ||
    targetUrl.startsWith('http://127.0.0.1:1455/auth/callback')
  ) {
    handleOAuthCallbackTab(tabId, targetUrl).catch(err => {
      console.error('处理 OAuth 回调标签页异常:', err);
    });
  }
});

/**
 * 拦截并处理跳转到 localhost:1455/auth/callback 的授权码
 */
async function handleOAuthCallbackTab(tabId, callbackUrlStr) {
  const storageData = await chrome.storage.local.get([STORAGE_KEY_PENDING_PKCE]);
  const pending = storageData[STORAGE_KEY_PENDING_PKCE];
  if (!pending || !pending.codeVerifier || !pending.state) {
    return;
  }

  // 防止重复触发，先移除 pending 记录
  await chrome.storage.local.remove([STORAGE_KEY_PENDING_PKCE]);

  let parsedUrl;
  try {
    parsedUrl = new URL(callbackUrlStr);
  } catch {
    return;
  }

  const code = parsedUrl.searchParams.get('code');
  let callbackState = parsedUrl.searchParams.get('state') || '';
  const error = parsedUrl.searchParams.get('error');
  const errorDesc = parsedUrl.searchParams.get('error_description');

  // 对齐 codex-rs server.rs:370 处理可能的 suffix
  const lifeSciencesSuffix = ':life_sciences';
  if (callbackState.endsWith(lifeSciencesSuffix) && callbackState.slice(0, -lifeSciencesSuffix.length) === pending.state) {
    callbackState = pending.state;
  }

  // 关闭临时回调标签页
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 忽略标签页已关闭的错误
  }

  if (error) {
    console.error('OAuth 授权返回错误:', error, errorDesc);
    return;
  }

  if (!code || callbackState !== pending.state) {
    console.error('OAuth 回调 state 不匹配或缺少 code');
    return;
  }

  // 使用授权码换取真实的 id_token, access_token, refresh_token
  const exchanged = await exchangeCodeForTokens(
    code,
    pending.codeVerifier,
    pending.redirectUri || OAUTH_REDIRECT_URI
  );

  const savedRecord = await saveOAuthTokensToStore(exchanged);

  // 如果用户设置了授权完成后自动下载最新的 auth.json
  if (pending.autoDownload && savedRecord) {
    const authJsonStr = buildStandardAuthJsonFromOAuthRecord(savedRecord);
    await downloadJsonFile(authJsonStr, 'auth.json');
  }
}

// ==========================================
// 3. Base64Url / JWT / PKCE 工具函数
// ==========================================
function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlEncodeObject(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return base64UrlEncodeBytes(bytes);
}

function base64UrlDecodeString(b64Url) {
  if (!b64Url || typeof b64Url !== 'string') return '';
  let b64 = b64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 解析 JWT Payload（对齐 codex-rs/login/src/token_data.rs）
 */
function parseJwtClaims(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  try {
    const jsonStr = base64UrlDecodeString(parts[1]);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * 从 JWT (access_token 或 id_token) 与 Session 对象中提取完整的标准化账户身份信息
 */
function extractAccountIdentity(jwtToken, idToken, rawSession = {}) {
  const accessClaims = parseJwtClaims(jwtToken) || {};
  const idClaims = parseJwtClaims(idToken) || {};

  const authClaims = {
    ...(accessClaims['https://api.openai.com/auth'] || {}),
    ...(idClaims['https://api.openai.com/auth'] || {})
  };
  const profileClaims = {
    ...(accessClaims['https://api.openai.com/profile'] || {}),
    ...(idClaims['https://api.openai.com/profile'] || {})
  };

  const accountId =
    authClaims.chatgpt_account_id ||
    rawSession.account?.id ||
    '';

  const userId =
    authClaims.chatgpt_user_id ||
    authClaims.user_id ||
    rawSession.user?.id ||
    '';

  const accountUserId = authClaims.chatgpt_account_user_id || '';

  const rawPlan =
    authClaims.chatgpt_plan_type ||
    rawSession.account?.planType ||
    'free';
  const planType = String(rawPlan).toLowerCase();

  const isFedramp = Boolean(authClaims.chatgpt_account_is_fedramp);

  const email =
    idClaims.email ||
    profileClaims.email ||
    accessClaims.email ||
    rawSession.user?.email ||
    '';

  const accessExpSec = accessClaims.exp || null;
  const idExpSec = idClaims.exp || null;

  return {
    accountId,
    userId,
    accountUserId,
    planType,
    isFedramp,
    email,
    accessExpSec,
    idExpSec,
    iss: accessClaims.iss || idClaims.iss || 'https://auth.openai.com/',
    sub: accessClaims.sub || idClaims.sub || (userId ? `auth0|${userId}` : ''),
    aud: accessClaims.aud || idClaims.aud || CODEX_CLIENT_ID
  };
}

function generateRandomBase64Url(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

/**
 * 生成符合 codex-rs/login/src/oauth/pkce.rs 规范的 PKCE 参数
 */
async function generatePkceCodes() {
  const codeVerifier = generateRandomBase64Url(64);
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  const codeChallenge = base64UrlEncodeBytes(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

// ==========================================
// 4. Cookie 提取与本地存储管理
// ==========================================
/**
 * 提取 ChatGPT 的 NextAuth Session Cookie（支持分片 Cookie 自动拼接）
 */
async function getChatGPTSessionCookie() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com/' });
    if (!cookies || cookies.length === 0) return '';

    const exactNames = [
      '__Secure-next-auth.session-token',
      '__Host-next-auth.session-token',
      'next-auth.session-token'
    ];

    for (const baseName of exactNames) {
      const exactMatch = cookies.find(c => c.name === baseName && c.value);
      if (exactMatch) {
        return exactMatch.value;
      }

      // 检查分片 Cookie（如 __Secure-next-auth.session-token.0, .1, ...）
      const chunks = cookies
        .filter(c => c.name.startsWith(`${baseName}.`))
        .map(c => {
          const suffix = c.name.slice(baseName.length + 1);
          const idx = /^\d+$/.test(suffix) ? parseInt(suffix, 10) : NaN;
          return { idx, value: c.value };
        })
        .filter(item => !Number.isNaN(item.idx))
        .sort((a, b) => a.idx - b.idx);

      if (chunks.length > 0) {
        return chunks.map(c => c.value).join('');
      }
    }
    return '';
  } catch (err) {
    console.warn('读取 ChatGPT Cookie 失败:', err);
    return '';
  }
}

async function loadOAuthStore() {
  const data = await chrome.storage.local.get([STORAGE_KEY_OAUTH_STORE]);
  return data[STORAGE_KEY_OAUTH_STORE] || { accounts: {}, latestKey: null };
}

async function saveOAuthTokensToStore({
  idToken,
  accessToken,
  refreshToken,
  loginOwnerId,
  rawSession
}) {
  const store = await loadOAuthStore();
  const identity = extractAccountIdentity(accessToken, idToken, rawSession);
  const accountKey = identity.accountId || identity.userId || identity.email || 'default';

  const existing = store.accounts[accountKey] || {};
  const finalRefreshToken = refreshToken || existing.refreshToken || '';
  const finalIdToken = idToken || existing.idToken || '';
  const finalAccessToken = accessToken || existing.accessToken || '';
  const finalLoginOwnerId = loginOwnerId || existing.loginOwnerId || generateRandomBase64Url(32);

  const record = {
    accountKey,
    accountId: identity.accountId || existing.accountId || '',
    userId: identity.userId || existing.userId || '',
    accountUserId: identity.accountUserId || existing.accountUserId || '',
    email: identity.email || existing.email || '',
    planType: identity.planType || existing.planType || 'free',
    isFedramp: identity.isFedramp ?? existing.isFedramp ?? false,
    idToken: finalIdToken,
    accessToken: finalAccessToken,
    refreshToken: finalRefreshToken,
    hasRealOAuthRefreshToken: Boolean(finalRefreshToken && !finalRefreshToken.includes('.')),
    loginOwnerId: finalLoginOwnerId,
    oauthProvenance: {
      issuer: OPENAI_ISSUER,
      client_id: CODEX_CLIENT_ID
    },
    lastRefresh: new Date().toISOString()
  };

  store.accounts[accountKey] = record;
  store.latestKey = accountKey;
  await chrome.storage.local.set({ [STORAGE_KEY_OAUTH_STORE]: store });
  return record;
}

async function clearStoredOAuthCredentials(accountKey) {
  const store = await loadOAuthStore();
  if (accountKey && store.accounts[accountKey]) {
    delete store.accounts[accountKey];
    if (store.latestKey === accountKey) {
      store.latestKey = Object.keys(store.accounts)[0] || null;
    }
    await chrome.storage.local.set({ [STORAGE_KEY_OAUTH_STORE]: store });
  } else {
    await chrome.storage.local.remove([STORAGE_KEY_OAUTH_STORE]);
  }
}

// ==========================================
// 5. OAuth2 Token Refresh & Code Exchange
// ==========================================
/**
 * 向 https://auth.openai.com/oauth/token 发起标准 OAuth2 Refresh Token 请求
 * 完全对齐 codex-rs/login/src/auth/manager.rs:request_chatgpt_token_refresh
 */
async function requestChatGPTTokenRefresh(refreshToken, refreshReason = 'forced') {
  if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
    const err = new Error('Refresh Token 不能为空');
    err.code = 'EMPTY_TOKEN';
    throw err;
  }

  const trimmedToken = refreshToken.trim();

  // 如果传入的是三段式 JWT（如网页 Session Cookie 或 access_token），提示用户它不是 OAuth2 refresh_token
  if (trimmedToken.split('.').length === 3 && trimmedToken.startsWith('eyJ')) {
    const err = new Error('当前令牌为网页 JWT Session Cookie，而非 OAuth2 Refresh Token。请点击“获取 OAuth 刷新令牌”或粘贴有效的 rt_ 刷新令牌。');
    err.code = 'NOT_OAUTH_REFRESH_TOKEN';
    throw err;
  }

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: trimmedToken,
      refresh_reason: refreshReason
    })
  });

  if (!response.ok) {
    let errorBody = {};
    try {
      errorBody = await response.json();
    } catch {
      // ignore json parse error
    }
    const rawCode = errorBody?.error?.code || errorBody?.error || errorBody?.code || '';
    const normalizedCode = String(rawCode).toLowerCase();

    let message = `刷新 Token 失败 (HTTP ${response.status})`;
    if (normalizedCode === 'refresh_token_expired') {
      message = 'Refresh Token 已过期，请重新执行 OAuth 授权或登录。';
    } else if (normalizedCode === 'refresh_token_reused') {
      message = 'Refresh Token 已被单次轮转消费过（可能被其他 Codex 实例刷新），请导出最新凭证或重新授权。';
    } else if (normalizedCode === 'refresh_token_invalidated') {
      message = 'Refresh Token 已被吊销，请重新登录授权。';
    } else if (normalizedCode === 'invalid_grant') {
      message = '无效的 Refresh Token (invalid_grant)，请确认输入的是否为有效的 OpenAI OAuth 刷新令牌。';
    } else if (errorBody?.error_description) {
      message = `刷新失败: ${errorBody.error_description}`;
    }

    const err = new Error(message);
    err.code = normalizedCode || `HTTP_${response.status}`;
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  if (!data || !data.access_token) {
    const err = new Error('OAuth 刷新响应缺少 access_token');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  return {
    idToken: data.id_token || null,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || trimmedToken
  };
}

/**
 * 手动或使用已保存的 Refresh Token 刷新并持久化
 */
async function handleManualOrStoredRefresh(inputRefreshToken, accountKey) {
  const store = await loadOAuthStore();
  const targetRecord =
    (accountKey && store.accounts[accountKey]) ||
    (store.latestKey && store.accounts[store.latestKey]) ||
    null;

  let tokenToUse = inputRefreshToken ? inputRefreshToken.trim() : '';

  // 支持用户直接粘贴整个 auth.json 内容
  if (tokenToUse.startsWith('{')) {
    try {
      const parsed = JSON.parse(tokenToUse);
      tokenToUse = parsed?.tokens?.refresh_token || parsed?.refresh_token || '';
    } catch {
      throw new Error('解析粘贴的 JSON 失败，请粘贴有效的 auth.json 或 refresh_token 字符串');
    }
  }

  if (!tokenToUse && targetRecord?.refreshToken) {
    tokenToUse = targetRecord.refreshToken;
  }

  if (!tokenToUse) {
    throw new Error('未找到可用的 Refresh Token，请先点击“OAuth 授权获取”或手动输入');
  }

  const refreshed = await requestChatGPTTokenRefresh(tokenToUse, 'forced');
  const savedRecord = await saveOAuthTokensToStore({
    idToken: refreshed.idToken || targetRecord?.idToken,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    loginOwnerId: targetRecord?.loginOwnerId
  });

  // 刷新成功后同步构造融合后的 session 视图供前端直接渲染
  return buildSessionViewFromOAuthRecord(savedRecord);
}

/**
 * 使用 OAuth2 授权码 + PKCE code_verifier 换取真实的 id_token, access_token, refresh_token
 * 对齐 codex-rs/login/src/oauth/client.rs:exchange_code
 */
async function exchangeCodeForTokens(code, codeVerifier, redirectUri = OAUTH_REDIRECT_URI) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OAuth 令牌交换失败 (HTTP ${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  if (!data || !data.access_token || !data.refresh_token) {
    throw new Error('OAuth 令牌交换响应不完整');
  }

  return {
    idToken: data.id_token || '',
    accessToken: data.access_token,
    refreshToken: data.refresh_token
  };
}

/**
 * 启动 OAuth2 PKCE 授权流（优先尝试后台静默完成，若需交互则打开标签页并自动拦截回调）
 */
async function startOAuthPkceFlow({ autoDownload = false } = {}) {
  const { codeVerifier, codeChallenge } = await generatePkceCodes();
  const state = generateRandomBase64Url(32);

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs'
  });

  const authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

  // 持久化 PKCE 状态，以便 tabs.onUpdated 在任何时刻捕获回调
  await chrome.storage.local.set({
    [STORAGE_KEY_PENDING_PKCE]: {
      codeVerifier,
      state,
      redirectUri: OAUTH_REDIRECT_URI,
      autoDownload,
      createdAt: Date.now()
    }
  });

  // 打开授权标签页，完成后会由 chrome.tabs.onUpdated 自动拦截 localhost:1455/auth/callback 并关闭标签页
  await chrome.tabs.create({ url: authorizeUrl, active: true });
  return { mode: 'tab_opened', authorizeUrl };
}

// ==========================================
// 6. 获取并融合 ChatGPT Session 与 OAuth 状态
// ==========================================
async function fetchRawChatGPTSession(bustCache = false) {
  const url = bustCache
    ? `https://chatgpt.com/api/auth/session?_t=${Date.now()}`
    : 'https://chatgpt.com/api/auth/session';

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Accept': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    }
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP 异常，状态码: ${response.status}`);
  }

  const data = await response.json();
  if (!data || !data.accessToken) {
    return null;
  }

  return data;
}

function buildSessionViewFromOAuthRecord(record, baseSession = {}) {
  const identity = extractAccountIdentity(record.accessToken, record.idToken, baseSession);
  const expMs = identity.accessExpSec
    ? identity.accessExpSec * 1000
    : (baseSession.expires ? new Date(baseSession.expires).getTime() : Date.now() + 3600 * 1000);

  return {
    ...baseSession,
    accessToken: record.accessToken,
    idToken: record.idToken || '',
    refreshToken: record.refreshToken || '',
    sessionToken: baseSession.sessionToken || '',
    hasRealOAuthRefreshToken: Boolean(record.hasRealOAuthRefreshToken),
    loginOwnerId: record.loginOwnerId || generateRandomBase64Url(32),
    lastRefresh: record.lastRefresh || new Date().toISOString(),
    accountKey: record.accountKey,
    expires: baseSession.expires || new Date(expMs).toISOString(),
    accessTokenExpires: identity.accessExpSec ? new Date(identity.accessExpSec * 1000).toISOString() : null,
    user: {
      ...(baseSession.user || {}),
      id: identity.userId || baseSession.user?.id || '',
      email: identity.email || baseSession.user?.email || '',
      name: baseSession.user?.name || identity.email?.split('@')[0] || 'ChatGPT 用户',
      image: baseSession.user?.image || baseSession.user?.picture || ''
    },
    account: {
      ...(baseSession.account || {}),
      id: identity.accountId || baseSession.account?.id || '',
      planType: identity.planType || baseSession.account?.planType || 'free',
      accountUserId: identity.accountUserId || '',
      isFedramp: identity.isFedramp
    }
  };
}

/**
 * 综合获取当前会话状态：
 * 1. 请求 https://chatgpt.com/api/auth/session（显式携带 credentials: 'include'）
 * 2. 若 accessToken 临近过期则自动触发服务端刷新
 * 3. 提取浏览器 Cookie 中的 __Secure-next-auth.session-token
 * 4. 关联本地存储的真实 OAuth2 refresh_token，若 accessToken 即将过期则自动调用 OAuth 刷新
 * 5. 若网页未登录但本地存有有效 OAuth refresh_token，自动通过 refresh_token 恢复会话
 */
async function fetchChatGPTSession({ forceRefresh = false } = {}) {
  let session = null;
  try {
    session = await fetchRawChatGPTSession(forceRefresh);
  } catch (err) {
    console.warn('首次请求 ChatGPT session 遇到网络/状态异常:', err);
  }

  // 如果获取到了网页 session，检查其 accessToken 是否即将过期（10分钟内），若是则强制加时间戳重刷一次
  if (session && session.accessToken && !forceRefresh) {
    const claims = parseJwtClaims(session.accessToken);
    const nowSec = Math.floor(Date.now() / 1000);
    if (claims?.exp && claims.exp - nowSec <= 600) {
      try {
        const refreshedSession = await fetchRawChatGPTSession(true);
        if (refreshedSession?.accessToken) {
          session = refreshedSession;
        }
      } catch {
        // 保留原 session
      }
    }
  }

  const cookieSessionToken = await getChatGPTSessionCookie();
  const store = await loadOAuthStore();

  // 情况 A：网页已登录 ChatGPT
  if (session && session.accessToken) {
    const identity = extractAccountIdentity(session.accessToken, null, session);
    const accountKey = identity.accountId || identity.userId || identity.email || 'default';
    let oauthRecord =
      store.accounts[accountKey] ||
      Object.values(store.accounts).find(
        r =>
          (identity.accountId && r.accountId === identity.accountId) ||
          (identity.userId && r.userId === identity.userId) ||
          (identity.email && r.email === identity.email)
      ) ||
      null;

    session.sessionToken = session.sessionToken || cookieSessionToken || '';

    // 如果本地已有该账号绑定的真实 OAuth refresh_token
    if (oauthRecord && oauthRecord.hasRealOAuthRefreshToken && oauthRecord.refreshToken) {
      const oauthClaims = parseJwtClaims(oauthRecord.accessToken);
      const nowSec = Math.floor(Date.now() / 1000);
      const oauthAccessValid = oauthClaims?.exp && oauthClaims.exp - nowSec > PROACTIVE_REFRESH_WINDOW_SEC;

      if (forceRefresh || !oauthAccessValid) {
        try {
          const refreshed = await requestChatGPTTokenRefresh(
            oauthRecord.refreshToken,
            forceRefresh ? 'forced' : 'proactive_expiry'
          );
          oauthRecord = await saveOAuthTokensToStore({
            idToken: refreshed.idToken || oauthRecord.idToken,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            loginOwnerId: oauthRecord.loginOwnerId,
            rawSession: session
          });
        } catch (refreshErr) {
          console.warn('自动刷新 OAuth Token 失败，回退至网页 Session:', refreshErr.message);
          // 若 refresh_token 彻底失效，清理失效的 refreshToken 但保留 loginOwnerId
          if (
            refreshErr.code === 'refresh_token_expired' ||
            refreshErr.code === 'refresh_token_invalidated' ||
            refreshErr.code === 'invalid_grant'
          ) {
            await clearStoredOAuthCredentials(oauthRecord.accountKey);
            oauthRecord = null;
          }
        }
      }

      if (oauthRecord && oauthRecord.hasRealOAuthRefreshToken) {
        return buildSessionViewFromOAuthRecord(oauthRecord, session);
      }
    }

    // 网页 Session 模式：确保为该账号分配并持久化稳定的 loginOwnerId
    const existingLoginOwnerId = oauthRecord?.loginOwnerId || generateRandomBase64Url(32);
    if (!oauthRecord) {
      await saveOAuthTokensToStore({
        idToken: '',
        accessToken: session.accessToken,
        refreshToken: '',
        loginOwnerId: existingLoginOwnerId,
        rawSession: session
      });
    }

    return {
      ...session,
      accessToken: session.accessToken,
      idToken: '',
      refreshToken: session.sessionToken || '',
      sessionToken: session.sessionToken || '',
      hasRealOAuthRefreshToken: false,
      loginOwnerId: existingLoginOwnerId,
      accountKey,
      accessTokenExpires: identity.accessExpSec ? new Date(identity.accessExpSec * 1000).toISOString() : null,
      user: {
        ...(session.user || {}),
        id: identity.userId || session.user?.id || '',
        email: identity.email || session.user?.email || '',
        name: session.user?.name || identity.email?.split('@')[0] || 'ChatGPT 用户',
        image: session.user?.image || session.user?.picture || ''
      },
      account: {
        ...(session.account || {}),
        id: identity.accountId || session.account?.id || '',
        planType: identity.planType || session.account?.planType || 'free',
        accountUserId: identity.accountUserId || '',
        isFedramp: identity.isFedramp
      }
    };
  }

  // 情况 B：网页未登录或 Session 过期，但本地存储有真实 OAuth Refresh Token，尝试用 Refresh Token 直接恢复登录！
  const fallbackRecord = store.latestKey ? store.accounts[store.latestKey] : Object.values(store.accounts)[0];
  if (fallbackRecord && fallbackRecord.hasRealOAuthRefreshToken && fallbackRecord.refreshToken) {
    try {
      const refreshed = await requestChatGPTTokenRefresh(fallbackRecord.refreshToken, 'unauthorized_recovery');
      const updatedRecord = await saveOAuthTokensToStore({
        idToken: refreshed.idToken || fallbackRecord.idToken,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        loginOwnerId: fallbackRecord.loginOwnerId
      });
      return buildSessionViewFromOAuthRecord(updatedRecord);
    } catch (err) {
      console.warn('尝试通过本地 OAuth Refresh Token 恢复会话失败:', err.message);
    }
  }

  throw new Error('UNAUTHORIZED');
}

// ==========================================
// 7. 构建标准 auth.json 与下载辅助
// ==========================================
function buildStandardAuthJsonFromOAuthRecord(record) {
  const identity = extractAccountIdentity(record.accessToken, record.idToken, {});
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = identity.accessExpSec || (nowSec + 30 * 24 * 3600);

  let finalIdToken = record.idToken;
  if (!finalIdToken) {
    const jwtHeader = { alg: 'none', typ: 'JWT', cpa_synthetic: true };
    const jwtPayload = {
      iss: identity.iss,
      sub: identity.sub,
      aud: identity.aud,
      iat: nowSec,
      exp: expSec,
      email: identity.email,
      'https://api.openai.com/profile': {
        email: identity.email,
        email_verified: true
      },
      'https://api.openai.com/auth': {
        chatgpt_account_id: identity.accountId,
        chatgpt_plan_type: identity.planType,
        chatgpt_user_id: identity.userId,
        user_id: identity.userId,
        ...(identity.accountUserId ? { chatgpt_account_user_id: identity.accountUserId } : {}),
        chatgpt_account_is_fedramp: Boolean(identity.isFedramp)
      }
    };
    finalIdToken = `${base64UrlEncodeObject(jwtHeader)}.${base64UrlEncodeObject(jwtPayload)}.synthetic`;
  }

  const authConfig = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: finalIdToken,
      access_token: record.accessToken,
      refresh_token: record.refreshToken || 'session_based_no_oauth_rt',
      oauth_provenance: {
        issuer: OPENAI_ISSUER,
        client_id: CODEX_CLIENT_ID
      },
      login_owner_id: record.loginOwnerId || generateRandomBase64Url(32),
      account_id: identity.accountId || null
    },
    last_refresh: record.lastRefresh || new Date().toISOString()
  };

  return JSON.stringify(authConfig, null, 2);
}

function downloadJsonFile(jsonContent, filename = 'auth.json') {
  return new Promise((resolve, reject) => {
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonContent);
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}
