/**
 * wzxClaw 伴侣集成：把 wzxClaw 的 companion-core（relay 注册/配对/引擎桥）
 * 内嵌进 ZCode 桌面端主进程，提供「手机扫码配对」与「桌面宠物」两个入口。
 *
 * 设计要点：
 * - 核心是纯 JS（packages/desktop/companion-core/，原样拷贝自 wzxClaw 仓库，
 *   见其 README.md），经 createRequire 运行时加载，不进 tsup bundle——
 *   它的相对 require（lib/*、vendor/zcode-protocol.cjs）依赖真实目录结构；
 * - 与独立运行的 wzxClaw Companion 共享 ~/.wzxclaw/zcode-companion/ 状态目录：
 *   配对凭据不换码（手机不用重扫），互斥由核心的 companion.lock 文件锁保证；
 * - 引擎优先用本应用自带的 resources/glm/zcode.cjs（与桌面 Host 同源同版本），
 *   缺失时交由核心默认解析（本机官方安装 → PATH）；
 * - 伴侣在线与引擎健康解耦是核心自带语义：注册先行，桥在首条手机帧时按需
 *   spawn（非 runtimeManaged 模式），引擎不可用时手机端收到明确错误。
 */
import { app, BrowserWindow, clipboard, ipcMain, Menu } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Locale } from "@zcode/shared";
import { WzxCompanionChannels } from "../shared/wzxCompanionChannels.js";
import {
  createWzxPairingWindow,
  createWzxPetWindow,
  ownsWzxCompanionWindow,
  type WzxOverlaySnapshot,
} from "./desktopWzxCompanionWindows.js";

const DEFAULT_RELAY_URL = "wss://zcode.5945.top/ws";
const RELAY_URL_PATTERN = /^wss?:\/\/.+\/ws$/;

interface WzxCompanionInstance {
  start(): void;
  stop(): void;
  readonly state: string;
}

interface WzxCompanionActivity {
  kind: "confirm" | "ask" | "answer" | "clear";
  title: string;
}

interface WzxCompanionCoreModule {
  createCompanion(options: {
    relayUrl: string;
    cwd: string;
    zcodeCommand?: { command: string; args: string[] };
    stateDir?: string;
    snapshotPath?: string;
    registrationSecret?: string;
    logger?: (event: string, detail?: string) => void;
    onPairing?: (url: string) => void;
    onStateChange?: () => void;
    onActivity?: (activity: WzxCompanionActivity) => void;
    runtimeManaged?: boolean;
  }): WzxCompanionInstance;
  resolveRegistrationSecret(): string | null;
}

interface WzxCompanionConfig {
  relayUrl: string;
  cwd: string;
  petEnabled: boolean;
}

const STATE_TEXT: Record<string, { zh: string; en: string }> = {
  paired: { zh: "已连接 NAS", en: "Connected to NAS" },
  "app-server-started": { zh: "工作中", en: "Working" },
  "paired-no-model": { zh: "引擎未就绪", en: "Engine not ready" },
  "waiting-pairing": { zh: "等待手机配对", en: "Waiting for phone pairing" },
  "app-server-dead": { zh: "桥异常", en: "Bridge error" },
  connecting: { zh: "连接中", en: "Connecting" },
  disconnected: { zh: "未连接", en: "Disconnected" },
};

function stateText(state: string, locale: Locale): string {
  const entry = STATE_TEXT[state];
  if (!entry) return state;
  return locale === "zh-CN" ? entry.zh : entry.en;
}

function loadCompanionCore(): WzxCompanionCoreModule {
  // companion-core 与 out/main 的相对位置在源码树与 app.asar 内一致
  // （electron-builder files 含 companion-core/**/*）。
  const nodeRequire = createRequire(import.meta.url);
  return nodeRequire(
    join(import.meta.dirname, "../../companion-core/companion.js"),
  ) as WzxCompanionCoreModule;
}

interface QrCodeModule {
  toDataURL(text: string, options: Record<string, unknown>): Promise<string>;
}

function loadQrCode(): QrCodeModule | null {
  try {
    return createRequire(import.meta.url)("qrcode") as QrCodeModule;
  } catch {
    return null;
  }
}

/** 引擎命令：打包态优先本应用自带的 glm runtime（与桌面 Host 同一产物）。 */
function resolveEngineCommand(): { command: string; args: string[] } | undefined {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "glm", "zcode.cjs");
    if (existsSync(bundled)) {
      // 核心 runtimeProcessEnv 检测到 .cjs 参数会自动注入 ELECTRON_RUN_AS_NODE
      return { command: process.execPath, args: [bundled] };
    }
  }
  return undefined;
}

export interface WzxCompanionController {
  showPairingWindow(): void;
  togglePetWindow(): void;
}

