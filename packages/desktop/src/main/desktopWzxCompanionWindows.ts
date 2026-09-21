/**
 * wzxClaw 伴侣集成的两个自绘窗口：配对二维码窗 + 桌面宠物窗。
 *
 * - 内容为主进程内联 HTML（data: URL，about.ts 同款先例），零 vite 入口改动；
 * - 共用最小 preload（wzxCompanionOverlay.cjs），攻击面只含本集成的 8 个通道；
 * - 宠物窗参数沿用 wzxClaw Companion 实战形态（frameless/transparent/
 *   alwaysOnTop(screen-saver)/skipTaskbar），拖拽用 -webkit-app-region。
 */
import { BrowserWindow } from "electron";
import { join } from "node:path";
import type { Locale } from "@zcode/shared";

export interface WzxOverlaySnapshot {
  state: string;
  stateText: string;
  pairingUrl: string | null;
  qrDataUrl: string | null;
  companionError: string | null;
  /** 最近一条通知（需要确认/需要回答/回答摘要）；null = 气泡显示连接状态 */
  notification: { kind: string; title: string } | null;
}

// 本模块创建的 overlay 窗口登记表：主进程凡是「遍历应用窗口」的逻辑
// （主窗口 reveal/退出确认/缩放定位等）都必须跳过它们，否则屏幕上常驻
// 可见的宠物窗会被当成第一个应用窗口，导致真正的主窗口永远唤不出来。
const overlayWindows = new Set<BrowserWindow>();

export function ownsWzxCompanionWindow(win: BrowserWindow): boolean {
  return overlayWindows.has(win);
}

function registerOverlayWindow(win: BrowserWindow): void {
  overlayWindows.add(win);
  win.once("closed", () => {
    overlayWindows.delete(win);
  });
}

const PET_WINDOW_WIDTH = 220;
const PET_WINDOW_HEIGHT = 250;
const PAIRING_WINDOW_WIDTH = 380;
const PAIRING_WINDOW_HEIGHT = 560;

// 与 src/main/index.ts 主 preload 同一解析规则：out/main → ../preload/<name>.cjs，
// 源码态与 app.asar 内相对位置一致。
function overlayPreloadPath(): string {
  return join(import.meta.dirname, "../preload/wzxCompanionOverlay.cjs");
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** overlay 窗口的 CSP：内联脚本/样式 + QR 的 data: 图片，其余全禁。 */
const OVERLAY_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

function isZh(locale: Locale): boolean {
  return locale === "zh-CN";
}

function petStrings(locale: Locale) {
  return isZh(locale)
    ? { pair: "配对", menu: "菜单", openMain: "双击打开主窗口" }
    : { pair: "Pair", menu: "Menu", openMain: "Double-click to open main window" };
}

function pairingStrings(locale: Locale) {
  return isZh(locale)
    ? {
        title: "wzxClaw 手机配对",
        noQr: "等待配对链接…",
        copy: "复制链接",
        copied: "已复制",
        retry: "重试连接",
        openMain: "打开主窗口",
        close: "隐藏",
      }
    : {
        title: "wzxClaw Phone Pairing",
        noQr: "Waiting for pairing link…",
        copy: "Copy link",
        copied: "Copied",
        retry: "Retry",
        openMain: "Open main window",
        close: "Hide",
      };
}

function buildPetHtml(locale: Locale): string {
  const s = petStrings(locale);
  const stateTextMap = isZh(locale)
    ? {
        paired: "已连接 NAS",
        "app-server-started": "工作中",
        "paired-no-model": "引擎未就绪",
        "waiting-pairing": "等手机配对",
        "app-server-dead": "桥异常",
        connecting: "连接中",
        disconnected: "离线",
      }
    : {
        paired: "NAS connected",
        "app-server-started": "Working",
        "paired-no-model": "Engine not ready",
        "waiting-pairing": "Awaiting phone",
        "app-server-dead": "Bridge error",
        connecting: "Connecting",
        disconnected: "Offline",
      };
  const stateColorMap = {
    paired: "#2ea56f",
    "app-server-started": "#2ea56f",
    "paired-no-model": "#d9a53a",
    "waiting-pairing": "#d9a53a",
    "app-server-dead": "#e05c5c",
    connecting: "#8a9186",
    disconnected: "#8a9186",
  };
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${OVERLAY_CSP}" />
<style>
  * { margin: 0; box-sizing: border-box; user-select: none; }
  html, body { background: transparent; overflow: hidden; height: 100%; }
  #root { height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-end; gap: 6px; }
  #bubble { max-width: 200px; background: rgba(24, 27, 24, 0.92); color: #e6e8e3;
    border: 1px solid #2c312b; border-radius: 10px; padding: 5px 10px; font-size: 12px;
    font-family: "Microsoft YaHei", system-ui, sans-serif; }
  #pet { -webkit-app-region: drag; width: 120px; height: 110px; cursor: grab;
    position: relative; background: #20241f; border: 2px solid var(--status, #8a9186);
    border-radius: 46% 46% 42% 42% / 54% 54% 40% 40%;
    animation: bob 2.6s ease-in-out infinite; transition: border-color 0.4s; }
  #pet::before, #pet::after { content: ''; position: absolute; top: 38px;
    width: 16px; height: 22px; background: #e6e8e3; border-radius: 50%;
    animation: blink 4.2s infinite; }
  #pet::before { left: 28px; }
  #pet::after { right: 28px; }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
  @keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.08); } }
  #bar { -webkit-app-region: no-drag; display: flex; gap: 6px; margin-bottom: 4px;
    opacity: 0; transition: opacity 0.25s; pointer-events: none; }
  /* 悬停宠物区域才显示操作按钮；隐藏时不吃点击 */
  #root:hover #bar { opacity: 1; pointer-events: auto; }
  #bar button { background: rgba(24, 27, 24, 0.92); color: #e6e8e3;
    border: 1px solid #2c312b; border-radius: 8px; padding: 3px 10px; font-size: 11px;
    cursor: pointer; font-family: "Microsoft YaHei", system-ui, sans-serif; }
  #bar button:hover { border-color: #2ea56f; }
