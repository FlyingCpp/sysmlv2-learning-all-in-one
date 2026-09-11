# Teacher 与编辑器的 SysML 命名支持

Teacher 的 Candidate 生成和 Repair 修复、编辑器高亮和补全，使用同一份官方语法生成的 129 个保留字。使用保留字作为名称时，写成 `part 'frame' : Frame;`，引用时也写成 `drone.'frame'`。`Frame` 与 `frame` 大小写不同，双引号表示字符串。

编辑器在常见声明位置提供限定名称建议，接受补全或按 Tab 时才插入单引号。注释、字符串、已有或尚未闭合的限定名称不会触发该建议；`part def` 等可继续输入的声明短语也不会被强制当成名称。高亮支持跨行块注释，并将单引号内容显示为名称。该提示是轻量上下文识别，完整语法与语义判断仍由官方 Validator 负责。

Teacher 在生成与修复的基础提示中得到相同词表及名称引用示例。命名冲突修复需要同时照顾声明和引用，并继续提交官方验证。这项改动不改运行状态机、授权来源、模型路由或 Validator 成功条件，也不承诺未经实测的成功率或速度提升。

词表来源为 `scripts/fixtures/sysml-grammar/pilot-2026-04` 中的官方 Xtext/Ecore 文件。它们来自 Validator 固定的 2026-04 发行版、0.59.0 内核，与归档中的原始文件逐字节核对。`provenance.json` 保存来源与 SHA-256；Git 保留语法文件原始换行。仅非终结有效规则中的单词字面量进入词表，排除字符范围和被继承规则覆盖的词。

```sh
npm ci
npm run check:sysml-keywords
npm run test:sysml-keywords
npm run test:web
```

连接实际 Validator 后运行 `npm run test:sysml-keywords:official`。默认地址为 `http://localhost:9090`，可通过 `VALIDATOR_URL` 指定。正例覆盖全部 129 个限定名称和名称引用，反例覆盖未限定的 `frame`、`references`、`first`，并要求没有 fallback。

升级官方内核时，应从新的已校验内核提取五份源文件，更新来源记录，再运行 `npm run generate:sysml-keywords` 并复核两个生成资产的差异；不能只手改前端词表。
