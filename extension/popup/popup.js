// popup.js — Codex 认证助手核心交互与凭证合成逻辑
// 遵循纯本地沙盒处理原则，支持真实 OAuth2 Refresh Token 刷新与 ChatGPT Session 双模提取

const OPENAI_ISSUER = 'https://auth.openai.com';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// 内联 SVG 默认头像，避免离线或网络受限时外部图片加载失败裂图
const DEFAULT_AVATAR_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="none">' +
      '<rect width="96" height="96" rx="48" fill="#0d1f18"/>' +
      '<circle cx="48" cy="36" r="16" stroke="#10b981" stroke-width="4" fill="#132e23"/>' +
      '<path d="M20 80c4-15 16-24 28-24s24 9 28 24" stroke="#10b981" stroke-width="4" stroke-linecap="round" fill="#132e23"/>' +
    '</svg>'
  );

let globalSession = null;
let countdownInterval = null;
let toastTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initSessionFetch(false);
  bindEvents();
});

/**
 * 初始化或刷新 Session 获取
 * @param {boolean} forceRefresh 是否强制刷新
 */
function initSessionFetch(forceRefresh = false) {
  showState('loading');

  chrome.runtime.sendMessage({ action: 'fetch_session', forceRefresh }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('通信错误:', chrome.runtime.lastError);
      showState('unauthorized');
      return;
    }

    if (response && response.success && response.data) {
      globalSession = response.data;
      renderAuthorizedState(response.data);
      showState('authorized');
    } else {
      showState('unauthorized');
    }
  });
}

/**
 * 切换界面显示状态
 * @param {'loading'|'unauthorized'|'authorized'} state
 */
function showState(state) {
  const loadingEl = document.getElementById('state-loading');
  const unauthorizedEl = document.getElementById('state-unauthorized');
  const authorizedEl = document.getElementById('state-authorized');

  loadingEl.classList.remove('active');
  unauthorizedEl.classList.remove('active');
  authorizedEl.classList.remove('active');

  if (state === 'loading') {
    loadingEl.classList.add('active');
  } else if (state === 'unauthorized') {
    unauthorizedEl.classList.add('active');
  } else if (state === 'authorized') {
    authorizedEl.classList.add('active');
  }
}

/**
 * 渲染已登录状态的 UI 数据
 */
function renderAuthorizedState(session) {
  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const planEl = document.getElementById('badge-plan');
  const rtBadgeEl = document.getElementById('rt-status-badge');
  const refreshBtnTextEl = document.getElementById('btn-refresh-text');
  const expiresEl = document.getElementById('token-expires');

  const identity = extractIdentityFromSession(session);

  // 用户个人信息与离线安全头像兜底
  const user = session.user || {};
  avatarEl.onerror = () => {
    avatarEl.onerror = null;
    avatarEl.src = DEFAULT_AVATAR_DATA_URI;
  };
  avatarEl.src = user.image || user.picture || DEFAULT_AVATAR_DATA_URI;
  nameEl.textContent = user.name || identity.email?.split('@')[0] || 'ChatGPT 用户';
  emailEl.textContent = identity.email || '未绑定邮箱';

  // 账户套餐显示（支持 Free / Plus / Pro / Team / Enterprise / Edu）
  const planUpper = (identity.planType || 'free').toUpperCase();
  planEl.textContent = planUpper;

  if (['PLUS', 'PRO', 'TEAM', 'ENTERPRISE', 'EDU', 'PROMAX', 'PROLITE'].includes(planUpper)) {
    planEl.className = 'plan-badge plus';
  } else {
    planEl.className = 'plan-badge free';
  }

  // Refresh Token 状态显示
  const hasRealRt = Boolean(session.hasRealOAuthRefreshToken);
  if (hasRealRt) {
    rtBadgeEl.textContent = 'OAuth 长效可续期';
    rtBadgeEl.className = 'detail-value text-glow-green';
    if (refreshBtnTextEl) refreshBtnTextEl.textContent = 'OAuth 刷新';
  } else {
    rtBadgeEl.textContent = 'Session 模式 (可升级)';
    rtBadgeEl.className = 'detail-value text-warning';
    if (refreshBtnTextEl) refreshBtnTextEl.textContent = '刷新会话';
  }

  // 优先展示 access_token 的真实 JWT 过期时间（Codex 实际校验的过期时间），若无则回退至 session.expires
  const expiresIso =
    session.accessTokenExpires ||
    (identity.accessExpSec ? new Date(identity.accessExpSec * 1000).toISOString() : null) ||
    session.expires;
  const expiresTime = expiresIso ? new Date(expiresIso) : null;

  if (expiresTime && !Number.isNaN(expiresTime.getTime())) {
    expiresEl.textContent = formatLocalDate(expiresTime);
    startCountdown(expiresTime);
  } else {
    expiresEl.textContent = '长期有效';
    const countdownEl = document.getElementById('token-countdown');
    countdownEl.textContent = '无限';
    countdownEl.className = 'detail-value text-glow-green';
  }
}