</style>
</head>
<body>
<div id="root">
  <div id="bubble">…</div>
  <div id="pet" title="${s.openMain}"></div>
  <div id="bar">
    <button id="btnPair">${s.pair}</button>
    <button id="btnMenu">${s.menu}</button>
  </div>
</div>
<script>
  var stateText = ${JSON.stringify(stateTextMap)};
  var stateColor = ${JSON.stringify(stateColorMap)};
  function render(s) {
    document.getElementById('pet').style.setProperty('--status', stateColor[s.state] || '#8a9186');
    // 气泡优先显示最近通知（需要确认/需要回答/回答摘要，与手机端通知同逻辑）；
    // 无通知时回落到连接状态文案
    var n = s.notification;
    document.getElementById('bubble').textContent = (n && n.title) ? n.title : (stateText[s.state] || s.state);
  }
  window.wzxCompanion.getSnapshot().then(render);
  window.wzxCompanion.onEvent(function (ev) { if (ev.type === 'snapshot') render(ev.payload); });
  document.getElementById('pet').addEventListener('dblclick', function () {
    window.wzxCompanion.openMain();
  });
  document.getElementById('btnPair').addEventListener('click', function () {
    window.wzxCompanion.showPairing();
  });
  document.getElementById('btnMenu').addEventListener('click', function (e) {
    var r = e.target.getBoundingClientRect();
    window.wzxCompanion.petMenu(r.left, r.bottom + 4);
  });
</script>
</body></html>`;
}

function buildPairingHtml(locale: Locale): string {
  const s = pairingStrings(locale);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${OVERLAY_CSP}" />
<style>
  * { margin: 0; box-sizing: border-box; user-select: none; }
  html, body { background: transparent; overflow: hidden; height: 100%; }
  #card { margin: 10px; padding: 18px 16px; height: calc(100% - 20px);
    background: rgba(24, 27, 24, 0.97); border: 1px solid #2c312b; border-radius: 14px;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-family: "Microsoft YaHei", system-ui, sans-serif; color: #e6e8e3; }
  #title { font-size: 15px; font-weight: 600; }
  #state { font-size: 12px; color: #9aa39a; }
  #qr { width: 264px; height: 264px; background: #fff; border-radius: 10px; object-fit: contain; }
  #urlbox { display: flex; align-items: center; gap: 6px; width: 100%; }
  #url { flex: 1; font-size: 11px; color: #9aa39a; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  #err { font-size: 11px; color: #e05c5c; min-height: 14px; text-align: center; }
  #btns { display: flex; gap: 8px; margin-top: auto; }
  button { background: #20241f; color: #e6e8e3; border: 1px solid #2c312b;
    border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: #2ea56f; }
</style>
</head>
<body>
<div id="card">
  <div id="title">${s.title}</div>
  <div id="state"></div>
  <img id="qr" alt="QR" />
  <div id="urlbox"><span id="url"></span><button id="btnCopy">${s.copy}</button></div>
  <div id="err"></div>
  <div id="btns">
    <button id="btnRetry">${s.retry}</button>
    <button id="btnMain">${s.openMain}</button>
    <button id="btnClose">${s.close}</button>
  </div>
</div>
<script>
  var labels = { copy: ${JSON.stringify(s.copy)}, copied: ${JSON.stringify(s.copied)} };
  function render(s) {
    document.getElementById('state').textContent = s.stateText;
    document.getElementById('qr').src = s.qrDataUrl || '';
    document.getElementById('qr').style.visibility = s.qrDataUrl ? 'visible' : 'hidden';
    document.getElementById('url').textContent = s.pairingUrl || ${JSON.stringify(s.noQr)};
    document.getElementById('err').textContent = s.companionError || '';
  }
  window.wzxCompanion.getSnapshot().then(render);
  window.wzxCompanion.onEvent(function (ev) { if (ev.type === 'snapshot') render(ev.payload); });
  document.getElementById('btnCopy').addEventListener('click', function () {
    window.wzxCompanion.copyPairingUrl().then(function (ok) {
      if (ok) {
        document.getElementById('btnCopy').textContent = labels.copied;
        setTimeout(function () { document.getElementById('btnCopy').textContent = labels.copy; }, 1500);
      }
    });
  });
  document.getElementById('btnRetry').addEventListener('click', function () {
    window.wzxCompanion.retry();
  });
  document.getElementById('btnMain').addEventListener('click', function () {
    window.wzxCompanion.openMain();
  });
  document.getElementById('btnClose').addEventListener('click', function () {
    window.close();
  });
</script>
</body></html>`;
}

export function createWzxPetWindow(locale: Locale): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: overlayPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, "screen-saver");
  registerOverlayWindow(win);
  void win.loadURL(dataUrl(buildPetHtml(locale)));
  return win;
}

export function createWzxPairingWindow(locale: Locale): BrowserWindow {
  const win = new BrowserWindow({
    width: PAIRING_WINDOW_WIDTH,
    height: PAIRING_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: overlayPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  registerOverlayWindow(win);
  void win.loadURL(dataUrl(buildPairingHtml(locale)));
  return win;
}
