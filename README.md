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

## 七维

| # | 维度 | 要回答的问题 |
|---|---|---|
| 1 | 设计：机制组合 | 这个能力能不能由现有机制（中间件/切面/option/注册表/钩子/已有函数）自然组合出来？新增抽象是否替组合做了本不该它做的决定？ |
| 2 | 方法契约 | 参数是否遗漏？缺省值是否有歧义（没传 vs 传了零值）？调用方会不会传错、漏传，或被迫绕开函数自己拼？ |
| 3 | 实现 | 在什么输入、状态或并发交错下会算错、漏处理、泄漏、死锁？ |
| 4 | 文档 | 读者照着注释/README/错误信息会不会做错事？ |
| 5 | 硬编码 | 哪个值本该随环境/租户/调用方/数据规模/版本变化，却被写死在代码里？ |
| 6 | 重复 | 同一行为是否存在第二个真相源？ |
| 7 | 过度设计 | 删掉它，今天会有什么损失？ |

另加扩展面：错误路径与部分失败、并发与生命周期、安全、兼容性、可观测性、性能、测试盲区。

## 三个机制

### 证伪闸门

每条候选结论先尝试推翻自己。答不上问题就降级为"待确认"或直接删掉：

- 实现 bug → 具体输入是什么？走到哪一行？得到什么错误结果？
- 并发问题 → 两个执行体在哪个窗口交错？共享对象是什么？
- 重复 → 哪条需求变了，这两处必须一起改？
- 过度设计 → 删掉它，今天的损失是什么？
- 硬编码 → 它必须随什么变化？不变时会怎样静默过期？

这条规则的作用不是让报告更短，而是让每条结论都能被作者复核。

### 证据阶梯

只读 diff、读了完整函数、grep 完全部调用方、看过测试、跑过最小复现——五种证据强度，报告的措辞必须匹配。没跑测试就写"静态阅读"；找不到跨仓库调用方就写"需确认"，不把"我没找到"写成"不存在"。

### 按改动类型的 playbook

七维是通用面，但有些缺陷只在特定改动类型里高频出现：

- **批处理 / Job / CLI**：成功判定、游标语义、幂等、环境隔离、dry-run、参数绑定、分页；
- **数据重放 / 迁移 / 回填**：时间窗口上下界、数据快照、未来数据泄漏、重复执行、只读宣称；
- **API / 库 / SDK**：默认值、零值歧义、向后兼容、错误语义；
- **并发 / 服务 / 守护进程**：锁顺序、取消传播、关闭顺序、后台线程；
- **配置 / 部署 / 脚本**：环境差异、密钥、退出码、可观测性。

## 快速开始

### Mavis（MiniMax Code）

```powershell
git clone https://github.com/Luo-root/deep-code-review.git "$env:USERPROFILE\.minimax\skills\deep-code-review"
```

### Agent Skills 目录布局

```bash
git clone https://github.com/Luo-root/deep-code-review.git ~/.claude/skills/deep-code-review
```

`SKILL.md` 的 frontmatter 只使用 `name` 与 `description`，按 Agent Skills 的目录布局可以加载；本仓库主要在 Mavis 上验证，其他运行时未逐一验证，欢迎反馈。

### 用法

```text
用 deep-code-review 审这个 PR
用 deep-code-review 审 src/replay/ 这个目录
按 deep-code-review 的标准审这次提交
```

## 输出长什么样

```markdown
## 结论

范围：feature/rate-limit 相对 main 的 7 个文件（merge-base a1b2c3d）。
结论：改完再合 —— P0 0、P1 2、P2 1、待拍板 1。

## 维度覆盖

| 维度 | 结果 | 查了什么 |
|---|---|---|
| 设计 | 1 条待定 | middleware 链、option 结构、3 个调用方 |
| 方法 | 1 条 P1 | 4 个新导出函数 + 全部 7 个调用点 |
| 实现 | 1 条 P1 | 7 个文件完整读；错误分支与并发 |
| ... | | |

## 必须修

### [P1][实现][本次引入] internal/ratelimit/redis.go:88 — Redis 超时后放行全部请求
- 触发：redis.Do 返回 context.DeadlineExceeded
- 影响：限流形同虚设，故障期间全部流量打满下游
- 证据：:91 把错误当"未限流"返回；TestRedisError 只断言不 panic
- 修法：超时走本地兜底计数器（已有 localFallback，:120）

## 需要你拍板
...

## 已查过没问题
...

## 本次没覆盖
...
```

固定六段：结论、维度覆盖、必须修、需要你拍板、已查过没问题、本次没覆盖。审查 commit/branch 时，问题会标 `[本次引入]` 或 `[既有]`，避免把旧问题算成回归。

## 设计取舍

**为什么先证伪，而不是先列问题？** 模型最擅长的不是找 bug，是生成"看起来像 bug"的句子。先把候选结论按闸门过一遍，能删掉大部分噪声。

**为什么 playbook 不并进七维？** 七维回答"从哪些角度想"，playbook 回答"这类改动历史上最容易漏什么"。混在一起会让通用清单变长，反而没人用。

**为什么"已查过没问题"也要写？** 未声明的"没问题"和不存在的"没问题"无法区分。写清查了什么，作者才知道哪些面可以放心。

**为什么保留"需要你拍板"？** 设计后果不都是缺陷。把"设计使然"和"bug"分开，作者才不用在错误的问题上改代码。

## 目录

```text
.
├── SKILL.md                  # 执行流程、七维速查、分级、输出契约
├── references/
│   ├── dimensions.md         # 七维扫描动作与误报边界
│   ├── playbooks.md          # 按改动类型的追加检查
│   ├── verification.md       # 证伪闸门与证据阶梯
│   └── output-template.md    # 六段式报告骨架与示例
├── assets/
│   ├── logo.svg
│   └── logo.png
├── LICENSE
└── README.md
```

## 评测

在一个 15 文件、+1161/−511 的真实 Java 提交上做过两轮 with/without 对照。第二轮找到 1 个 P0、3 个 P1、6 个 P2，并显式证伪 9 个候选；未运行构建与测试时，报告会标注"静态阅读 + 调用点 grep"，不把未验证说成已验证。

同一 skill 两轮之间会有波动，它不是确定性工具；它的价值是把"证据在哪、结论有多强"写清楚，最终判断仍然由人做。

## 贡献

- 新维度、新 playbook、误报/漏报的最小复现都欢迎提 Issue 或 PR。
- 保持 `SKILL.md` 正文在 500 行以内，细节放 `references/`。
- 不收集代码，不上传任何数据。

## License

[MIT](LICENSE) © 2026 jiangnan (Luo-root)
