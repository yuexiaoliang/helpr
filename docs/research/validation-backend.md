# 验证后台调查：WordPress

调查日期：2026-10-09（America/New_York）。

## 结论

建议将自托管 WordPress 作为 helpr 的第一个验证后台，验证“从指定文件夹选取一份 `.xlsx`，经网页上传为文章附件，发布到指定分类，再核对结果”这一条完整任务。以下官方资料支持这条路径；本记录保存资料调查的依据，后续实例部署状态与实测证据见 [验证后台记录](../testing/validation-backend.md)。

这里的“发布 Excel”明确指**发布可下载的 Excel 文件附件**。如果目标是读取表格中的行、映射业务字段并导入后台记录，这份调查尚未证明适用，不能把两种任务混为一谈。此建议只选择验证环境，不决定 helpr 的产品架构。

## 已核实的事实

| 要验证的条件 | 事实与来源 |
| --- | --- |
| 可以自托管 | Docker Hub 的 `wordpress` 条目属于 Docker Official Image，并给出了 WordPress、数据库和持久化卷的 Compose 示例，以及通过浏览器访问实例的方法。镜像由 Docker Community 维护；仓库明确区分它与 WordPress 上游提供的官方镜像。[镜像文档](https://hub.docker.com/_/wordpress)、[维护仓库说明](https://github.com/docker-library/wordpress/blob/master/README.md) |
| 核心支持 `.xlsx` 类型 | WordPress 核心的 `wp_get_mime_types()` 包含 `.xlsx` 对应的 MIME 类型。`get_allowed_mime_types()` 以此为基础生成上传许可列表，并允许通过 `upload_mimes` 改变结果。因此标准配置具备支持基础，但具体实例仍需实际上传确认。[MIME 列表源码](https://developer.wordpress.org/reference/functions/wp_get_mime_types/)、[上传许可列表源码](https://developer.wordpress.org/reference/functions/get_allowed_mime_types/) |
| 可以从网页上传并加入文章 | 内置 File 区块允许从电脑上传文件或选择媒体库文件，生成文件链接和可选下载按钮。文档说明默认允许管理员、编辑和作者通过此区块上传文件。[File 区块文档](https://wordpress.org/documentation/article/file-block/) |
| 可以选择“栏目” | 文章设置侧栏可勾选一个或多个分类。WordPress 的分类页可以显示属于该分类的文章。将一个分类作为本次验证中的“栏目”是测试设计上的映射。[文章设置](https://wordpress.org/documentation/article/page-post-settings-sidebar/)、[分类文档](https://wordpress.org/documentation/article/posts-categories-screen/) |
| 可以核对已发布结果 | 编辑器的 Publish 操作用于公开文章；发布后可通过 View Post 打开实际前台页面。File 区块提供附件链接，因此可以把文章页和附件本身作为结果核对对象。[编辑器文档](https://wordpress.org/documentation/article/wordpress-block-editor/)、[File 区块文档](https://wordpress.org/documentation/article/file-block/) |
| 开源许可明确 | WordPress 软件以 GPLv2 或后续版本发布。镜像中的其他组件可能有各自的许可证。[WordPress 许可说明](https://wordpress.org/about/license/)、[镜像许可说明](https://hub.docker.com/_/wordpress#license) |

## 建议的最小验证场景

以下是后续实验建议，尚未执行，也不代表用户已确定全部验收细节。

1. 准备独立的 WordPress 单站点测试实例、一个测试账号、一个指定分类，以及内容已知的小型 `.xlsx` 样本。
2. 用自然语言委托 helpr：从给定文件夹找到指定文件，创建文章、加入文件附件、选择指定分类并发布。
3. 打开实际文章页，核对标题、分类、附件链接；下载附件后与源文件比较内容或校验值。只看到“发布成功”提示不足以完成这个实验的结果核对。
4. 换一份文件和标题重复任务，观察是否正确使用新输入、是否产生重复文章或附件；随后再加入登录失效、上传失败等受控异常。
5. 在前述任务能够实际完成后，再由 helpr 的定时任务触发相同路径。WordPress 自身也支持定时发布，但使用网站自己的定时发布功能，不能证明 helpr 的定时取材和执行能力。[WordPress 发布时间设置](https://wordpress.org/documentation/article/page-post-settings-sidebar/)

## 重要覆盖限制

- **附件发布不等于表格处理。** File 区块提供文件链接；此次路径没有验证表格内容理解、行级导入、字段映射或业务校验。[File 区块文档](https://wordpress.org/documentation/article/file-block/)
- **一个后台不足以证明跨站通用性。** 即使 WordPress 任务全部通过，也不能据此声称支持微信公众号、小红书或企业内部平台；这些结论需要各自的真实网页任务证据。这是测试覆盖范围判断。
- **后台可用不代表 helpr 能力已经成立。** 首次探索、流程复用、异常处理、人工接管、停止和目标修正，都需要在 helpr 的实际运行中分别验证；这次资料调查不能替代那些实验。
- **实例条件仍会影响上传。** 上传权限和 `upload_mimes` 过滤器会影响允许的文件类型；PHP 上传大小限制可以在镜像中配置。应以准备好的测试账号和样本实际验证，不预设文件大小上限。[File 区块权限](https://wordpress.org/documentation/article/file-block/)、[上传过滤器](https://developer.wordpress.org/reference/functions/get_allowed_mime_types/)、[镜像 PHP 配置说明](https://hub.docker.com/_/wordpress#configuring-php-directives)
- **需要记录实验环境。** 镜像文档说明默认配置启用 WordPress 自动更新。为解释两次实验之间的差异，应记录实际 WordPress 版本、镜像标识、主题与插件状态，以及测试前后是否更新；本次不猜测部署版本或资源需求。[镜像更新行为](https://hub.docker.com/_/wordpress#static-image--updates-via-redeploy)

## 环境勘查与后续实例验证

同轮独立只读勘查已确认 `ssh essh-home` 可用，机器上可使用 Docker 与 Docker Compose，`/home/yuexiaoliang/services/` 可写，资源余量足以容纳一个独立的轻量测试后台。已有服务正在使用部分端口，实际部署前仍需选择并复核空闲端口。这些是当次环境检查结果，不决定 helpr 自身的运行位置。

资料调查本身未部署 WordPress，也未运行真实的 `.xlsx` 上传、发布和下载验证。用户已允许搭建测试后台，后续在 `home` 上独立部署的配置与逐项验证结果单独记录于 [验证后台记录](../testing/validation-backend.md)，不能据此推断 helpr 已完成对应实现。

已有一手资料支持 WordPress 满足“附件发布到分类”的验证需求，因此本轮未扩展候选项目比较。
