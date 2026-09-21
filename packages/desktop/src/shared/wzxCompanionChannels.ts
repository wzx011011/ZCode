/**
 * wzxClaw 伴侣集成（companion-core）的 overlay 通道常量。
 *
 * 消费者只有本集成的两个自绘窗口（配对二维码窗 / 桌面宠物窗）+ 共用的
 * 最小 preload（src/preload/wzxCompanionOverlay.ts），不进 PlatformChannels
 * 主清单；主进程与 preload 双侧引用同一份常量，防止通道名漂移。
 */
export const WzxCompanionChannels = {
  /** renderer 拉取当前快照（invoke → WzxOverlaySnapshot） */
  Snapshot: "zcode:wzx-companion-snapshot",
  /** main → overlay 窗口推送快照更新（{ type: "snapshot", payload }） */
  Event: "zcode:wzx-companion-event",
  /** 打开/聚焦主窗口 */
  OpenMain: "zcode:wzx-companion-open-main",
  /** 显示配对二维码窗口 */
  ShowPairing: "zcode:wzx-companion-show-pairing",
  /** 宠物菜单（x/y 为页面坐标） */
  PetMenu: "zcode:wzx-companion-pet-menu",
  /** 复制配对链接到剪贴板 */
  CopyPairingUrl: "zcode:wzx-companion-copy-pairing",
  /** 隐藏宠物窗（持久化 petEnabled=false） */
  HidePet: "zcode:wzx-companion-hide-pet",
  /** 重启伴侣连接（stop + start） */
  Retry: "zcode:wzx-companion-retry",
} as const;
