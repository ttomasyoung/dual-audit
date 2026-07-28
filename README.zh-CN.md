# dual-audit

**Claude 与 Codex 之间独立、有界、多轮的互审——不做橡皮章。**

[English README](README.md) · [Apache-2.0](LICENSE) · Linux（在 Ubuntu 24.04 上验证）

[![CI](https://github.com/ttomasyoung/dual-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/ttomasyoung/dual-audit/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/tag/ttomasyoung/dual-audit?label=release&sort=semver)](https://github.com/ttomasyoung/dual-audit/releases)

**它为什么存在：**[白干的两天](WHY.zh-CN.md) —— 促成这件事的那段经历。

---

## 要解决的问题

让第二个模型去检查第一个模型，看起来像是拿到了第二意见。多数时候并不是。

把答案先给审查者看，它就倾向于同意。让两个模型回答同一个问题，它们可能朝同一个方向自信地
错——它们的一致是关于模型的事实，不是关于世界的事实。而当审查链路本身出故障时——空回复、
被截断的回答、跑到一半被杀掉的进程——输出看起来几乎和「我看过了，没发现问题」一模一样。
**坏掉的审查者和满意的审查者长得很像，于是坏掉的那个被静默读成了通过。**

`dual-audit` 把这三件事都当成头等问题来处理。

## 它做什么

- **第 1 轮真正独立。** 两侧各自读同一批原始材料，**谁也看不到对方的总结、分析或裁决**。
  读取范围是一份显式白名单——是独立，不是放任乱翻。
- **第 2、3 轮交叉质证。** 双方拿到对方**冻结的第 1 轮裁决**，必须正面回应分歧。第 1 轮不可
  改写。**仅仅因为对方更自信而改口，不算收敛**——协议要求你说出是什么证据改变了判断。
- **一致不等于真。** 锚不到两个审查者之外的东西的结论，走**人类专家签字**，而不是就地收敛。
- **有界。** 最多 3 轮，且有审查调用硬顶。要么收敛，要么保留少数意见，要么把决定交回给你。
- **失败是响的。** 空输出、超时、非零退出、格式损坏、身份不符——每一种都是**有名字的独立失败**，
  没有任何一种能变成通过。

协议在设计上与控制器无关。本版用 Claude Code 作控制器、Codex 作独立审查者；审查状态与裁决
契约并不依赖这一点。

## 两条道

| | `dual-audit` | `light-audit` |
|---|---|---|
| 是什么 | 完整有界面板 | 一次独立第二意见 |
| 轮数 | 最多 3 轮，含交叉质证 | 最多 2 次，然后升级 |
| 用于 | 定义、阈值、规则、会喂下游的产物、不可逆操作 | 小分歧，或跑了一次没跑出定论 |
| 成本 | 每次审查数分钟、数万 token | 一次审查 |

还有第三条道，它不花钱：**直接把检查跑一遍。** 只要确定性测试、冒烟或 dry-run 能给出定论，
就用事实而不是意见。两个 skill 里都把这条写死了——**在一个跑一次就能定的地方开审查会，是这类
工具变贵但没变安全的最常见方式。**

## 依赖

- Linux（在 Ubuntu 24.04 上验证）
- Bash、Node 18+，以及常用工具（`flock`、`mktemp`、`timeout`、`awk`、`sed`、`grep`、`find`、`sha256sum`）
- [Claude Code](https://claude.com/claude-code)——控制器
- 已登录的 Codex CLI——独立审查者。它和 Claude Code 是两个独立产品，**多数循着这个项目找来的人还没有它**：
  用 `npm i -g @openai/codex` 安装（或见 [Codex CLI 项目](https://github.com/openai/codex)），然后跑 `codex login`。
  「已登录」具体是指存在凭据文件 `~/.codex/auth.json`；`dual-audit doctor` 会报告 CLI 是否找得到，
  而审查者 wrapper 在没有凭据时会**拒绝运行**，不会产出一份空审查
- `~/.local/bin` 在 `PATH` 里

不需要 sudo，全部装在你的家目录下。

## 安装

```bash
git clone https://github.com/ttomasyoung/dual-audit.git
cd dual-audit
./install.sh          # 想先看清它会动哪些文件，就加 --dry-run
dual-audit doctor
```

**第一次审查之前，先开一个新的 Claude Code 会话。** 审查者是一个 Claude Code agent 定义，而安装时
已经在跑的会话不一定认得它。请求一个尚未注册的 agent 类型会在任何东西开跑之前就失败，看起来
**和"审查者什么都没产出"一模一样**——`INFRASTRUCTURE_BLOCKED`、连着两次、且没有转录。
真碰上了看 `docs/troubleshooting.md`。

安装器**绝不覆盖**不是它写的文件——**`--force` 也不行**，那个开关只用来替换"它装的、而你后来改过的"
文件。归属由**被覆盖的那个文件自己带的标记**判定，不由安装清单判定：清单是个旁挂文件、谁都能写，
一份只是**声称**某路径属于本包的清单不能让它真的属于本包。它会记录自己写下的每个文件的哈希。

`./uninstall.sh` 只删仍与哈希相符、且自带标记的文件，**你改过的一律保留**。**要删哪些路径来自代码
里那份安装清单，永远不来自 manifest**——manifest 只被问一件事："我在这条我本来就知道自己会装的
路径上，记下的哈希是多少"。除非显式加 `--purge-profile`，否则**绝不删你的 profile**；而那个开关删的是
profile **文件**，只有在删完之后目录恰好空了才顺手把目录也删掉，因此它不可能连带走别的东西。

## 然后必须定制你的 profile——这一步不是可选的

```bash
$EDITOR ~/.config/dual-audit/profile.yaml
dual-audit profile apply      # 编译进已安装的面板
dual-audit doctor             # 检查，并抓出"改了 profile 却忘了 apply"
dual-audit profile routing    # 现在到底什么会被自动送审——信它之前先读这个
```

文件里带两个**被注释掉的**示例区域。请替换成你自己的；原样取消注释，描述的是别人的工作。
`doctor` 会告诉你：`critical_areas` 是不是还空着、某个关键词是不是短到会匹配远超预期、
以及你是不是改了 profile 却没 apply。

在那个文件写上 `customized: true` 之前，**自动路由是关的**：不会因为某条规则「猜」某件事重要
就把它送去审查。而**显式要求审查从一开始就能用**。

这是刻意的。预置一份「什么算重要」的清单，要么宽到把什么都审一遍，要么窄到让你对它漏掉的东西
产生虚假的安全感。**只有你知道自己工作里哪些决定错了代价大。** 在你告诉它之前，
`dual-audit doctor` 会一直提醒。

## 怎么用

在 Claude Code 里，profile 定制完成后两个 skill 会自行路由，并且任何时候都响应显式要求：

```
帮我双审一下这个迁移方案。
这个函数帮我轻审一下。
```

完整面板只有一个入口：

```
Workflow({
  scriptPath: '~/.claude/workflows/dual-audit-run.js',   # 安装时会替换成绝对路径
  args: { task, context, user_context_raw, project, risk, kind, mode, run_id, contextPack }
})
```

`task` 与 `context` 必须**自包含**——审查者不共享控制器的上下文。凡涉及代码，`contextPack`
必填（审查对象、期望输出、canonical 文档），且其中每个路径都必须是**绝对路径**。
详见 [docs/configuration.md](docs/configuration.md)。

## 怎么读结果

只有四个终态，其中只有一个表示审查通过：

| 终态 | 含义 |
|---|---|
| `CONVERGED` | 两道门都过。**只有这一个可以说成「审完通过」。** |
| `NOT_CONVERGED` | 轮次用尽仍有实质分歧，或某个结论需要人类签字。会带上未解决问题与少数意见。 |
| `INFRASTRUCTURE_BLOCKED` | 审查者或运行设施不可用。**什么都没被审**——这不等于「没发现问题」。 |
| `INVALID_AUDIT` | 身份、状态、schema 或参数校验失败。这次审计不可信，改对输入重跑。 |

**无法识别的内部状态一律落 `INVALID_AUDIT`**，绝不落到任何读起来像通过的状态。

## 隐私、成本，以及什么会离开你的机器

- **你的内容只发给你本来就配置好的模型提供方**——Claude Code 走 Anthropic，Codex CLI 走
  OpenAI，除此之外没有别处。本项目不新增任何服务、端点或账号。
- **遥测默认关闭。** 就算打开，也只记录这些字段、没有别的：运行耗时、排队耗时、用了哪个 slot、
  serial 还是 isolated、配置的 timeout、调用方给的 batch id、一个粗粒度 HTTP 信号、退出类别，
  以及本地 access token 是否仍新鲜。**绝不**记录 brief、argv、路径、环境变量值或凭据。
  token 那一项是个两态的新鲜度标志，不是由 token 内容推得的东西——留着它，是因为只有它能解释
  为什么退回了 serial 模式。
- **审查者以只读方式运行**：私有 home、中性工作目录，临时凭据里的 refresh token 已被剥除。
  **一个刻意保留的例外**：access token 接近过期时会退回 serial 模式，复用一个长期 home 并保留
  refresh token（否则无法续期），全程在排他锁内、同一时刻只跑一个。详见 `SECURITY.md`。
- **成本是真的。** 一次审查数分钟、数万 token；完整三轮面板是它的数倍。**按高风险决策用，
  不要按步骤用。**

## 已知局限

如实写明——一个把自己吹过头的审查工具，比没有更糟：

- **它能发现串线，不能防伪造。** 每份裁决都带一个把它绑定到「本次审计、本轮」的 audit id，
  这能拦住另一次审计的裁决被并进来。但一个刻意抄走 id 的审查者仍然可以随便写，而且**没有任何
  机制能证明某段文本是哪个模型产出的**。
- **它无法告诉你一个结论是不是真的。** 它只能告诉你这个结论有没有锚到可核查的东西上；锚不到
  就上交。
- **EVIDENCE 里有数字，不等于证据为真。** 这道门只保证「引用了具体的东西」，不保证引用是对的。
- **「每个批准者都开口了」不等于「每个批准者都对」。** 翻转门保证的是改口被声明了、并且跨轮
  稳定，不保证理由站得住。
- **散文级判断只作告警。** 「判断一段自然语言有没有实质内容」靠词法做不到——试过，放弃了。
  硬门只做结构判断，模糊判断只给人提示。
- **安装器与卸载器扛不住文件在脚下被换掉。** 两者都是先看一个路径、再对同一个路径动手。若这中间
  那里的东西变了——编辑器原子保存、另一个安装同时在跑、目录被改名/换挂载/换软链——那个判断描述的
  就不是最终被写或被删的那个文件。这里没有加锁，也没有通过已打开的描述符去核验。两者拒绝的门槛都
  远低于动手的门槛，所以现实的后果是"本可删除的文件被保留了"；反过来要发生，需要替换正好落在
  毫秒级的窗口里。**别同时跑两个，也别在它们运行时编辑已安装的文件。**
- **本版仅支持 Linux。** macOS 与 Windows 尚未支持。

## 排障

先跑 `dual-audit doctor`：它检查依赖、每个已安装文件是否存在且未被改动、`~/.local/bin` 是否在
`PATH` 里、profile 能否解析，以及面板里编译进去的那份 profile 是否已经过期。
详见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 文档

| | |
|---|---|
| [docs/installation.md](docs/installation.md) | 安装、升级、卸载、临时 HOME 测试 |
| [docs/configuration.md](docs/configuration.md) | profile schema、参数、环境变量 |
| [docs/protocol.md](docs/protocol.md) | 审查协议与每一道门，附理由 |
| [docs/architecture.md](docs/architecture.md) | 组件与边界 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 每种失败是什么意思、该怎么办 |

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。一句话版本：**改一道门，就要配一个「删掉这道门就会失败」
的测试。** 一个在有没有被保护代码时都通过的测试，不构成证据。

安全问题见 [SECURITY.md](SECURITY.md)。

## 路线图

- Codex 作控制器、Claude 作独立审查者（接口已预留；**未经验证的实现刻意不发**）
- macOS 运行时适配
- 更多可选领域 profile

以上任何一项都不得削弱本版的协议、隔离与 fail-closed 行为。

## 有问题、有想法

- **坏了，或者某道门不该拦却拦了** —— 开
  [issue](https://github.com/ttomasyoung/dual-audit/issues)。请附上终态、`convergence_status`、
  以及你期望的结果；`dual-audit doctor` 的输出也很有用。
- **"这件事该不该审"、"critical_areas 怎么写"、或者你想跟这套协议吵一架** —— 那是
  [discussion](https://github.com/ttomasyoung/dual-audit/discussions)，不是 bug。
- **你改造了它** —— 单模型自我双审、macOS 适配、领域 profile —— 请在 discussion 里说一声。
  **种子就是为这个撒的。**
- **安全问题** —— 见 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 致谢

这两个审查者在本仓库自己的开发过程中被反复使用，两边都实打实挣到了自己的位置。

**Codex** 作为独立的一侧参与审查。它只读原始材料、看不到另一侧的结论，因而找出了作者自己的工具
**结构上不可能发现**的东西——包括一个残存在 git 历史里的私有标识（本仓库自带的发布前扫描器压根
不查这一类）、裁决文法里的一个洞（能让一条写明的阻断项穿过整个面板没人读）、以及删除路径把文件
清单推导了两次却只比较长度。其中数次，作者一侧的判断与之相反，而且是错的。

**Claude** 是控制器、是每一轮面板里作者的那一侧，也写了这些代码。

**刻意没有把 Codex 列为 commit 的 co-author。** 在 git 里署名的含义是"参与编写"，而它在这里的角色是
**审查**——在一个以"作者与验证者不可塌缩"为前提的项目里，这条界线值得保持可见，而不是被压平成
一个贡献者计数。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
