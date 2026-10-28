<p align="center">
  <img src="assets/logo.svg" width="112" alt="deep-code-review logo">
</p>

<h1 align="center">deep-code-review</h1>

<p align="center">
  <strong>证据驱动的多维代码审查 skill</strong><br>
  七维扫描 · 证伪闸门 · 按改动类型的 playbook · 可复核的输出契约
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Luo-root/deep-code-review?style=flat-square" alt="License"></a>
  <a href="https://github.com/Luo-root/deep-code-review/releases"><img src="https://img.shields.io/github/v/release/Luo-root/deep-code-review?style=flat-square" alt="Release"></a>
  <a href="https://github.com/Luo-root/deep-code-review/actions/workflows/ci.yml"><img src="https://github.com/Luo-root/deep-code-review/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Luo-root/deep-code-review/stargazers"><img src="https://img.shields.io/github/stars/Luo-root/deep-code-review?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Luo-root/deep-code-review/issues"><img src="https://img.shields.io/github/issues/Luo-root/deep-code-review?style=flat-square" alt="Issues"></a>
  <img src="https://img.shields.io/badge/dimensions-7-2dd4bf?style=flat-square" alt="7 dimensions">
  <img src="https://img.shields.io/badge/playbooks-5-f59e0b?style=flat-square" alt="5 playbooks">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs welcome">
</p>

> An evidence-driven, multi-dimensional code review skill. Seven review dimensions, falsification
> gates, change-type playbooks, and a reviewable output contract.

代码审查最容易出问题的，不是"有没有看 diff"，而是三件事：

1. **只看 diff，不看调用方。** 改了签名、加了分支，却不知道还有 7 个调用点在别的模块。
2. **只看 bug，不看设计。** 真正贵的问题往往是"这个能力本可以由现有机制组合，却新加了一层"，或者"同一套行为写了两遍"。
3. **报了太多"看起来像问题"。** 作者要自己过滤噪声，最后干脆不看了。

`deep-code-review` 就是针对这三件事设计的。

## 两档模式

`deep-code-review` 有两档，按**用户在问什么**选：

| | 快模式（回归判定） | 全量模式（设计体检） |
|---|---|---|
| 用户在问 | 「有没有回归」「能不能合」「改坏了吗」 | 「这设计怎么样」「还有哪些坑」「按七维审」 |
| 做什么 | 读全 + 证伪 | 读全 + 反驳 + 类型 playbook + 七维 + 规模扫描 + 证伪 |
| 输出 | 紧凑列表，每条 2~3 行；零发现一句话 | 七段式 + 维度覆盖表 |

两档**共用**「读全」与「证伪」，不重复劳动。**反驳与规模扫描只在全量模式跑**——它们找的是设计与算法层面的问题，不是「这次改动有没有坏」。拿不准就走全量——全量的产出可以裁成快模式，快模式的产出补不回全量。

快模式的完整契约（范围、只报什么、输出形态、什么时候升级到全量）见 `references/regression-review.md`。

## 七维

| # | 维度 | 要回答的问题 |
|---|---|---|
| 1 | 设计：机制组合 | 这个能力能不能由现有机制（中间件/切面/option/注册表/钩子/已有函数）自然组合出来？新增抽象是否替组合做了本不该它做的决定？ |
| 2 | 方法契约 | 参数是否遗漏？缺省值是否有歧义（没传 vs 传了零值）？调用方会不会传错、漏传，或被迫绕开函数自己拼？ |
| 3 | 实现 | 在什么输入、状态或并发交错下会算错、漏处理、泄漏、死锁？ |
| 4 | 文档 | 读者照着注释/README/错误信息会不会做错事？ |
| 5 | 硬编码 | 哪个值被写死了，而它应当可变？先分清它是**协议固定值**（改了就是 bug）还是**业务政策值**（改了只是口径变了，如退款窗口、账期）？ |
| 6 | 重复 | 同一行为是否存在第二个真相源？同一个概念是否分裂成了几条行为不一致的路径？ |
| 7 | 过度设计 | 删掉它，今天会有什么损失？ |