/**
 * 绑定所有 DOM 按钮事件
 */
function bindEvents() {
  // 0. 顶部重新检测按钮
  const reloadBtn = document.getElementById('btn-reload-session');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      initSessionFetch(true);
    });
  }

  // 1. 未登录一键跳转 ChatGPT
  document.getElementById('btn-login').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com/' });
    window.close();
  });

  // 2. 导出并下载 auth.json
  document.getElementById('btn-download').addEventListener('click', () => {
    if (!globalSession) return;
    const authJsonString = generateCodexAuthJson(globalSession);

    chrome.runtime.sendMessage(
      {
        action: 'download_auth_json',
        jsonContent: authJsonString
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          console.error('下载通信异常:', chrome.runtime.lastError || response?.error);
          showToast('❌ 下载失败，请尝试点击“复制配置”');
          return;
        }
        showToast('🎉 auth.json 已开始下载');
      }
    );
  });

  // 3. 一键复制 auth.json 配置到剪贴板
  const copyBtn = document.getElementById('btn-copy-json');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (!globalSession) return;
      const authJsonString = generateCodexAuthJson(globalSession);
      copyToClipboard(authJsonString, '✅ 已复制 auth.json 配置到剪贴板');
    });
  }

  // 4. 立即刷新令牌（支持 OAuth Refresh Token 刷新与 Session 刷新）
  const refreshBtn = document.getElementById('btn-refresh-token');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (!globalSession) return;

      if (globalSession.hasRealOAuthRefreshToken) {
        showToast('⏳ 正在通过 Refresh Token 刷新凭证...');
        chrome.runtime.sendMessage(
          {
            action: 'refresh_oauth_token',
            accountKey: globalSession.accountKey
          },
          (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              const errMsg = response?.error || chrome.runtime.lastError?.message || '刷新失败';
              showToast(`❌ ${errMsg}`);
              return;
            }
            globalSession = response.data;
            renderAuthorizedState(globalSession);
            showToast('🎉 OAuth 令牌刷新成功！');
          }
        );
      } else {
        showToast('⏳ 正在刷新网页会话凭证...');
        chrome.runtime.sendMessage({ action: 'fetch_session', forceRefresh: true }, (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            showToast('❌ 会话刷新失败，请确认网页已登录');
            return;
          }
          globalSession = response.data;
          renderAuthorizedState(globalSession);
          showToast('✅ 会话状态已同步更新');
        });
      }
    });
  }

  // 5. 启动 OAuth2 PKCE 流程获取真实长效 Refresh Token
  const triggerOAuthPkce = () => {
    showToast('⏳ 正在打开 OpenAI OAuth 授权，完成后将自动保存...');
    chrome.runtime.sendMessage({ action: 'start_oauth_pkce', autoDownload: true }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        showToast('❌ 无法启动 OAuth 授权流');
        return;
      }
      setTimeout(() => window.close(), 600);
    });
  };

  const oauthPkceBtn = document.getElementById('btn-oauth-pkce');
  if (oauthPkceBtn) oauthPkceBtn.addEventListener('click', triggerOAuthPkce);

  const unauthOauthBtn = document.getElementById('btn-unauth-oauth');
  if (unauthOauthBtn) unauthOauthBtn.addEventListener('click', triggerOAuthPkce);

  // 6. 手动粘贴 Refresh Token 或 auth.json 验证并绑定
  const handleManualRtSubmit = (inputId) => {
    const inputEl = document.getElementById(inputId);
    const val = inputEl ? inputEl.value.trim() : '';
    if (!val) {
      showToast('⚠️ 请先粘贴有效的 refresh_token 或 auth.json');
      return;
    }

    showToast('⏳ 正在向 OpenAI 验证并刷新令牌...');
    chrome.runtime.sendMessage(
      {
        action: 'refresh_oauth_token',
        refreshToken: val,
        accountKey: globalSession?.accountKey
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          const errMsg = response?.error || chrome.runtime.lastError?.message || '验证失败';
          showToast(`❌ ${errMsg}`);
          return;
        }
        if (inputEl) inputEl.value = '';
        globalSession = response.data;
        renderAuthorizedState(globalSession);
        showState('authorized');
        showToast('🎉 Refresh Token 验证并刷新成功！');
      }
    );
  };

  const applyManualRtBtn = document.getElementById('btn-apply-manual-rt');
  if (applyManualRtBtn) {
    applyManualRtBtn.addEventListener('click', () => handleManualRtSubmit('input-manual-rt'));
  }

  const unauthApplyRtBtn = document.getElementById('btn-unauth-apply-rt');
  if (unauthApplyRtBtn) {
    unauthApplyRtBtn.addEventListener('click', () => handleManualRtSubmit('input-unauth-rt'));
  }

  // 7. 清除本地缓存的 OAuth 凭证
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'clear_stored_oauth' }, () => {
        showToast('🧹 已清除本地缓存的刷新令牌');
        initSessionFetch(false);
      });
    });
  }
}

