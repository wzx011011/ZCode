/**
 * wzxClaw 伴侣 overlay 窗口（配对二维码 / 桌面宠物）的共用 preload。
 *
 * 只暴露 overlay 页面真正需要的通道（与 src/shared/wzxCompanionChannels.ts
 * 同源），不复用主窗口的完整 preload——攻击面越小越好。
 */
import { contextBridge, ipcRenderer } from "electron";
import { WzxCompanionChannels } from "../shared/wzxCompanionChannels.js";

export interface WzxOverlaySnapshotEvent {
  type: "snapshot";
  payload: {
    state: string;
    stateText: string;
    pairingUrl: string | null;
    qrDataUrl: string | null;
    companionError: string | null;
    notification: { kind: string; title: string } | null;
  };
}

contextBridge.exposeInMainWorld("wzxCompanion", {
  getSnapshot: () => ipcRenderer.invoke(WzxCompanionChannels.Snapshot),
  openMain: () => ipcRenderer.invoke(WzxCompanionChannels.OpenMain),
  showPairing: () => ipcRenderer.invoke(WzxCompanionChannels.ShowPairing),
  petMenu: (x: number, y: number) => ipcRenderer.invoke(WzxCompanionChannels.PetMenu, x, y),
  copyPairingUrl: () => ipcRenderer.invoke(WzxCompanionChannels.CopyPairingUrl),
  hidePet: () => ipcRenderer.invoke(WzxCompanionChannels.HidePet),
  retry: () => ipcRenderer.invoke(WzxCompanionChannels.Retry),
  onEvent: (callback: (event: WzxOverlaySnapshotEvent) => void) => {
    const listener = (_event: unknown, payload: WzxOverlaySnapshotEvent) => callback(payload);
    ipcRenderer.on(WzxCompanionChannels.Event, listener);
    return () => {
      ipcRenderer.removeListener(WzxCompanionChannels.Event, listener);
    };
  },
});
