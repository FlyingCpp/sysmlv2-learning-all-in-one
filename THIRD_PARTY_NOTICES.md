# Third-Party Notices / 第三方声明

This document records third-party software and assets used by SynFeld v0.1.0.
It is an engineering inventory, not legal advice. Each third-party component
remains governed by its own license; the SynFeld project license does not
replace those terms.

本文记录 SynFeld v0.1.0 使用的第三方软件与资产。它是工程合规清单，不是法律
意见。每个第三方组件继续受其自身许可证约束，SynFeld 的项目许可证不会替代这些
条款。

## 1. Inventory baseline / 清单基线

- SynFeld release: `0.1.0`
- 本次功能迁移的公开基线：
  `b221839dda638a6689703964df33d7630ac5c11c`
- `package-lock.json` SHA-256:
  `972042024e29e69c83033c5b354773965d50823545353037f9a5a84cbf5f94fc`
- Last verified: 2026-09-05
- Project license: [Eclipse Public License 2.0](LICENSE)

本次新增 `undici@7.16.0`（MIT），供业务截止控制的 HTTP Dispatcher 使用。
与上述公开基线相比，其余锁定依赖版本、官方 Validator 固定版本、已公开资产
和外部镜像 digest 未变化。新增包的许可证声明来自 lockfile 与安装包元数据。

Regenerate and review this inventory whenever `package-lock.json`, a Docker
base image, a Compose image, the official Validator release, or a bundled asset
changes.

当 `package-lock.json`、Docker 基础镜像、Compose 镜像、官方 Validator 版本或
仓库内置资产发生变化时，必须重新生成并复核本清单。

## 2. Materials redistributed in this repository / 仓库内再分发材料

### 2.1 Official SysML v2 Vehicle fixtures

Files under
`apps/validator/fixtures/official-sysml-v2-release/vehicle/` are preserved
regression fixtures from the official Systems Modeling Language v2 Pilot
Implementation 2026-04 release.

- Upstream: [Systems-Modeling/SysML-v2-Pilot-Implementation](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation)
- Release: [2026-04](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/tag/2026-04)
- License: Eclipse Public License 2.0
- Local provenance: `apps/validator/fixtures/official-sysml-v2-release/vehicle/README.md`
- Treatment: preserved as upstream fixtures; not presented as original SynFeld
  course content

### 2.2 OpenCar vehicle display asset

The adapted `Car Concept` GLB at
`apps/web/public/model-assets/opencar/car-concept.glb` is derived from the
Khronos glTF Sample Assets repository.

- Upstream asset: [Car Concept](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept)
- Pinned upstream revision: `2bac6f8c57bf471df0d2a1e8a8ec023c7801dddf`
- Copyright: 2024 Darmstadt Graphics Group GmbH
- Model and textures: Eric Chadwick
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- Local attribution and adaptation record:
  `apps/web/public/model-assets/opencar/NOTICE.md`

The adapted runtime artifact removes embedded textures, applies an engineering
display transform, adds overlays, and suppresses nodes carrying upstream marks.
Those adaptations do not remove the CC BY 4.0 attribution obligation and do
not imply endorsement by Khronos Group, 3D Commerce, or the asset authors.

该运行时资产经过纹理移除、工程显示变换、覆盖层增加和标识节点隐藏处理，但这些
改编不会取消 CC BY 4.0 的署名义务，也不表示 Khronos Group、3D Commerce 或
原作者对 SynFeld 的认可。

## 3. Official Validator downloaded at build time / 构建时下载的官方 Validator

SynFeld does not commit the official Validator JAR or its complete library
cache. `scripts/setup-official-validator.js` downloads and verifies a pinned
upstream archive when the official Validator is prepared.

- Upstream: [Systems-Modeling/SysML-v2-Pilot-Implementation](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation)
- Release tag: `2026-04`
- Kernel version: `0.59.0`
- Archive: `jupyter-sysml-kernel-0.59.0.zip`
- Archive SHA-256:
  `1ef7e89abebbc008c5c2707f8b2f34630b3ab971de7b38f6d0240da6f461a828`
- License: Eclipse Public License 2.0
- Integrity manifest:
  `packages/teacher-contract/official-validator-runtime-artifacts.json`

The upstream archive can contain additional third-party components. Anyone
redistributing the downloaded runtime or a Docker image that contains it must
retain and review the license and notice files shipped in that archive.

上游压缩包可能继续包含其他第三方组件。再次分发该运行时或包含它的 Docker 镜像
时，必须保留并复核压缩包自带的许可证与声明文件。

