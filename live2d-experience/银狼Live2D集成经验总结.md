# 银狼 Live2D 集成经验总结

> 本文档记录本项目把右上角静态立绘替换为 Live2D 模型、并配套独立控制页的全过程，包括：模型获取、工程集成、水印清除、加载优化、控制页打磨、睡觉泡泡取消、乱码修复、状态记忆，以及大量已踩过、**勿再重试的死路**。
> 涉及技术栈：Cubism4 / pixi.js / pixi-live2d-display 0.4.0 / BroadcastChannel / localStorage。

---

## 一、模型获取（BOOTH 免费模型）

- 来源：日本 BOOTH 平台，免费银狼模型 `booth.pm/ja/items/8290249`。
- **必须登录才能下载**：直连 HTTP 下载返回 404，需浏览器登录会话后经浏览器下载。
- 原包结构（标准 Cubism4）：16 表情（.exp3.json）、4 动作（.motion3.json）、6 张贴图（4096×4096 texture_00~05）。
- 用户明确否决的方案：需会员人民币的模型、B 站"只给安装包不给源码"的模型。

## 二、工程集成

### 2.1 三库本地化
把依赖库下载到 `public/vendor/live2d/`（不依赖外网 CDN）：
- `pixi.min.js`
- `live2dcubismcore.min.js`
- `pixi-live2d-display.cubism4.min.js`

### 2.2 model3.json 重写
`public/live2d/银狼/银狼.model3.json` 补全：
- `Expressions`：15 个表情（含作者自带的"月卡"/"水印"）。
- `Motions`：`Idle`（循环动画，默认待机）、`TapBody`（变身1/变身2/睡觉）。
- 贴图引用统一带版本号 `?v=12`（用于突破浏览器缓存）。

### 2.3 渲染层
`public/scripts/live2d-ctrl.js` 提供 `Live2DApp` 单例：
- `init()`：PIXI 渲染 `Live2DModel.from(model3.json)`。
- `_fit()`：按 `getLocalBounds()` 的**视觉中心**居中。**模型原点在视觉左上角**，居中公式：
  `scale = min(cw/b.width, ch/b.height) * 系数`；`position = (cw/2 - ccx*s, ch/2 - ccy*s)`。
  - 包围盒在纹理/内核就绪前不稳定，需重试（≤20 次 × 250ms）。
  - 用户要求"放大 2 倍"：系数 0.92 → **1.84**。

### 2.4 页面接入
- 主界面 `index.html`：原 `<img class="character-image">` 换成 `<div id="live2d-stage">`，body 末尾挂 4 个 script。
- 控制页 `public/live2d-control.html`：左预览 + 右控制（表情/动作/缩放/位移/重置）。
- 联动：`BroadcastChannel('silverwolf-live2d')`，消息类型 `expr / motion / scaleMul / offset / reset / stopAll`。

## 三、水印清除（全程最大难点）

### 3.1 认知纠正
- Live2D 的水印/装饰是 **ArtMesh 像素直接烘焙进贴图**，**没有单独的程序文件**可删。
- 作者给的"水印.exp3"只调 `key12 / Param45 / Param48 / Param49 / Param50`，把这些参数置 0 **并不能隐藏水印**（参数本就是 0，水印依旧）。

### 3.2 位置定位
- `texture_00` 左上 `x[0,1200]×y[0,1400]`：粉色"喵呜酱 miao wu jiang"艺术字（下方紧邻紫色护目镜等角色部件，**不能整块填白**）。
- `texture_01` 红章区约 `x[2050,3350]×y[1880,3140]`：红色"夜聿"印章。

### 3.3 最终正解
1. `restore_from_zip.py`：从 `银狼.zip` 恢复全部 6 张贴图（回到干净原图）。
2. `apply_clean.py`：只对两处做**精细掩码**清除：
   - texture_00 左上粉水印区清 380,009 px；
   - texture_01 红章区（红色 + 深色描边）清 278,749 px。
3. 验证：截图 OCR 无任何文字、角色完好（紫护目镜 / 机械刃翼 / 网袜 / 胸牌均属**原设计**，保留）。

