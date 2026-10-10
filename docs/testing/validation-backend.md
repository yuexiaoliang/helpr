# WordPress 验证后台

实测日期：2026-10-10（America/New_York）。环境准备始于 2026-10-09。

## 用途与当前状态

此实例用于验证“把一份 Excel 文件作为可下载附件，经网页发布到指定分类，再核对发布结果”的真实后台路径。全部测试素材均为虚构数据。它不实现 helpr，也不证明 helpr 已具备流程学习、复用、定时执行或异常处理能力。

当前状态：独立实例已运行。已使用专用作者账号，通过真实网页上传 `.xlsx`、加入文章、选择“Excel 验证”分类并发布；随后在未登录的独立浏览器会话中打开文章和分类页，并从文章页下载附件。下载文件与源文件逐字节一致，SHA-256 相同。

- [后台登录](http://home.ts-ali.internal:38080/wp-login.php)
- [实际发布文章](http://home.ts-ali.internal:38080/?p=6)
- [Excel 验证分类](http://home.ts-ali.internal:38080/?cat=2)
- [实际 Excel 附件](http://home.ts-ali.internal:38080/wp-content/uploads/2026/10/excel-validation-sample.xlsx)

## 环境

| 项目 | 配置 |
| --- | --- |
| 机器 | `home`，通过 `ssh essh-home` 管理 |
| 部署目录 | `/home/yuexiaoliang/services/helpr-validation-wordpress/` |
| Compose 项目 | `helpr-validation-wordpress` |
| 入口 | `http://home.ts-ali.internal:38080` |
| 监听范围 | 仅 `100.122.250.142:38080`，该地址经 `tailscale ip -4` 确认，端口绑定经过实际检查 |
| 应用 | Docker Official Image `wordpress:7.1.3-php8.3-apache` |
| 数据库 | Docker Official Image `mysql:8.4.11`，不映射主机端口 |
| 初始化工具 | Docker Official Image `wordpress:cli-2.12.0-php8.3` |
| 隔离 | 独立 Compose 网络、WordPress 数据卷和数据库卷 |
| 站点时区 | `America/New_York` |
| 固定链接 | WordPress 原生 Plain 设置，文章地址为 `?p=ID` |

未改动现有 HedgeDoc、反向代理或全机 Docker 配置。80、443 和 3000 端口不属于此实例。

## 账号与配置

专用作者账号为 `helpr_tester`，初始化管理员为 `helpr_admin`。当前有效口令仅保存在远端部署目录下的 `.env` 文件中，权限为 `600`；本文和仓库不保存口令。浏览器测试使用作者账号完成，未借用管理员上传或发布权限。

初始化工具曾回显初始站点口令。两个站点账号随后均已重新生成口令并撤销旧会话，初始化脚本也已移除会回显输入的 `--prompt` 用法；网页登录验证使用的是更新后的口令。

`compose.yaml` 保存独立实例定义，`initialize-test-site.sh` 用于初始化测试站点及“Excel 验证”分类。站点标题和说明明确标注测试用途。配置关闭 WordPress 自动更新，以便解释重复实验的环境差异；更新应由维护者另行安排。

## 测试素材

远端样本：`/home/yuexiaoliang/services/helpr-validation-wordpress/fixtures/excel-validation-sample.xlsx`。

样本只有一个“测试数据”工作表，包含两条虚构记录：`TEST-001` 的数量为 `3`，`TEST-002` 的数量为 `7`。已通过单元格检查、错误扫描和渲染检查。

源文件和网页下载文件均为 **4,003 字节**。逐字节比较通过，下载文件的 ZIP 完整性检查通过，包含有效 `.xlsx` 所需的工作簿组成文件。两者 SHA-256 相同：

```text
dd8ced9470c493814678a42c5eceb24a0f67b5d62a15e8bc4f1a23a38c6700c3
```

## 镜像来源与下载限制

版本来自 [WordPress 的 Docker Official Images 清单](https://github.com/docker-library/official-images/blob/master/library/wordpress)和 [MySQL 的对应清单](https://github.com/docker-library/official-images/blob/master/library/mysql)。WordPress 镜像由 Docker 社区维护，具体使用方式见 [Docker Official Image 文档](https://hub.docker.com/_/wordpress)。

首次 `docker compose pull` 失败：现有 Docker 守护进程使用的代理 `127.0.0.1:20171` 拒绝连接。没有修改该配置。备用方式是在本实例目录使用 [crane v0.22.1](https://github.com/google/go-containerregistry/releases/tag/v0.22.1)，经已有可用代理下载官方镜像，再通过 `docker load` 导入。工具发布包已核对发布校验和。

下载脚本、日志、镜像归档和摘要保存在本实例目录。以下是本次拉取的 `linux/amd64` 镜像清单摘要；每个镜像均在下载前后核对摘要未变化：

| 镜像 | 清单摘要 |
| --- | --- |
| `wordpress:7.1.3-php8.3-apache` | `sha256:607e9f6829f9e4f3001bc91c98426aaa742d164af030aa7a8073932798e2af6b` |
| `mysql:8.4.11` | `sha256:80f4933e3835f9dc4d35a28ec500d7986cb4414e6c6821c5461239cb7beb8995` |
| `wordpress:cli-2.12.0-php8.3` | `sha256:07e56f9242a5c5e194bb0191c0f95a07fd1eefe712a231fc444d67eb51bb01e8` |

实际容器运行版本为 WordPress `7.1.3`、PHP `8.3.35` 和 MySQL `8.4.11`。启用主题为 Twenty Twenty-Five `1.5`。没有启用插件；镜像随附的 Akismet `5.7.2` 和 Hello Dolly `1.7.2` 均未启用。没有安装 helpr 专用插件或发布适配器。

镜像归档位于远端 `images/`，对应校验文件为 `images/archive-sha256.txt`，源清单摘要文件为 `images/manifest-digests.txt`。归档保留用于当前 Docker 代理条件下的恢复。

## 启停方式

以下命令均只针对本实例。在 `home` 上执行：

```bash
cd /home/yuexiaoliang/services/helpr-validation-wordpress
docker compose up -d --pull never db wordpress
docker compose ps
```

停止并保留全部测试数据：

```bash
cd /home/yuexiaoliang/services/helpr-validation-wordpress
docker compose stop
```

若本实例所需的本地镜像被清理，可以从保留的归档恢复，然后运行已有初始化脚本。该脚本对已经存在的站点、账号和分类进行检查，不重新创建它们：

```bash
cd /home/yuexiaoliang/services/helpr-validation-wordpress
sha256sum -c images/archive-sha256.txt
for archive in images/*.tar; do
  docker load --input "$archive"
done
./initialize-test-site.sh
```

## 已完成的网页验证与复现路径

1. 使用 `helpr_tester` 登录后台。
2. 新建文章，标题填写“Excel 附件发布验证（虚构样本）”，正文说明素材完全虚构。
3. 加入 File 区块，打开 Media Library → Upload files，通过网页文件输入控件上传样本，再选择该附件加入文章。
4. 勾选“Excel 验证”分类，保持 `Uncategorized` 未勾选，通过编辑器的 Publish 及发布确认按钮提交。
5. 在一个未登录的独立浏览器会话中，打开实际文章页，核对标题、作者、分类、正文和附件链接。分类页也确实列出该文章。
6. 点击文章页的 Download 下载附件，与源文件进行 SHA-256 和逐字节比较，均通过。

文章 ID 为 `6`，分类 ID 为 `2`。WordPress 记录的发布时间为 **2026-10-10 00:35:22（America/New_York）**。站点上的前台截图、分类页截图和实际下载文件保存在远端部署目录的 `evidence/` 下。

上述操作由本次准备工作的浏览器工具完成。原生 File 区块的功能说明见 [WordPress 文档](https://wordpress.org/documentation/article/file-block/)。管理工具只用于站点初始化和环境修正，没有用后台 API 或 CLI 代替样本的网页上传、文章发布和浏览器下载。

## 实测中处理的环境问题

- MySQL 首次初始化在当前主机上耗时超过最初健康等待窗口。初次 Compose 启动因此报告依赖不健康；数据库随后完成初始化并恢复 `healthy`，再启动应用成功。没有清除数据或调整全机服务。
- 初始化采用的日期/中文固定链接在前台返回 404。刷新 WordPress 重写规则后仍未解决，因此此测试站点改用原生 Plain 固定链接；当前 `?p=6` 文章地址和 `?cat=2` 分类地址均已实际核对。其他固定链接格式未验证。
- `agent-browser 0.27.0` 的一次等待/快照调用卡住，通过关闭并重开本次独立会话恢复。File 区块内 iframe 的文件选择器定位受限，改用同一原生区块提供的 Media Library → Upload files 界面完成上传。未修改全机浏览器设置。

## 覆盖范围

- 本场景验证完整 Excel 文件作为附件上传，不验证表格内容理解、行级导入或字段映射。
- 此站点使用 Tailscale 内网入口和 HTTP，没有配置新的域名或 HTTPS 代理。
- 单个 WordPress 后台不能证明微信公众号、小红书或其他企业平台的兼容性。
- 本次后台准备与 helpr 的实际运行能力需要分别验收。
- 目前只验证了一份小型附件和一次发布；重复任务、重复发布预防、大文件、登录失效、人工接管、停止、目标修正及定时执行均未在 helpr 中验证。
