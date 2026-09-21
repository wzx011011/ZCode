# companion-core（wzxClaw 移植）

wzxClaw 项目的 companion 核心：把手机端（wzxClaw App）经自托管 NAS relay 发来的
ZCode Protocol v1 帧与本机 `zcode app-server`（stdio NDJSON）双向桥接，并提供
配对凭据生成、注册 proof、单实例锁、引擎 spawn/重启预算与 `x/*` 本地扩展。

## 来源与同步

- 来源仓库：`wzxClaw`（私有）`relay/zcode/`，分支 `feat/zcode-remote-integration`。
- 本目录是**原样拷贝**（含 `vendor/zcode-protocol.cjs` 官方协议契约层，Apache-2.0，
  由 wzxClaw 的 `scripts/build-zcode-protocol.mjs` 从官方开源源码构建）。
- 协议语义事实源：wzxClaw 仓库 `relay/zcode/APP-SERVER.md`。
- 更新方式：从 wzxClaw 仓库重新拷贝同名文件，逐字节覆盖；本目录不改任何逻辑，
  宿主适配（Electron 主进程）全部在 `src/main/desktopWzxCompanion*.ts`。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `companion.js` | 核心：relay 注册/认证/重连、配对 URL、AppServerBridge、x/* 扩展 |
| `lib/constants.js` | 帧上限常量 |
| `lib/proof.js` | 注册/认证 HMAC proof |
| `lib/protocol.js` | 错误码、超时分档 |
| `lib/state-path.js` | `~/.wzxclaw/zcode-companion/` 状态目录解析 |
| `lib/runtime-resolver.js` | 引擎运行时解析（env/安装/bundled/PATH） |
| `lib/plan-overlay.js` | 套餐模型目录注入 overlay |
| `vendor/zcode-protocol.cjs` | 官方协议 schema/方法表/错误码（唯一协议事实源） |

## 运行时依赖

`ws`（ZCode 桌面端已有依赖）。`qrcode` 仅 CLI 入口懒加载，宿主模式不使用；
主进程二维码由 `desktopWzxCompanion.ts` 自行生成。

## 宿主契约（`createCompanion(options)`）

宿主只需提供：`relayUrl`、`cwd`、`logger`、`onPairing(url)`、`onStateChange()`、
可选 `zcodeCommand: {command, args}`（缺省自动解析本机引擎）。单实例互斥由核心
的 `companion.lock` 文件锁保证——与独立运行的 wzxClaw Companion 天然互斥。