另加扩展面：错误路径与部分失败、并发与生命周期、安全、兼容性、可观测性、性能、测试盲区。

七维之外还有两遍：

- **反驳**：先假设设计本身可能是错的，对每个公开概念质问四句——它有几处实现？同一条业务动作在正常/异常/恢复路径上语义一致吗？统一调用方能用同一个类型吗？职责有没有被另一个抽象认领？这一遍抓的是**语义分裂**与**职责重叠**，产出大多进「需要你拍板」。
- **规模扫描**：对每条含循环、递归、聚合、查找、拷贝的路径问——规模 N 是什么、随 N 怎么长、有没有重复访问同一状态/每层拷贝完整结果/每次重新全量扫描。**规模问题不需要有错误结果才算数**，它的证据是规模关系加实测。

## 四个机制

### 反驳一遍

七维的动作大多是「把这个设计和既有体系比一比」——第 1 维问能不能组合出来，第 6 维问有没有第二个真相源，第 7 维问删掉损失什么。**它们默认这个概念该存在，只问它配不配得上现有机制。**

反驳这一遍补的就是这个：对每个公开概念（类型、接口、入口、操作、状态名）逐条质问它凭什么存在。抓的典型形态是**语义分裂**——同一个动作有「普通版」和「可靠版」两个名字，两者在异常路径上分叉，文档还只描述了其中一条。

每条质问必须落到「谁会因为这个不一致而写错、改错或被绊住」，指不出具体后果就删掉。反驳不是找茬。

### 证伪闸门

每条候选结论先尝试推翻自己。答不上问题就降级为"待确认"或直接删掉：

- 实现 bug → 具体输入是什么？走到哪一行？得到什么错误结果？
- 并发问题 → 两个执行体在哪个窗口交错？共享对象是什么？
- 重复 → 哪条需求变了，这两处必须一起改？
- 语义分裂 → 两条路径各是什么？一个具体场景下它们的结果差在哪？调用方凭什么知道该走哪条？
- 过度设计 → 删掉它，今天的损失是什么？
- 硬编码 → 它是协议固定值还是业务政策值？若是业务政策值：必须随什么业务口径变化？不改会怎样静默过期？
- 规模 → N 的取值范围是多少？这条路径随 N 怎么长？实测开销是多少？

这条规则的作用不是让报告更短，而是让每条结论都能被作者复核。

### 证据阶梯

只读 diff、读了完整函数、grep 完全部调用方、看过测试、跑过最小复现——五种证据强度，报告的措辞必须匹配。没跑测试就写"静态阅读"；找不到跨仓库调用方就写"需确认"，不把"我没找到"写成"不存在"。

### 按改动类型的 playbook

七维是通用面，但有些缺陷只在特定改动类型里高频出现：

- **批处理 / Job / CLI**：成功判定、游标语义、幂等、环境隔离、dry-run、参数绑定、分页、规模；
- **数据重放 / 迁移 / 回填**：时间窗口上下界、数据快照、未来数据泄漏、重复执行、只读宣称；
- **API / 库 / SDK**：默认值、零值歧义、向后兼容、错误语义、共享状态、零值可用性、单位一致性、跨层形状、规模；
- **并发 / 服务 / 守护进程**：锁顺序、取消传播、关闭顺序、后台线程；
- **配置 / 部署 / 脚本**：环境差异、密钥、退出码、可观测性。

每份 playbook 都标注了它覆盖了扩展维度的哪些条目——**扫完 playbook 即视为那些条目已覆盖，不重复扫**。**规模扫描不被任何 playbook 覆盖**：它跟改动类型无关，只要代码里有循环、递归、聚合、查找或整块拷贝就要跑；playbook 里带「规模」标记的条目是该类型的高发场景，不是它的替代品。

## 快速开始

### Mavis（MiniMax Code）

```powershell
git clone https://github.com/Luo-root/deep-code-review.git "$env:USERPROFILE\.minimax\skills\deep-code-review"
```

### Agent Skills 目录布局

```bash
git clone https://github.com/Luo-root/deep-code-review.git ~/.claude/skills/deep-code-review
```

