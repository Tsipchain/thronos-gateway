'use strict';

const express = require('express');
const router = express.Router();

const LATEST_VERSION = process.env.LATEST_APK_VERSION || '2.0.0';
const APK_BASE_URL = process.env.APK_BASE_URL || 'https://github.com/Tsipchain/thronosbuilder/releases/latest/download';
const SDK_BASE_URL = process.env.SDK_BASE_URL || 'https://github.com/Tsipchain/thronos-v3.6/releases/latest/download';

const DOWNLOADS = [
  {
    id: 'wallet-android',
    name: 'Thronos Wallet v2',
    platform: 'Android',
    type: 'apk',
    version: LATEST_VERSION,
    filename: `thronos-wallet-v${LATEST_VERSION}.apk`,
    url: `${APK_BASE_URL}/thronos-wallet-v${LATEST_VERSION}.apk`,
    icon: '📱',
    description: 'Mobile wallet with WalletConnect v2 + import signing key',
    minAndroid: '8.0',
    size: '~22 MB',
  },
  {
    id: 'sdk-android',
    name: 'Thronos SDK for Android',
    platform: 'Android',
    type: 'sdk',
    version: LATEST_VERSION,
    filename: `thronos-sdk-android-${LATEST_VERSION}.aar`,
    url: `${SDK_BASE_URL}/thronos-sdk-android-${LATEST_VERSION}.aar`,
    icon: '🔧',
    description: 'Native Android SDK (.aar) — wallet, signing, chain queries',
    size: '~3 MB',
  },
  {
    id: 'sdk-ios',
    name: 'Thronos SDK for iOS',
    platform: 'iOS',
    type: 'sdk',
    version: LATEST_VERSION,
    filename: `ThronosSDK-${LATEST_VERSION}.xcframework.zip`,
    url: `${SDK_BASE_URL}/ThronosSDK-${LATEST_VERSION}.xcframework.zip`,
    icon: '🍎',
    description: 'XCFramework for iOS/macOS — wallet, signing, chain queries',
    size: '~4 MB',
  },
  {
    id: 'sdk-js',
    name: 'Thronos JS/TS SDK',
    platform: 'Web / Node.js',
    type: 'sdk',
    version: LATEST_VERSION,
    filename: `thronos-sdk-${LATEST_VERSION}.tgz`,
    url: `${SDK_BASE_URL}/thronos-sdk-${LATEST_VERSION}.tgz`,
    icon: '📦',
    description: 'npm-compatible SDK for browser and Node.js integrations',
    size: '~800 KB',
  },
  {
    id: 'chrome-extension',
    name: 'Thronos Chrome Extension',
    platform: 'Chrome / Brave',
    type: 'extension',
    version: LATEST_VERSION,
    filename: `thronos-extension-${LATEST_VERSION}.crx`,
    url: `${SDK_BASE_URL}/thronos-extension-${LATEST_VERSION}.crx`,
    icon: '🦠',
    description: 'Browser wallet extension for Chrome and Brave',
    size: '~1.2 MB',
  },
];

// ── GET /downloads/info  (JSON) ──────────────────────────────────────────────
router.get('/info', (_req, res) => {
  res.json({
    latest_version: LATEST_VERSION,
    updated_at: new Date().toISOString(),
    downloads: DOWNLOADS,
  });
});