### 3.4 已确认的死路（勿再重试）
| 死路 | 结论 |
|---|---|
| BOOTH 直连 HTTP 下载 | 404，需登录 |
| 水印参数置 0 | 不能隐藏水印 |
| `core.setDrawableOpacity` | 本版本不存在（改名报错） |
| `coreModel` 枚举 setter | 无此接口 |
| `model.children` 遍历隐藏网格 | 为空（整模型一次渲染） |
| 按 UV/网格批量清空 | 右侧 61–63 个小网格是角色**装饰**，误伤 |
| 彩色掩码单独清白字 | 白字混在角色上层网格，无法分离 |
| `getExpressionIndex()` | 不存在 |
| scipy | 未安装，仅用 PIL + numpy |

## 四、加载优化

- 贴图**无损压缩**（PIL `optimize=True`）：5 张贴图从 **14.4MB → 11.2MB，省约 22%**，不伤画质与水印成果。
- 版本号 `?v=N`（当前 v12）：改贴图后必须递增，否则浏览器缓存旧图。
- 贴图 `texture_05` 未被 model3.json 引用。

## 五、控制页打磨

- 移除"水印"按钮（表情 15 → 14 种）。
- 移除"循环动画"按钮（动作 4 → 3 个）：它是**默认待机动画**，加载即自动循环，点击只是重播，故"没效果"。
- "月卡"表情**真实生效**：实测点击后参数明显变化（参数 19:1.0→0.786、20:1.0→0.559、22:10→6.863、24:0.298→0.566 等），预览出现机械手臂/网袜/像素粒子——只是变化不够显眼。

## 六、睡觉泡泡取消（Bug 修复）

- **根因**：睡觉动画 `Motions/睡觉动画.motion3.json` 是 **`Loop: true`** 循环播放，持续驱动泡泡参数 `Param150~154`，其中 `Param154` 恒为 1（显示开关）——所以泡泡一直显示、无法退出。
- **修复**：新增 `stopAll()` 方法：
  1. `motionManager.stopAllMotions()` 停止所有动画；
  2. 复位泡泡参数 `Param150~154`、`ParamMouthOpenY` 归 0，睁眼参数 `ParamEyeLOpen/ROpen` 归 1；
  3. 回到清醒待机，并通过 BroadcastChannel 同步主页面。
- 控制页新增红色"停止当前动作"按钮。

## 七、乱码修复（CSS 编码陷阱）

- **症状**：右侧面板"数据存储"显示 `PostgreSQL 瀵煎嚭`。
- **根因**：`public/styles/chat-redesign.css` 的伪元素 `.stat-export strong::after { content: "  瀵煎嚭"; }` —— 本意是"导出"，但两个字在文件里存成了乱码"瀵煎嚭"。
- 全面扫描后一并修复的乱码（同一文件）：
  | 位置 | 乱码 → 正确 |
  |---|---|
  | 数据存储按钮 | 瀵煎嚭 → 导出 |
  | 侧栏折叠主题图标 | 鈼? → ● |
  | 用户资料下拉图标 | 鈥? → ▾ |
  | 表单已修改标签 | 宸叉敼 → 已修改 |
  | 7 处注释 | 还原为正确中文（含 2 处私有区字符 \ue137/\ue50b/\ue1bf） |
- **经验**：编码错乱常见于 GBK 中文被当 UTF-8 读写；修复时用 Python 显式 `encoding='utf-8'`，不要经过 PowerShell 管道（会二次重编码）。

## 八、状态记忆（刷新后保持选定动作）

- **需求**：刷新后模型保持上次选定的动作/表情。
- **实现**：`Live2DApp` 维护 `_state = { expr, motion, scaleMul, offsetX, offsetY }`，通过 `localStorage('silverwolf-live2d-state')` 持久化（主页面与控制页同源共享）。
- **关键坑**：init 里不能无条件先播 `Idle`（会覆盖已存 motion）。改为 `_restore(true)`：**有记忆动作则恢复记忆，否则才播 Idle 待机**。
- 各 setter（setExpression/playMotion/setScaleMul/setOffset）都同步更新 `_state` 并持久化；`reset()` 清空记忆。
- 控制页 `onReady` 里同步滑杆显示与记忆的缩放/位移。