> Windows 上请保持仓库的 `.gitattributes` 生效（`* text=auto eol=lf`）。skill 文件被换成 CRLF 后，
> 以正则解析 frontmatter 的工具会读不到 `name` 与 `description`——那不是文件坏了，是解析器的限制。

`SKILL.md` 的 frontmatter 只使用 `name` 与 `description`，按 Agent Skills 的目录布局可以加载；本仓库主要在 Mavis 上验证，其他运行时未逐一验证，欢迎反馈。

### 用法

```text
用 deep-code-review 按七维审这个 PR
用 deep-code-review 审 src/replay/ 这个目录
给 internal/checkout 这个模块做个体检
按 deep-code-review 的标准审这次提交
帮我看看这个 PR 有没有回归，能不能合
```

## 输出长什么样

```markdown
## 结论

范围：feature/rate-limit 相对 main 的 7 个文件（merge-base a1b2c3d）。
结论：改完再合 —— P0 0、P1 2、P2 1、P3 0、待拍板 1。

## 维度覆盖

| 维度 | 结果 | 查了什么 |
|---|---|---|
| 设计 | 1 条（待定） | middleware 链、option 结构、3 个调用方 |
| 方法 | 1 条（P1） | 4 个新导出函数 + 全部 7 个调用点 |
| ... | | |
| 错误路径与部分失败 | 无发现 | 已查（见批处理 playbook）：错误分支逐条走 |
| 并发与生命周期 | 无发现 | 已查（见并发 playbook）：锁范围与 goroutine 退出 |

## 必须修

### [P1][实现][本次引入] internal/ratelimit/redis.go:88 — Redis 超时后放行全部请求
- 触发：redis.Do 返回 context.DeadlineExceeded
- 影响：限流形同虚设，故障期间全部流量打满下游
- 证据：:91 把错误当"未限流"返回；TestRedisError 只断言不 panic
- 修法：超时走本地兜底计数器（已有 localFallback，:120）

## 建议修

### [P2][硬编码] internal/ratelimit/limiter.go:52 — 重试次数写死在包内
- 问题：maxRetry = 3 直接写在包级变量里
- 证据：limiter.go:52；README 写「默认重试 3 次」但没有对外入口
- 收益：调参不必改代码重新发版
- 修法：提到 Options 里并给出默认值

## 需要你拍板
...

## 本次没覆盖
...
```

固定七段：结论、维度覆盖、必须修、建议修、需要你拍板、已查过没问题、本次没覆盖。

四个刻意的设计：

- **每一级都有落点**：P0/P1 进「必须修」，P2/P3 进「建议修」，设计取舍进「需要你拍板」。**不会出现「结论里写了 P2 3、正文里找不到这 3 条」。**
- **覆盖表用三态**（`无发现` / `未扫（理由）` / `n 条`），扩展维度各自成行——否则"扫了没问题"和"压根没扫"分不清。
- **"已查过没问题"是条件段**：只有真的跑了测试或做了专门证伪才写，每条带验证方式；否则整段省略。**宁可没有这一段，也不要有编出来的这一段。**
- **零发现时不要套七段**：直接给结论 + 1~2 句说明。

审查 commit/branch 时，问题会标 `[本次引入]` 或 `[既有]`，避免把旧问题算成回归。

## 设计取舍

**为什么先证伪，而不是先列问题？** 模型最擅长的不是找 bug，是生成"看起来像 bug"的句子。先把候选结论按闸门过一遍，能删掉大部分噪声。

**为什么 playbook 不并进七维？** 七维回答"从哪些角度想"，playbook 回答"这类改动历史上最容易漏什么"。混在一起会让通用清单变长，反而没人用。

**为什么"已查过没问题"要设成条件段？** 未声明的"没问题"和不存在的"没问题"无法区分——但反过来，**没有验证方式的"没问题"比不写更伤信任**。所以它有证据位，写不出验证方式就不写。

**为什么保留"需要你拍板"？** 设计后果不都是缺陷。把"设计使然"和"bug"分开，作者才不用在错误的问题上改代码。