// ── GET /downloads  (HTML page) ──────────────────────────────────────────────
router.get('/', (_req, res) => {
  const cards = DOWNLOADS.map(d => `
    <div class="card">
      <div class="card-icon">${d.icon}</div>
      <div class="card-body">
        <h3>${d.name}</h3>
        <p class="platform">${d.platform}</p>
        <p class="desc">${d.description}</p>
        <div class="meta">
          <span class="badge">v${d.version}</span>
          <span class="size">${d.size}</span>
        </div>
      </div>
      <a class="btn-dl" href="${d.url}" download="${d.filename}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M8 0a.5.5 0 0 1 .5.5v9.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V.5A.5.5 0 0 1 8 0z"/>
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.6a.5.5 0 0 1 1 0v2.6a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V10.4a.5.5 0 0 1 .5-.5z"/>
        </svg>
        Download
      </a>
    </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thronos Downloads</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0f1e;
      color: #e2e8f0;
      min-height: 100vh;
    }
    header {
      background: linear-gradient(135deg, #1a1f35 0%, #0d1526 100%);
      border-bottom: 1px solid #1e2d4a;
      padding: 32px 24px;
      text-align: center;
    }
    header .logo {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    header .logo img {
      width: 40px;
      height: 40px;
      border-radius: 8px;
    }
    header h1 { font-size: 2rem; font-weight: 700; color: #fff; }
    header p { color: #94a3b8; margin-top: 8px; font-size: 1rem; }
    .version-badge {
      display: inline-block;
      background: rgba(99,179,237,0.15);
      color: #63b3ed;
      border: 1px solid rgba(99,179,237,0.3);
      border-radius: 20px;
      padding: 4px 14px;
      font-size: 0.85rem;
      margin-top: 12px;
    }
    main {
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 16px;
    }
    .section-title {
      font-size: 1.1rem;
      color: #94a3b8;
      margin-bottom: 20px;
      padding-bottom: 8px;
      border-bottom: 1px solid #1e2d4a;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 40px;
    }
    .card {
      background: #111827;
      border: 1px solid #1e2d4a;
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: border-color 0.2s, transform 0.2s;
    }
    .card:hover { border-color: #3b82f6; transform: translateY(-2px); }
    .card-icon { font-size: 2rem; }
    .card-body h3 { font-size: 1rem; font-weight: 600; color: #f1f5f9; }
    .card-body .platform { font-size: 0.8rem; color: #3b82f6; margin-top: 2px; }
    .card-body .desc { font-size: 0.85rem; color: #94a3b8; margin-top: 6px; line-height: 1.5; }
    .meta { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .badge {
      background: rgba(59,130,246,0.15);
      color: #63b3ed;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .size { font-size: 0.75rem; color: #64748b; }
    .btn-dl {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      transition: background 0.2s;
      margin-top: auto;
    }
    .btn-dl:hover { background: #1d4ed8; }
    footer {
      text-align: center;
      padding: 24px;
      color: #475569;
      font-size: 0.8rem;
      border-top: 1px solid #1e2d4a;
    }
    footer a { color: #3b82f6; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="40" height="40" rx="8" fill="#1a1f35"/>
        <path d="M20 8L32 14V26L20 32L8 26V14L20 8Z" stroke="#3b82f6" stroke-width="2" fill="none"/>
        <circle cx="20" cy="20" r="4" fill="#3b82f6"/>
      </svg>
      <h1>Thronos Downloads</h1>
    </div>
    <p>Official apps, SDKs and tools for the Thronos blockchain</p>
    <span class="version-badge">Latest: v${LATEST_VERSION}</span>
  </header>

  <main>
    <p class="section-title">Mobile Wallet &amp; SDKs</p>
    <div class="grid">
      ${cards}
    </div>

    <p class="section-title">Quick Links</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      <a href="https://thronoschain.org" class="btn-dl" style="background:#0f172a;border:1px solid #1e2d4a;">&#127760; Website</a>
      <a href="https://explorer.thronoschain.org" class="btn-dl" style="background:#0f172a;border:1px solid #1e2d4a;">&#128269; Explorer</a>
      <a href="https://github.com/Tsipchain" class="btn-dl" style="background:#0f172a;border:1px solid #1e2d4a;">&#128025; GitHub</a>
      <a href="/downloads/info" class="btn-dl" style="background:#0f172a;border:1px solid #1e2d4a;">&#128204; JSON API</a>
    </div>
  </main>

  <footer>
    &copy; ${new Date().getFullYear()} Thronos Chain &mdash;
    <a href="https://thronoschain.org">thronoschain.org</a>
  </footer>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