/**
 * 实时计算并更新剩余过期时间倒计时
 */
function startCountdown(expiresTime) {
  if (countdownInterval) clearInterval(countdownInterval);

  const countdownEl = document.getElementById('token-countdown');

  function update() {
    const now = new Date();
    const diff = expiresTime - now;

    if (diff <= 0) {
      countdownEl.textContent = '已过期 (请点击刷新)';
      countdownEl.className = 'detail-value text-danger';
      clearInterval(countdownInterval);
      return;
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    let displayStr = '';
    if (days > 0) displayStr += `${days}天`;
    if (hours > 0 || days > 0) displayStr += `${hours}时`;
    displayStr += `${minutes}分${seconds}秒`;

    countdownEl.textContent = displayStr;

    // 剩余不足 15 分钟时高亮预警（Codex 会在剩余 5 分钟时触发主动刷新）
    if (diff <= 15 * 60 * 1000) {
      countdownEl.className = 'detail-value text-warning';
    } else {
      countdownEl.className = 'detail-value text-glow-green';
    }
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

/**
 * 格式化输出本地化的年月日 时分
 */
function formatLocalDate(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 标准 UTF-8 安全的 Base64Url 编解码工具
 */
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

function parseJwtClaims(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  try {
    return JSON.parse(base64UrlDecodeString(parts[1]));
  } catch {
    return null;
  }
}

function generateRandomBase64Url(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

/**
 * 从 session 及其内嵌的 accessToken / idToken JWT 中提取精准的认证声明
 * 解决原版仅依赖 session.account 导致 account_id 为空或 planType 误判为 free 的问题
 */
function extractIdentityFromSession(session) {
  const accessClaims = parseJwtClaims(session?.accessToken) || {};
  const idClaims = parseJwtClaims(session?.idToken) || {};

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
    session?.account?.id ||
    '';

  const userId =
    authClaims.chatgpt_user_id ||
    authClaims.user_id ||
    session?.user?.id ||
    '';

  const accountUserId =
    authClaims.chatgpt_account_user_id ||
    session?.account?.accountUserId ||
    '';

  const planType = String(
    authClaims.chatgpt_plan_type ||
    session?.account?.planType ||
    'free'
  ).toLowerCase();

  const isFedramp = Boolean(
    authClaims.chatgpt_account_is_fedramp ?? session?.account?.isFedramp
  );

  const email =
    idClaims.email ||
    profileClaims.email ||
    accessClaims.email ||
    session?.user?.email ||
    '';

  return {
    accountId,
    userId,
    accountUserId,
    planType,
    isFedramp,
    email,
    accessExpSec: accessClaims.exp || null,
    idExpSec: idClaims.exp || null,
    iss: accessClaims.iss || idClaims.iss || 'https://auth.openai.com/',
    sub: accessClaims.sub || idClaims.sub || (userId ? `auth0|${userId}` : ''),
    aud: accessClaims.aud || idClaims.aud || CODEX_CLIENT_ID
  };
}

/**
 * 核心转换逻辑：将获取到的 ChatGPT Session / OAuth 数据转化为符合最新 Codex (codex-rs) 要求的格式
 *
 * 关键优化点：
 * 1. 自动解码 access_token JWT Payload 提取真实的 chatgpt_account_id、chatgpt_user_id、chatgpt_plan_type，
 *    确保 tokens.account_id 与 access_token 内部声明严格一致（通过 parse_chatgpt_account_user_id 校验）。
 * 2. 若已获取真实 OAuth id_token 与 refresh_token，优先输出官方原生签名令牌。
 * 3. 补齐新版 Codex 所需的 oauth_provenance 与 login_owner_id 字段，确保 account_login_is_current 校验通过。
 */
function generateCodexAuthJson(session) {
  const identity = extractIdentityFromSession(session);
  const iat = Math.floor(Date.now() / 1000);
  const sessionExpSec = session.expires ? Math.floor(new Date(session.expires).getTime() / 1000) : null;
  const exp = identity.accessExpSec || sessionExpSec || (iat + 30 * 24 * 3600);

  // 如果已有真实的 OpenAI 签名 id_token 且包含匹配的 account_id，优先使用真实 id_token
  let finalIdToken = '';
  if (session.idToken && parseJwtClaims(session.idToken)) {
    const existingIdClaims = parseJwtClaims(session.idToken);
    const idAccId = existingIdClaims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!identity.accountId || idAccId === identity.accountId) {
      finalIdToken = session.idToken;
    }
  }

  if (!finalIdToken) {
    // 构建对齐 codex-rs IdClaims 结构的 Synthetic id_token (无签名 JWT)
    const jwtHeader = { alg: 'none', typ: 'JWT', cpa_synthetic: true };
    const jwtPayload = {
      iss: identity.iss,
      sub: identity.sub,
      aud: identity.aud,
      iat,
      exp,
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
        chatgpt_account_is_fedramp: identity.isFedramp
      }
    };
    finalIdToken = `${base64UrlEncodeObject(jwtHeader)}.${base64UrlEncodeObject(jwtPayload)}.synthetic`;
  }

  const finalRefreshToken =
    session.refreshToken ||
    session.sessionToken ||
    'session_based_no_oauth_rt';

  const authConfig = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: finalIdToken,
      access_token: session.accessToken,
      refresh_token: finalRefreshToken,
      oauth_provenance: {
        issuer: OPENAI_ISSUER,
        client_id: CODEX_CLIENT_ID
      },
      login_owner_id: session.loginOwnerId || generateRandomBase64Url(32),
      account_id: identity.accountId || null
    },
    last_refresh: session.lastRefresh || new Date().toISOString()
  };

  return JSON.stringify(authConfig, null, 2);
}

/**
 * 一键复制公共方法
 */
function copyToClipboard(text, successMsg) {
  navigator.clipboard.writeText(text)
    .then(() => {
      showToast(successMsg);
    })
    .catch(err => {
      console.error('复制失败:', err);
      showToast('❌ 复制失败，请尝试下载文件');
    });
}

/**
 * 弹出精致轻巧的 Toast 反馈
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');

  if (toastTimer) clearTimeout(toastTimer);
  toastMsg.textContent = message;
  toast.classList.add('show');

  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2600);
}