## 4. Direct npm dependencies / 直接 npm 依赖

Versions and license identifiers below are taken from the locked dependency
metadata for this baseline. Package source archives installed by `npm ci`
retain their own license files, copyright notices, and warranty disclaimers.

下表版本和许可证标识来自本基线的锁定依赖元数据。`npm ci` 安装的软件包仍保留其
自身的许可证文件、版权声明和免责声明。

### 4.1 Runtime dependencies

| Package | Version | Declared license |
|---|---:|---|
| `@ai-sdk/openai-compatible` | 3.0.10 | Apache-2.0 |
| `@assistant-ui/react` | 0.15.1 | MIT |
| `@codemirror/autocomplete` | 6.20.2 | MIT |
| `@codemirror/commands` | 6.10.3 | MIT |
| `@codemirror/language` | 6.12.3 | MIT |
| `@codemirror/search` | 6.7.0 | MIT |
| `@codemirror/state` | 6.6.0 | MIT |
| `@codemirror/view` | 6.43.0 | MIT |
| `@emotion/react` | 11.14.0 | MIT |
| `@emotion/styled` | 11.14.1 | MIT |
| `@mui/material` | 9.1.1 | MIT |
| `@mui/x-tree-view` | 9.4.0 | MIT |
| `@tanstack/react-query` | 5.101.0 | MIT |
| `@tanstack/react-router` | 1.170.16 | MIT |
| `ai` | 7.0.28 | Apache-2.0 |
| `better-auth` | 1.6.25 | MIT |
| `elkjs` | 0.11.1 | EPL-2.0 |
| `i18next` | 26.3.6 | MIT |
| `lucide-react` | 1.20.0 | ISC |
| `mermaid` | 10.9.8 | MIT |
| `minisearch` | 7.2.0 | MIT |
| `pg` | 8.21.0 | MIT |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `react-i18next` | 17.0.11 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `three` | 0.179.1 | MIT |
| `undici` | 7.16.0 | MIT |
| `zod` | 4.4.3 | MIT |
| `zustand` | 5.0.14 | MIT |

### 4.2 Development dependencies

| Package | Version | Declared license |
|---|---:|---|
| `@emnapi/core` | 1.11.1 | MIT |
| `@emnapi/runtime` | 1.11.1 | MIT |
| `@types/node` | 24.13.3 | MIT |
| `@types/react` | 19.2.17 | MIT |
| `@types/react-dom` | 19.2.3 | MIT |
| `@types/three` | 0.179.0 | MIT |
| `@vitejs/plugin-react` | 6.0.2 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |
| `vite` | 8.0.16 | MIT |
| `ws` | 8.21.0 | MIT |

### 4.3 Transitive dependency snapshot

The locked tree contains 513 `node_modules` package entries. At this baseline,
512 entries declare license metadata in `package-lock.json`. The remaining
entry is `khroma@2.1.0`; its distributed package contains a `license` file
identifying the MIT License even though that field is absent from the lockfile
metadata.

The locked tree includes MIT, ISC, BSD-3-Clause, Apache-2.0, MPL-2.0,
EPL-2.0, 0BSD, Unlicense, AFL-2.1-or-BSD-3-Clause, and
MPL-2.0-or-Apache-2.0 components. The exact dependency graph is authoritative
in `package-lock.json`; license texts and copyright notices in installed
package archives remain authoritative for each package.

锁定依赖树包含 513 个 `node_modules` 软件包条目，其中 512 个在 lockfile 中声明
了许可证元数据。唯一缺少该字段的是 `khroma@2.1.0`，其发布包内的 `license`
文件明确采用 MIT License。精确依赖图以 `package-lock.json` 为准，每个安装包内
的许可证正文和版权声明是该组件的最终依据。

## 5. Container images referenced by the deployment / 部署引用的容器镜像

The following images are referenced by Dockerfiles or Compose files and are
pulled by users during build or deployment. Their image layers are not stored
in this Git repository. Image publishers may include operating-system packages
and further components under additional licenses; inspect the license material
inside each resolved image before redistributing a derived image.

以下镜像由用户在构建或部署时拉取，其镜像层不存储在本 Git 仓库中。镜像可能继续
包含采用其他许可证的操作系统软件包；再次分发派生镜像前，应检查固定 digest 镜像
内部的完整许可证材料。