**为什么要单独跑"反驳"？** 七维的动作大多是「把这个设计和既有体系比一比」——能不能组合出来、有没有第二个真相源、删掉损失什么。**它们默认这个概念该存在，只问它配不配得上现有机制。** 反驳反过来：先问这个概念凭什么存在，再问同一个名字在不同路径上是不是同一个意思。于是同一个动作分裂成"普通版"和"可靠版"、抽象层与后端层的类型形状不一致、职责被两个抽象同时认领——这些都在七维的缝隙里漏掉。反驳这一遍把"先假设设计是错的"变成一个固定动作，而不是可选项。

**为什么规模扫描要单独跑？** 七维第 3 维的成立条件是「输入 → 走到哪行 → 错误结果」，而复杂度问题**没有错误结果**——它表现为随规模爆炸。按七维的闸门去卡，它永远不成立。所以它需要自己的证据形态：规模关系加实测数字。

## 目录

```text
.
├── SKILL.md                  # 执行流程、两档模式、反驳、七维速查、规模扫描、分级、输出契约
├── references/
│   ├── dimensions.md         # 七维扫描动作与误报边界 + 规模与复杂度
│   ├── playbooks.md          # 按改动类型的追加检查
│   ├── verification.md       # 证伪闸门与证据阶梯
│   ├── regression-review.md  # 快模式：合并判定契约（范围、校准、输出形态、升级条件）
│   └── output-template.md    # 七段式报告骨架与示例
├── evals/                    # 可复现评测护栏
│   ├── fixtures/tiny-shop/   # 自写的样本仓库（25 个已知缺陷 + 1 个确认点）
│   ├── ground-truth.md       # 标准答案
│   ├── rubric.md             # 评分表
│   ├── runbook.md            # 操作手册
│   └── baseline.md           # 历次评测基线（追加，不覆盖）
├── tools/
│   └── lint-skill.mjs        # 仓库自带的 skill 校验器
├── .github/workflows/ci.yml  # CI：换行符 + skill lint
├── assets/
│   ├── logo.svg
│   └── logo.png
├── LICENSE
└── README.md
```

## 评测

在一个 15 文件、+1161/−511 的真实 Java 提交上做过两轮 with/without 对照。第二轮找到 1 个 P0、3 个 P1、6 个 P2，并显式证伪 9 个候选；未运行构建与测试时，报告会标注"静态阅读 + 调用点 grep"，不把未验证说成已验证。

同一 skill 两轮之间会有波动，它不是确定性工具；它的价值是把"证据在哪、结论有多强"写清楚，最终判断仍然由人做。

因为它有波动，**"改完 skill 之后有没有变好"不能靠感觉**。`evals/` 里有一套可复现的护栏：一份自写的、带 25 个已知缺陷的样本仓库，加标准答案、评分表和操作手册。它同时测「能不能找到 bug」和「会不会乱报」——后者才是让作者不看报告的主因。

首轮评测跑下来的结论值得记一笔：**三轮共同漏掉的两条，恰恰是标准答案自己写错的那两条**——所以「漏报率」这个指标在标准答案没校准之前，是不能直接拿来比较 skill 好坏的。这也是 `evals/baseline.md` 存在的理由：它同时记分数和口径缺陷。

**样本决定了测得到什么。** 现有样本是 150 行的结算模块，它测得出契约、文档、错误路径、并发这些面，**测不出算法复杂度与语义分裂**——样本里没有指数级回溯，也没有分裂成两条路径的动作。新能力要落地，得先有能触发它的样本与标准答案条目，否则「改完变好了还是变坏了」又变成凭感觉。

```bash
node tools/lint-skill.mjs .   # 本地跑一遍 skill 校验
```

## 贡献

- 新维度、新 playbook、误报/漏报的最小复现都欢迎提 Issue 或 PR。
- 保持 `SKILL.md` 正文在 500 行以内，细节放 `references/`。
- 改动 `SKILL.md` 执行顺序 / 七维表 / 输出契约 / `references/dimensions.md` 后，**请按 `evals/runbook.md` 跑一次评测**并把评分表贴到 PR 里。
- 不收集代码，不上传任何数据。

## License

[MIT](LICENSE) © 2026 jiangnan (Luo-root)
