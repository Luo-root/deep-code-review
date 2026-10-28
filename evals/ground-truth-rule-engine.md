# 标准答案（rule-engine 样本）

`fixtures/rule-engine/` 里**刻意植入**的缺陷清单。这份文件**不要给被测模型看**。

这个样本专门测**算法/复杂度**与**架构/设计语义**两类问题——tiny-shop 样本里没有这两种形态，所以单独一套标准答案、单独一轮评测。条目编号用 `R×`，与 tiny-shop 的 `G×` 互不干扰。

样本很小（约 370 行 Go），正常一轮就能读全——漏报不能用「没读完」解释。

## 应当报出

| # | 位置 | 维度 | 级别 | 问题 | 触发路径 / 规模 | 可接受的变体 |
|---|---|---|---|---|---|---|
| R1 | `internal/promo/engine.go:151` `reachable`、`:162` `reachableFrom` | 规模与复杂度 | P1 | 依赖图里有**共享节点**时，同一条依赖被反复展开：`reachableFrom` 每遇到一条 `Depends` 就递归展开整棵子树，没有已访问集合、没有记忆化。依赖图呈菱形时，展开条数按 Fibonacci 增长 | 深度 16 → 8,342 条 / 3.28 ms / 12.7 MB；深度 20 → 57,290 条 / 25.8 ms / 109 MB；深度 24 → 392,808 条 / 202 ms / 896 MB。README 写明依赖链最深 50 层 | 指出「同一依赖被重复展开 / 没有已访问集合 / 菱形依赖下指数增长」任一，**并**给出规模关系或实测数字 |
| R2 | `internal/promo/engine.go:99` `DuplicateLines` | 规模与复杂度 | P2 | 两两比较找重复 SKU：外层遍历购物车、内层再遍历一遍购物车，n 行就是 n(n−1)/2 次比较。建一张 map 就能过一遍 | n=200 行 → 19,900 次比较；n=800 行 → 319,600 次 | 指出「两两比较 / 平方级 / 应该用 map 或先建索引」任一，**并**说明规模 |
| R3 | `internal/promo/engine.go:176` `resolve`、`:188` `copyChain` | 规模与复杂度 | P2 | `resolve` 每层都把子链**完整深拷贝**一份（`copyChain`）再塞进 `Dependencies`。深度 d 的链要留 O(d²) 份节点 | 深度 25 → 33.6 KB；50 → 137.2 KB；100 → 554.4 KB；200 → 2,228,800 B（深度翻倍，分配 ×4） | 指出「每层深拷贝完整链 / 内存随深度平方增长 / 应该边走边累加」任一，**并**给出分配量或规模 |
| R4 | `internal/promo/engine.go:115` `discountFor`，被 `:56` `Apply` 的内层循环调用 | 规模与复杂度 | P2 | `discountFor` 每次被调用都重新 `make` 一张 map 并把全部规则填进去，然后用这张表查**一个** key。`Apply` 的内层循环每覆盖一行就调一次 → 索引被反复重建 | 100 条规则 / 200 行购物车 → 索引重建 200 次，实测 1.08 ms / 2.01 MB 分配。规则集最多 200 条 | 指出「索引在函数内部重建 / 应该建一次复用 / 查一个 key 却重建全表」任一，**并**指出它在循环里 |
| R5 | `internal/promo/engine.go:56` `Apply` 与 `:80` `ApplyChecked` | 重复（语义分裂） | P1 | 两个导出入口做的是同一件事（对购物车套用促销规则），行为却不同：(a) `Apply` 把折后单价**就地写回调用方的购物车**，`ApplyChecked` 不改；(b) 规则引用购物车没有的 SKU 时，`Apply` **静默跳过**该规则，`ApplyChecked` 直接返回 `ErrUnknownSKU`。调用方看不出该用哪个；修一条路径不会同步另一条 | 同一个购物车分别传给两个入口：折后单价一个被改一个没被改；含未知 SKU 的规则集一个静默少算一条、一个直接报错 | 指出「同一动作两条路径 / 一个改一个不改 / 一个静默跳过一个报错」任一，**并**指出具体差异 |
| R6 | `internal/promo/rule.go:44` `Pricer` 与 `internal/promo/sqlstore/store.go:42` `Apply` | 方法契约（跨层形状） | P2 | `promo.Pricer` 要求 `Apply(ctx, promo.ApplyRequest) (*promo.Result, error)`；`sqlstore.Engine.Apply` 是 `Apply(ctx, sqlstore.Request) (*sqlstore.Outcome, error)`——请求类型字段名不同（`Cart` vs `Items`）、多一个 `RuleIDs`、返回类型不同（`Result{Total, Applied}` vs `Outcome{Total, Lines}`）。`sqlstore.Engine` 因此**不满足 `promo.Pricer`**，换后端要改调用代码。**这不是编译错误** | 想把定价后端从内存换成数据库：持有 `promo.Pricer` 的调用方装不上 `sqlstore.Engine` | **并排列出两个签名**并指出具体差异（字段名 / 字段数 / 返回类型任一） |

## 应当明确说「查过没问题」

| # | 位置 | 事实 | 判定标准 |
|---|---|---|---|
| C1 | `internal/promo/engine.go:10` `Engine` | `Engine.rules` 只读；`Apply` / `ApplyChecked` / `Plan` / `Explain` 都不改引擎状态——`Apply` 改的是**调用方传入的购物车切片**。多个 goroutine 共用同一个 `*Engine` 并发定价，不会互相影响 | 好的报告会写明「并发这块查过没问题」并给依据（rules 只读 + 改的是入参切片）。**凭空编造竞态算误报** |

## 不该报

| 候选 | 为什么不报 |
|---|---|
| `internal/promo/engine.go:217` `cartTotal` 每次都遍历一遍购物车 | 单次线性遍历，购物车最多 200 行。这不是复杂度缺陷 |
| `Engine` 用指针、`New` 返回 `*Engine` | 正常写法；而且 `Engine{}` 零值可用（`rules` 为 nil 时 `Apply` 照样返回结果），不存在「零值不可用」 |
| `internal/promo/rule.go:55` `Result.Applied` 暴露规则 ID 列表 | 这是对外契约的一部分，不是过度设计 |
| `ErrUnknownSKU` / `ErrUnknownRule` 用 `errors.New` 哨兵 | 正常做法，不该报成错误语义问题 |
| `internal/promo/engine.go:14` `New` 没有拷贝传入的 `rules` 切片 | 规则集由调用方构建后固定不变，这是常见约定；没有具体触发路径 |

## 计分要点

- **规模类条目（R1–R4）没有触发路径**，按「规模关系 + 实测」判：说不出 N 是多少、或给不出任何数字的，最多记 0.5。这一条是为了区分「真的看出了复杂度问题」与「泛泛地说这里可能慢」。
- **R1 与 R3 是两个不同根因**（重复展开 vs 深拷贝），都发生在依赖图上，分开计。R1 的前提是依赖图**有共享节点**；R3 的前提是链**够深**。
- **R4 的成立前提是它在热路径上**：只说「这里每次重建 map」而没指出调用点在循环里，记 0.5。
- **R5 要同时给出两条路径和一处具体差异**才算 1；只说「有两个 Apply 入口」不算。
- **R6 要并排列出两个签名**并指出具体差异才算 1；只说「两个后端接口不一样」记 0.5。
- **快模式（A 轮）本就不跑规模扫描与反驳**，这四条不该在 A 轮拿满分——判分时按该轮的模式契约算（见 `evals/rubric.md`）。