| Image reference | Purpose | Primary upstream license boundary |
|---|---|---|
| `node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8` | Web, API and Teacher build/runtime | [Node.js license and bundled third-party notices](https://github.com/nodejs/node/blob/main/LICENSE), plus Alpine package licenses |
| `node:24.12.0-trixie-slim@sha256:35876cf614d84f076fcd51792d2ebe8ef21663d785d52ef09c2e459b0b199efa` | Validator Node.js stage | [Node.js license and bundled third-party notices](https://github.com/nodejs/node/blob/main/LICENSE), plus Debian package licenses |
| `eclipse-temurin:21-jdk-noble@sha256:81cecb98bcca2d5d5c3d496e71779073865db0d0bd776ecf434e017f20dac638` and `eclipse-temurin:21-jre-noble@sha256:5ea5c6c4c4f75be58b4391e91b14f72f53c3e7e43a304d537ceecd3f5513260d` | Official Validator Java build/runtime | Upstream OpenJDK/Temurin and Ubuntu package licenses contained in the images |
| `postgres:16.11@sha256:056b54f00419b49289227ab12d09df508543883f407fe9935a2cec430ef8aa8d` | Authentication and LiteLLM databases | [PostgreSQL License](https://www.postgresql.org/about/licence/), plus image package licenses |
| `pgvector/pgvector:pg16@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc` | Teacher PostgreSQL/pgvector database | [PostgreSQL-style pgvector license](https://github.com/pgvector/pgvector/blob/master/LICENSE), PostgreSQL License, plus image package licenses |
| `ghcr.io/berriai/litellm:v1.90.0@sha256:7315a3a1573d9ff0ed78068b73260e960486ff62922ee6a78f1a2be0f1e5e249` | Optional Full-mode model gateway | [LiteLLM license boundary](https://github.com/BerriAI/litellm/blob/main/LICENSE): content outside its separately licensed `enterprise/` directory is MIT; image users must review any enterprise content and terms present in the resolved image |

No license in this document grants rights to provider APIs, hosted model
services, trademarks, model weights, or user-supplied content used with the
Full deployment.

本文件中的任何许可证都不授予对 Provider API、托管模型服务、商标、模型权重或
Full 部署中用户自行提供内容的额外权利。

## 6. Redistribution responsibilities / 再分发责任

When publishing source archives, compiled Web assets, Docker images, installers,
or hosted distributions derived from SynFeld:

1. Keep the SynFeld `LICENSE`, `NOTICE`, and this file with the distribution.
2. Preserve third-party copyright, attribution, trademark, license, and NOTICE
   files that apply to the redistributed components.
3. Keep the OpenCar asset attribution and CC BY 4.0 adaptation notice visible
   in the distributed source or accompanying documentation.
4. Preserve EPL-2.0 notices and source-availability obligations for EPL-covered
   components and modifications.
5. Preserve MPL-2.0 notices and make source for modified MPL-covered files
   available as required by that license.
6. For Apache-2.0 components, preserve applicable attribution and upstream
   NOTICE content when the upstream distribution supplies it.
7. Re-audit dependencies and images after any version or digest update; do not
   reuse this inventory as proof for a different release.

发布 SynFeld 派生的源码包、Web 构建物、Docker 镜像、安装包或托管发行物时：

1. 随发行物保留 SynFeld 的 `LICENSE`、`NOTICE` 和本文件。
2. 保留实际再分发组件适用的版权、署名、商标、许可证和 NOTICE 文件。
3. 保留 OpenCar 资产的 CC BY 4.0 署名与改编说明。
4. 对 EPL-2.0、MPL-2.0 和 Apache-2.0 组件分别履行其通知、源码可用性和
   NOTICE 义务。
5. 任何版本或 digest 更新后重新审计，不得把本清单当成其他版本的合规证明。

## 7. Canonical license references / 许可证参考

- [Eclipse Public License 2.0](https://www.eclipse.org/legal/epl-2.0/)
- [MIT License](https://spdx.org/licenses/MIT.html)
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/)
- [ISC License](https://spdx.org/licenses/ISC.html)
- [BSD 3-Clause License](https://spdx.org/licenses/BSD-3-Clause.html)
- [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- [PostgreSQL License](https://www.postgresql.org/about/licence/)

If an upstream license file conflicts with this inventory, the upstream license
file controls. Report inventory errors through the repository's security or
issue-reporting process after those project files are published.

若本清单与上游许可证文件存在冲突，以上游许可证文件为准。项目发布安全上报或
Issue 流程后，应通过对应渠道报告清单错误。
