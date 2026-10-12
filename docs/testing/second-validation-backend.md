# Drupal 验证后台

实测日期：2026-10-11（America/New_York）。用于与 WordPress 对照网页结构，部署与网页可用性不等于 helpr 产品验收通过。

## 实例与账号

| 项目 | 实际配置 |
| --- | --- |
| 机器与目录 | `home`；`/home/yuexiaoliang/services/helpr-validation-drupal` |
| Compose 项目 | `helpr-validation-drupal` |
| 入口 | [测试后台](http://home.ts-ali.internal:38081/admin/content)；[登录](http://home.ts-ali.internal:38081/user/login) |
| 监听 | `100.122.250.142:38081:80`，仅 Tailscale 地址 |
| 镜像 | `drupal:11.4.8-php8.4-apache-trixie`，`linux/amd64` |
| 实际版本 | Drupal `11.4.8`、PHP `8.4.26`、SQLite `3.46.1` |
| 数据 | 独立 `sites` 卷，SQLite 与文件均持久化于该卷 |
| 网页执行账号 | `helpr_tester`；仅测试内容的创建、编辑、附件与后台浏览权限 |
| 初始化账号 | `admin`；只用于环境准备 |

两个账号口令分别在远端 `private/tester-password`、`private/admin-password`，目录权限 `700`、文件权限 `600`。安装日志会包含初始化口令，也只留在该私有目录。仓库不保存凭据。实验登录态位于实验目录被忽略的 `private/auth.json`。

沿用主机已有代理拉取官方镜像，不改动全机 Docker 配置。WordPress、HedgeDoc 与现有代理保持独立。环境准备脚本使用 Drupal 原生 API 创建“日报”内容类型、正文、必选栏目和必选附件字段；栏目包括“Excel 验证”和“其他”，附件允许 `.xlsx`。未安装 helpr 专用模块。原生配置与脚本见[实验目录](../../.scratch/helpr-first-release/experiments/second-backend-comparison/README.md)。

## 镜像来源与恢复

版本来自 [Docker Official Images 的 Drupal 清单](https://github.com/docker-library/official-images/blob/master/library/drupal)，镜像构建配置见 [Drupal Dockerfile](https://github.com/docker-library/drupal/blob/master/11.4/php8.4/apache-trixie/Dockerfile)。固定的清单摘要为：

```text
sha256:e49d26ed1989bd77d372f30006fb148f5b0892b8256971aba15c985268e814d6
```

实际镜像配置 ID：`sha256:5848900a98182cc2d290b2c061219037d07c25f00eea6963fb7b03ab8517ad1c`。归档和校验和保存在远端 `images/drupal.tar`、`images/archive-sha256.txt`，清单摘要保存在 `images/manifest-digest.txt`。

在 `home` 的实例目录中启动或停止：

```sh
docker compose up -d --pull never
docker compose ps
docker compose stop
```

数据卷保留时不要重新安装站点。若镜像被清理，先核对归档校验和，再 `docker load --input images/drupal.tar`；该归档加载标签为 `drupal:i-was-a-digest`，需明确将此镜像重新标记为 Compose 所用标签，核对上述镜像配置 ID 后启动。

## 网页路径核对

使用专用账号从内容列表新建日报，填写标题和正文，在下拉框选择栏目，使用原生附件字段上传 Excel，再点击 Save。随后由匿名浏览器核对标题、正文、栏目、栏目页收录与实际下载字节。

- [实际发布内容](http://home.ts-ali.internal:38081/node/1)
- [栏目页](http://home.ts-ali.internal:38081/taxonomy/term/1)
- [独立断言与下载哈希](../../.scratch/helpr-first-release/experiments/second-backend-comparison/artifacts/environment/smoke/oracle.json)
- [公开页面截图](../../.scratch/helpr-first-release/experiments/second-backend-comparison/artifacts/environment/smoke/oracle-public.png)

此轮环境核对共一次上传、一次发布。源文件与下载文件的 SHA-256 均为 `fb4b33f9c551bd7effddd8fd32ccb9e50dc5161dd2e86acfd0742cbb6f390602`。服务器日志中的保存 POST 返回 `303` 并跳转 `/node/1`；浏览器工具的 URL 等待随后卡住，通过独立读取实际页面确认已成功，没有再次保存。

## 环境准备中的失败

1. 调查记录中的 `11.4.9` 镜像标签在此次仓库查询中不存在，改用官方清单与仓库实际提供的 `11.4.8` 并固定摘要。
2. 按摘要下载的归档加载为 `drupal:i-was-a-digest`。首次识别加载结果的备用逻辑误选了其它悬空镜像，初始化立即以 `php: not found` 失败；随后明确从上述标签重新标记，并核对配置 ID。没有修改其它容器或清理原镜像。
3. 直接运行 `core/scripts/drupal` 的第二次安装尝试无法加载 Composer 依赖；改用镜像中的 `/opt/drupal/vendor/bin/dr install`，第三次安装成功。安装失败日志均留在私有目录，未重置安装计数。
4. 原生字段配置脚本的参数与已存在正文存储发生两次错误；修正为显式字段名和实体类型、仅创建不存在的存储后成功。脚本没有创建测试文章。

真实模型学习和复用的技术对照结果由[取得第二后台的流程对照证据](../../.scratch/helpr-first-release/issues/11-second-backend-comparison.md)记录；本站点的可用性不能替代跨后台完整验收。
