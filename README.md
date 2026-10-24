# 🔐 Codex 认证助手 (Codex Auth Helper)

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](./extension/manifest.json)
[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Local Only](https://img.shields.io/badge/Security-100%25_Local-green.svg)](#-安全与隐私承诺)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**Codex 认证助手** 是一款专为 Codex 开发者设计的安全、轻量、高颜值的凭证管理、OAuth2 Refresh Token 续期与本地配置备份辅助 Chrome 扩展程序。

通过高度安全的本地沙盒机制，本插件能够帮助您一键将 ChatGPT 登录会话凭证或 OAuth2 刷新令牌快速安全地导出，并自动转换为完全兼容最新 Codex (`codex-rs`) 运行规范的 `auth.json` 配置文件。

---

## 🌟 核心特性

- 🔄 **双模认证与长效 Refresh Token 支持**：
  - **OAuth2 PKCE 自动获取真实 Refresh Token**：内置免本地端口监听的 OAuth2 PKCE 授权流拦截器，一键换取官方 `rt_...` 刷新令牌，让 Codex 客户端后续支持无限次后台自动续期。
  - **在线 Refresh Token 刷新与恢复**：支持直接使用或手动导入已有 `refresh_token` / `auth.json` 向 OpenAI 官方接口 (`https://auth.openai.com/oauth/token`) 刷新凭证，即使网页未登录也可一键恢复。
  - **ChatGPT Session 免验提取兜底**：直接从已登录的 `chatgpt.com` 提取会话与分片 Cookie，当 `access_token` 临近过期时自动触发保鲜刷新。
- 🧬 **深度 JWT Claims 解析与新版 Codex 规范对齐**：
  - 自动解码 `access_token` JWT 载荷中的 `https://api.openai.com/auth` 与 `https://api.openai.com/profile`，精准提取 `chatgpt_account_id`、`chatgpt_user_id`、`chatgpt_account_user_id`、`chatgpt_plan_type` 及真实 `exp` 过期时间。
  - 自动补齐新版 Codex 所需的 `oauth_provenance` 与 `login_owner_id` 字段，确保多工作区校验、MCP Connectors 与账户状态校验 100% 通过。
- ⏱️ **真实 Token 有效期倒计时**：精确读取 `access_token` JWT 的失效时间，并在 Popup 界面上提供秒级的生存期实时倒计时与临期预警。
- 🔒 **100% 纯本地离线处理**：
  - 核心逻辑基于闭环的浏览器沙盒处理，仅与 OpenAI / ChatGPT 官方接口直接通信，生成的配置支持一键下载或复制到剪贴板。
  - **绝不经过任何第三方服务器**（零第三方上传接口，数据不上云），完全打消您的隐私顾虑。

---

## 🚀 极速上手

### 1. 开发者模式安装 (本地加载)
1. 下载或克隆本仓库到您的本地电脑。
2. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/` 并回车。
3. 在右上角开启 **"开发者模式" (Developer mode)** 开关。
4. 点击左上角的 **"加载已解压的扩展程序" (Load unpacked)**。
5. 选择本仓库中的 `extension` 文件夹（即包含 `manifest.json` 的目录）。
6. 安装完成后，在浏览器工具栏的“拼图”图标中找到 **Codex 认证助手** 并将其固定。

### 2. 导出 `auth.json` 与配置自动续期
1. 确保您在当前浏览器中已经登录了 [ChatGPT 官网](https://chatgpt.com/)（或准备好了已有的 `refresh_token`）。
2. 点击浏览器右上角的插件图标，打开 **Codex 认证助手** 弹窗。
3. 如需让 Codex 具备长期自动刷新能力，可展开 **“Refresh Token 自动续期配置”** 并点击 **一键 OAuth 授权获取长效 Refresh Token**（或粘贴已有 `refresh_token` 验证绑定）。
4. 点击 **导出并下载 auth.json**（或 **复制配置**），将其放置到 `~/.codex/auth.json`（Windows 为 `%USERPROFILE%\.codex\auth.json`）。
5. **排障提示**：若此前执行过 `codex login` 导致系统密钥环 (Keyring) 缓存了旧凭证，请先运行 `codex logout` 再放入 `auth.json`，或在 `~/.codex/config.toml` 中设置 `cli_auth_credentials_store = "file"`。

## 🔒 安全与隐私承诺

> [!IMPORTANT]
> 您的身份凭证与 Session 属于极度敏感的用户隐私，**绝对不能泄露或上传到任何第三方服务器**！

- **零敏感数据收集**：本插件绝不向任何第三方收集、上传或转发任何个人隐私及凭证。
- **最小化权限声明**：仅声明 `downloads`（保存文件）、`cookies` & `storage`（本地读取会话与可选缓存刷新令牌）、`tabs`（拦截本地 OAuth 回调）以及官方域名 `https://chatgpt.com/*` 与 `https://auth.openai.com/*`。
- **彻底的代码闭环**：您可以随时通过浏览器开发者工具 (F12) 检查 `background.js` 和 `popup.js`。没有引入任何外部不可控 CDN 第三方库，所有静态资源均本地打包。

---

## 📜 许可证

本项目基于 [MIT License](LICENSE) 开源，允许任何个人或团队进行自由修改与二次分发，但请务必保留原作者署名及开源协议声明。