## 八.五、睡觉眨眼"换脸"修复（Bug 修复）

- **症状**：睡觉动画播放时，眼睛会"一眨一眨"，且不是正常眨眼，像突然换成另一张脸又切回来。
- **根因**：`model3.json` 的 `Groups` 里定义了 `EyeBlink`（ParamEyeLOpen/ROpen），pixi-live2d-display 据此自动创建 `internalModel.eyeBlink` 眨眼管理器，周期性强推这两个参数。睡觉动画把眼睛恒定设为 0（闭眼），但眨眼管理器每 0.2s 左右把它"睁开→闭上"，把闭眼的睡脸硬拽成睁眼清醒脸，再弹回去 → 观感就是"换脸又换回来"。Idle（循环动画）本身并不动眼睛，唯一动眼睛的就是这个眨眼管理器。
- **修复**：新增 `Live2DApp._setEyeBlink(on)` 与 `_isSleepMotion()`：
  1. 播放睡觉（`TapBody` 组 index=2）时 `_setEyeBlink(false)`：保存 `im.eyeBlink` 引用 → 置 `null`（库内更新判定 `eyeBlink==null` 即跳过眨眼）。
  2. 播放其他动作 / `stopAll()`（醒来）/ `reset()` 时 `_setEyeBlink(true)`：把保存的眨眼管理器还回去。
  3. 刷新后 `_restore()` 走 `playMotion` 自动同步眨眼开关，无需额外持久化。
- **要点**：不要试图重建眨眼管理器（需 settings，库未暴露类），**保存引用→置空→归还**即可干净地暂停/恢复。

## 九、技术要点速查

### 9.1 模型核心接口（实测）
- `core.getDrawableCount()` = 375
- `core.getParameterIndex(id)` / `getParameterValueByIndex(i)` / `setParameterValueByIndex(i, v)` / `getParameterDefaultValue(i)`
- `model.expression(name)`：按名称触发表情（不抛错即有效）
- `model.motion(group, index, 3)`：播放动作，priority=3
- `model.internalModel.motionManager.stopAllMotions()`：停止所有动作

### 9.2 关键参数
| 参数 | 含义 | 备注 |
|---|---|---|
| Param150~154 | 睡觉泡泡 | 154 恒 1 = 泡泡显示开关 |
| ParamEyeLOpen / ParamEyeROpen | 眼睛开合 | 睡觉时 0，清醒 1 |
| ParamMouthOpenY | 嘴开合 | — |

### 9.3 模型接口细节
- `getDrawableTextureIndices(i)` 返回 number；`getDrawableVertices(i)` x,y 交替。
- `getParameterId(i)` 返回 `'?'`（读不出名字），**必须用名字查 index**。

---

## 附：修改文件清单

| 文件 | 改动 |
|---|---|
| `public/live2d/银狼/银狼.model3.json` | Expressions/Motions 重写、贴图 `?v=12` |
| `public/live2d/银狼/银狼.4096/texture_00~04.png` | 清粉字 + 红章 + 无损压缩 |
| `public/vendor/live2d/` | pixi / cubismcore / pixi-live2d-display 三库本地化 |
| `public/scripts/live2d-ctrl.js` | 渲染/控制/联动 + stopAll + 状态记忆 |
| `public/live2d-control.html` | 控制页（14 表情 / 3 动作 / 滑杆 / 停止按钮 / 记忆同步） |
| `public/index.html` | `#live2d-stage` 替换 + 4 script + "模型控制"入口 |
| `public/styles/chat-redesign.css` | 立绘容器样式 + 控制按钮 + 全部乱码清理 |
| `C:\Users\28189\Downloads\银狼.zip` | BOOTH 原包（未改动内部贴图） |

> 工具脚本备份：`C:\Users\28189\Doubao\chats\2026-09-29\new-chat\`（restore_from_zip / apply_clean / compress_tex / bump_v12 / fix_ctrl_btns / add_stopall / add_memory / fix_garbled 等）。
> 贴图备份：`C:\Users\28189\Doubao\chats\2026-09-29\new-chat\l2d_tex_preview\`。
