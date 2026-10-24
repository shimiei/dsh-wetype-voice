# dsh-wetype-voice

把 [DeepSeek Harness](https://github.com/deepseek-ai) 输入框上的麦克风按钮，从内置的本地语音识别换成**微信输入法（WeType）语音输入**。

Replace the built-in microphone button of DSH with the WeChat Input Method's own dictation hotkey: DSH synthesises the shortcut, WeType does the recording, the cloud recognition, and types the result straight into the composer.

- 本机实测：识别质量 = 微信输入法本身，音频不经过 DSH，也不加载本地模型（省掉 ~240MB 的 SenseVoice 模型）。
- 平台：**Windows only**（`SendInput` / P/Invoke）。

---

## 工作原理

内置语音输入原本是这条链路：

```
MediaRecorder 录音 → 上传 Host → sherpa-onnx + SenseVoice int8 本地识别 → 插入草稿
```

本插件把整段换成：

```
点麦克风 → POST /wetype/api {op:'trigger'}
        → Host 端常驻 PowerShell 助手用 SendInput 按下微信输入法「启动语音输入」快捷键
        → 微信输入法自己录音 + 云端识别 + 用 TSF 把文字打进 Harness 输入框
```

为什么不直接调 API：微信输入法没有对外 ASR 接口，设置项存在云端 + 加密本地缓存（MMKV / `MM_WETYPE.mmap3` / DPAPI 的 `index.json.enc`），语音触发走**低级键盘钩子 / RawInput**，`RegisterHotKey` 与 `PostMessage(WM_HOTKEY)` 都不参与。所以唯一稳的注入面是**合成真实按键**。

### 关键实现点

| 点 | 做法 |
| --- | --- |
| 按键注入 | `SendInput` + `KEYEVENTF_SCANCODE`（不发 VK），右 Alt 用**扩展扫描码 `E0-38`**（`KEYEVENTF_EXTENDEDKEY`），否则会被当成左 Alt |
| 组合键顺序 | `修饰键↓ → 主键↓ → 主键↑ → 修饰键↑`，`SendInput` 返回 `4/4` 才算成功 |
| 延迟 | 常驻一个 `pwsh` 子进程走 stdio 行协议，暖机后单次往返 ~1ms（冷启 1.3s） |
| 焦点 | 按钮 `onMouseDown` 里 `preventDefault()`，并对 `[data-lexical-editor="true"]` 兜底 focus —— 微信输入法要往“有焦点的控件”里写字 |
| 前台守卫 | 发键前比对前台窗口进程名，默认只允许宿主自身，避免把字打进别的程序 |
| 听写状态 | 微信输入法的语音窗 `wetype.flutter.setting` + 标题 `语音输入`，用 `IsWindowVisible` 判断是否正在听 |

### 目录

```
cordis.patch.yml   关掉内置语音输入四项 + 插入本插件
lib/index.js       Host：POST /wetype/api，op 分发，配置读写与校验
lib/injector.js    常驻 PowerShell 子进程的句柄（自动重启、行协议）
lib/injector.ps1   P/Invoke：SendInput / 扫描码表 / 前台守卫 / 语音窗探测
client.js          浏览器侧：输入框麦克风按钮 + 插件面板配置页
install.ps1        一键安装/卸载到 profile
```

---

## 安装

### 一键（推荐）

```powershell
# 把仓库放到任意目录，然后
.\install.ps1                  # 自动选择 desktop profile
.\install.ps1 -Profile all     # 所有带 package.json 的 profile
.\install.ps1 -Uninstall       # 卸载并恢复内置语音输入
```

脚本会：备份 `package.json`（`*.bak-wetype-<时间戳>`）→ 拷插件到 `plugins\` 与 `node_modules\` → 在 `dependencies` 与 `dsh.profile.bundles` 里注册 → 自检。

### 手动

1. 把本目录拷到 `~/.dsh/profiles/<profile>/plugins/dsh-wetype-voice`，再拷一份到 `~/.dsh/profiles/<profile>/node_modules/dsh-wetype-voice`；
2. `~/.dsh/profiles/<profile>/package.json` 里加：

```jsonc
{
  "dependencies": { "dsh-wetype-voice": "file:./plugins/dsh-wetype-voice" },
  "dsh": { "profile": { "bundles": [/* … */ "dsh-wetype-voice"] } }
}
```

3. 重启 DeepSeek Harness（插件在启动时加载，浏览器半侧不热重载）。

---

## 配置

### 插件面板（推荐）

**侧栏 → 插件 → 已安装 → dsh-wetype-voice → 该行的「配置」**：

| 字段 | 说明 |
| --- | --- |
| 语音快捷键 | 要和微信输入法「启动语音输入」完全一致。点**录入**直接按组合键抓取（自动识别左右修饰键），或点**自动探测快捷键**让插件自己试 |
| 注入方式 | `scan`（默认，扫描码）/ `vk`（虚拟键）/ `both` |
| 前台守卫 | `auto`（只在本应用前台时发键）/ `list`（只允许列出的进程）/ `any` |
| 允许的进程 | `guard = list` 时生效，逗号分隔，如 `chrome.exe, msedge.exe` |
| 预热延时 | 发键前等多久，默认 60ms |
| 试一次 | 立刻按一次当前快捷键，用来验证 |
| 恢复默认 | 回到 `ralt+space` / `scan` / `auto` / 60 |

保存后**立即生效**（配置写在 `$DSH_HOME/wetype-voice.json`，每次请求现读），不需要重启。

### 配置文件

```jsonc
// $DSH_HOME/wetype-voice.json
{ "hotkey": "ralt+space", "injectMode": "scan", "guard": "auto", "allowProcesses": [], "leadMs": 60 }
```

### HTTP 接口

页面内部用的是 `POST /wetype/api`（仅回环地址或同源请求）：

| op | 作用 |
| --- | --- |
| `status` | 当前配置、微信输入法版本、上一次触发结果、触发次数 |
| `trigger` / `start` / `stop` | 按一次快捷键（微信输入法里它是开关式） |
| `state` | 语音窗是否可见（`listening`） |
| `detect` | 逐个试候选快捷键，`persist: true` 时把命中的写进配置 |
| `save` | 批量保存 `hotkey` / `injectMode` / `guard` / `allowProcesses` / `leadMs`（先校验再落盘） |
| `setHotkey` / `setGuard` | 单项快捷设置 |
| `probe` | 探测微信输入法安装路径与版本 |
| `ping` | 注入器往返（返回 `READY\|1`） |

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/wetype/api `
  -ContentType 'application/json' -Body '{"op":"status"}'
```

---

## 换一台电脑

没有硬编码路径：profile 从 `$DSH_HOME` 推、脚本从 `import.meta.url` 推、守卫比对的目标进程名从 `process.execPath` 推。需要满足：

1. **Windows**；
2. 装了微信输入法（探测 `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramW6432%`、`%LOCALAPPDATA%`）；
3. `hotkey` 与该机器微信输入法的绑定一致 —— **这是唯一需要确认的**，用「自动探测快捷键」或「录入」解决。

候选顺序（`detect` 用）：`ralt+space → rctrl+space → lalt+space → ctrl+space → ctrl+alt+space → rctrl+ralt+space → lctrl+space → shift+space → lalt+shift → ralt+shift`。

兼容性：注入器优先 `pwsh`，没有就退到 Windows PowerShell 5.1；`install.ps1` 与 `injector.ps1` 存成 **UTF-8 with BOM**，否则 5.1 会把中文（语音窗标题匹配要用）读成乱码。

---

## 故障排查

`status.lastResult` 的三种典型值：

| 值 | 含义 | 处理 |
| --- | --- | --- |
| `OK\|ralt+space` | 键已发出 | 若微信输入法没反应，多半是 `hotkey` 与它的绑定不一致 |
| `SKIP\|foreground is 'X.exe', expected 'DeepSeek Harness.exe'` | 前台守卫拦下 | 点按钮前先把 DSH 切到前台；或把 `guard` 改成 `list` 并加入该进程 |
| `ERR\|...` | 注入器或键名问题 | `ERR\|unknown key 'x'` 说明键表不支持；`ERR\|SendInput sent 0/4` 说明会话/权限异常 |

其他：

- **按钮点了没反应**：先 `{"op":"status"}` 看 `weType.installed`，再看 `lastResult`；
- **说了话没出字**：确认 DSH 输入框有焦点（本插件只负责唤出语音条，文字由微信输入法写）；
- **听写会自己结束**：微信输入法静音约 1–3 秒自动收尾，这是它的行为，再点一次即可。

## 已知限制

- 只在 Windows 上工作；
- 依赖微信输入法的云端识别，离线不可用；
- `detect` 是**试**出来的，不在候选表里的绑定需要手动录入；
- 内置语音输入的四项已经被 patch 禁用，想要回来就删掉 patch 里那些 `disabled: true`。

## License

MIT