export function initDesktopWzxCompanion(deps: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  getLocale: () => Locale;
  showMainWindow: () => Promise<void> | void;
}): WzxCompanionController {
  const configPath = join(app.getPath("userData"), "wzx-companion.json");

  function loadConfig(): WzxCompanionConfig {
    const defaults: WzxCompanionConfig = {
      relayUrl: DEFAULT_RELAY_URL,
      cwd: homedir(),
      petEnabled: false,
    };
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<WzxCompanionConfig>;
      const relayUrl =
        typeof parsed.relayUrl === "string" && RELAY_URL_PATTERN.test(parsed.relayUrl)
          ? parsed.relayUrl
          : defaults.relayUrl;
      const cwd = typeof parsed.cwd === "string" && existsSync(parsed.cwd) ? parsed.cwd : defaults.cwd;
      return { relayUrl, cwd, petEnabled: parsed.petEnabled === true };
    } catch {
      return defaults;
    }
  }

  function persistConfig(config: WzxCompanionConfig): void {
    // 持久化失败不阻断窗口/连接（切换形态必须永远可用），留观测下次覆盖
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      const tempPath = `${configPath}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      renameSync(tempPath, configPath);
    } catch (error) {
      deps.logger.warn("[wzx-companion] persist config failed:", error);
    }
  }

  const config = loadConfig();
  let state = "disconnected";
  let pairingUrl: string | null = null;
  let qrDataUrl: string | null = null;
  let companionError: string | null = null;
  // 最近一条「值得通知的事」（与手机端通知同内容逻辑）：null = 已处理/暂无，
  // 气泡回落到连接状态文案
  let notification: WzxCompanionActivity & { at: number } | null = null;
  let companion: WzxCompanionInstance | null = null;
  let petWin: BrowserWindow | null = null;
  let pairingWin: BrowserWindow | null = null;
  // 启动竞态标记：petEnabled 且宠物现身时主窗口还没创建（创建顺序不保证），
  // 主窗口第一次获得焦点时用它识别「这是启动期亮相」→ 隐主窗、亮宠物
  let pendingBootSwap = false;
  let lifecycle: Promise<void> = Promise.resolve();

  const core = loadCompanionCore();
  const qrcode = loadQrCode();

  function snapshot(): WzxOverlaySnapshot {
    return {
      state,
      stateText: stateText(state, deps.getLocale()),
      pairingUrl,
      qrDataUrl,
      companionError,
      notification: notification ? { kind: notification.kind, title: notification.title } : null,
    };
  }

  function broadcast(): void {
    const payload = { type: "snapshot", payload: snapshot() };
    for (const win of [petWin, pairingWin]) {
      if (win && !win.isDestroyed()) win.webContents.send(WzxCompanionChannels.Event, payload);
    }
  }

  function logCoreEvent(event: string, detail?: string): void {
    deps.logger.info(`[wzx-companion] ${event}${detail ? ` ${detail}` : ""}`);
  }

  async function startCore(): Promise<void> {
    pairingUrl = null;
    qrDataUrl = null;
    const registrationSecret = core.resolveRegistrationSecret() ?? undefined;
    try {
      companion = core.createCompanion({
        relayUrl: config.relayUrl,
        cwd: config.cwd,
        zcodeCommand: resolveEngineCommand(),
        registrationSecret,
        logger: logCoreEvent,
        onPairing: (url) => {
          pairingUrl = url;
          if (!qrcode) {
            qrDataUrl = null;
            broadcast();
            return;
          }
          qrcode
            .toDataURL(url, { width: 480, margin: 1 })
            .then((qr) => {
              qrDataUrl = qr;
              broadcast();
            })
            .catch(() => {
              qrDataUrl = null;
              broadcast();
            });
        },
        onStateChange: () => {
          // 状态以核心 state getter 为唯一投影，缓存回调参数会谎报健康
          state = companion ? companion.state : "disconnected";
          broadcast();
        },
        onActivity: (activity) => {
          if (activity.kind === "clear") {
            notification = null;
          } else {
            notification = { ...activity, at: Date.now() };
          }
          broadcast();
        },
      });
      companion.start();
      companionError = null;
      logCoreEvent("started", config.relayUrl);
    } catch (error) {
      // 典型：ALREADY_RUNNING（独立 wzxClaw Companion 正在运行）——如实进快照
      companionError =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : String(error);
      deps.logger.warn("[wzx-companion] start failed:", companionError);
    }
    broadcast();
  }

  async function stopCore(): Promise<void> {
    const running = companion;
    companion = null;
    state = "disconnected";
    pairingUrl = null;
    qrDataUrl = null;
    notification = null;
    if (running) {
      try {
        await running.stop();
      } catch {
        // 尽力停止旧链路
      }
    }
    broadcast();
  }

  function restart(): Promise<void> {
    const run = lifecycle.then(async () => {
      await stopCore();
      await startCore();
    });
    lifecycle = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function showPairingWindow(): void {
    if (!pairingWin || pairingWin.isDestroyed()) {
      pairingWin = createWzxPairingWindow(deps.getLocale());
    }
    pairingWin.show();
    pairingWin.focus();
    broadcast();
  }

  function showPetWindow(options: { active: boolean }): boolean {
    if (!petWin || petWin.isDestroyed()) {
      petWin = createWzxPetWindow(deps.getLocale());
    }
    if (options.active) {
      petWin.show();
      petWin.focus();
    } else {
      petWin.showInactive();
    }
    // 二选一：宠物现身，主窗口退场。返回是否真的隐藏到了主窗口——
    // false 说明主窗口此刻还没创建（启动竞态），交给 pendingBootSwap 兜底
    pendingBootSwap = false;
    return hideMainWindow();
  }

  function hideMainWindow(): boolean {
    // 与上游 targetWindow 同一取法：第一个非 overlay 应用窗口 = 主窗口
    const main = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && !ownsWzxCompanionWindow(win),
    );
    if (!main) return false;
    main.hide();
    pendingBootSwap = false;
    return true;
  }

  // 二选一的另一半：主窗口无论从哪条路径回到前台（托盘唤起、任务栏、
  // alt-tab、配对窗「打开主窗口」…）都让宠物退场。焦点隐藏是临时遮蔽，
  // 不改 petEnabled——那只记录用户显式开关，重启后按偏好恢复形态。
  app.on("browser-window-focus", (_event, win) => {
    if (ownsWzxCompanionWindow(win)) return;
    if (pendingBootSwap) {
      // 启动竞态兜底：主窗口在宠物之后才亮相——换下去
      pendingBootSwap = false;
      if (!win.isDestroyed()) win.hide();
      if (petWin && !petWin.isDestroyed()) petWin.showInactive();
      return;
    }
    if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
      petWin.hide();
    }
  });

  function hidePetWindow(persist: boolean): void {
    if (petWin && !petWin.isDestroyed()) petWin.hide();
    if (persist && config.petEnabled) {
      config.petEnabled = false;
      persistConfig(config);
    }
  }

  function togglePetWindow(): void {
    if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
      hidePetWindow(true);
      return;
    }
    config.petEnabled = true;
    persistConfig(config);
    showPetWindow({ active: true });
  }

  function registerIpc(): void {
    ipcMain.handle(WzxCompanionChannels.Snapshot, () => snapshot());
    ipcMain.handle(WzxCompanionChannels.OpenMain, async () => {
      await deps.showMainWindow();
    });
    ipcMain.handle(WzxCompanionChannels.ShowPairing, () => {
      showPairingWindow();
    });
    ipcMain.handle(WzxCompanionChannels.PetMenu, (_event, x: unknown, y: unknown) => {
      const zh = deps.getLocale() === "zh-CN";
      const menu = Menu.buildFromTemplate([
        {
          label: zh ? "打开主窗口" : "Open main window",
          click: () => {
            void deps.showMainWindow();
          },
        },
        {
          label: zh ? "配对二维码" : "Pairing QR",
          click: () => {
            showPairingWindow();
          },
        },
        {
          label: zh ? "隐藏宠物" : "Hide pet",
          click: () => {
            hidePetWindow(true);
          },
        },
      ]);
      menu.popup({
        x: typeof x === "number" ? Math.round(x) : undefined,
        y: typeof y === "number" ? Math.round(y) : undefined,
      });
    });
    ipcMain.handle(WzxCompanionChannels.CopyPairingUrl, () => {
      if (!pairingUrl) return false;
      clipboard.writeText(pairingUrl);
      return true;
    });
    ipcMain.handle(WzxCompanionChannels.HidePet, () => {
      hidePetWindow(true);
    });
    ipcMain.handle(WzxCompanionChannels.Retry, () => void restart());
  }

  registerIpc();

  app.on("before-quit", () => {
    // 桥 stop() 自带同步 kill + 2s SIGKILL 兜底；尽力而为，不阻塞退出序列
    if (companion) {
      try {
        companion.stop();
      } catch {
        // 退出路径尽力而为
      }
    }
  });

  void startCore();
  if (config.petEnabled) {
    const mainHidden = showPetWindow({ active: false });
    if (!mainHidden) {
      // 主窗口此刻还没建出来（创建顺序不保证）：挂起启动换场，
      // 等它第一次亮相时隐主窗、亮宠物
      pendingBootSwap = true;
    }
  }

  return { showPairingWindow, togglePetWindow };
}
