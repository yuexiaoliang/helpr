# 第二套验证后台调查

调查日期：2026-10-10（America/New_York）。

本报告依据公开的官方文档、许可证和源码。源码核查基线为 Drupal `11.4.9`、Ghost `v6.69.0`、Directus `v12.5.0`；部署时仍需重新确认所选受支持版本。本文没有部署服务、登录后台或执行上传发布，因此“待实测路径”不表示已通过验收。Drupal 的版本可见[官方发布列表](https://www.drupal.org/project/drupal/releases?version=11)，Ghost 基线可见[发行说明](https://github.com/TryGhost/Ghost/releases/tag/v6.69.0)。

## 推荐结论（推论）

**首选 Drupal，备选 Ghost。** 排序优先考虑不同网页结构的对照价值，其次考虑原生能力与准备成本。Drupal 能把正文、分类引用、附件和发布状态组织成字段表单；Ghost 使用正文内的文件卡片、文章设置和发布菜单。两者都有可供浏览器访问的发布结果，不必为验证另写内容前台。以下判断建立在后文的一手证据上，仍需实际页面确认。

| 项目 | 许可与候选资格 | Excel 附件发布 | 从 Excel 生成文章后发布 | 需要准备的测试结构 |
| --- | --- | --- | --- | --- |
| **Drupal** | GPL-2.0-or-later；符合开源候选要求 | 核心 File 字段可承载附件，需显式允许 `xlsx` 并显示下载链接 | 原生正文编辑、预览、公开发布；表格理解与文章生成由任务执行方完成 | 在后台配置内容类型、附件字段及分类引用；不需定制模块或前台 |
| **Ghost** | MIT；符合开源候选要求 | 原生 File card；核查版本的文件白名单含 `.xlsx` | 原生文章编辑、预览和网站发布；表格理解与文章生成由任务执行方完成 | 测试标签、公开文章和测试账号；无需新建内容 schema |
| **Directus** | 当前 MSCL-1.0-GPL，官方明确称 source-available；本轮排除 | 原生文件库可上传文件，但文件入库不等于文章发布 | 需先建文章字段及发布规则；公开文章页面需另行准备 | 内容集合、分类关系、状态/访问规则；若核对公开文章，还需前台 |

许可与能力事实分别见[Drupal 许可](https://www.drupal.org/about/licensing)、[Drupal File 字段源码](https://github.com/drupal/drupal/blob/11.4.9/core/modules/file/src/Plugin/Field/FieldType/FileItem.php)、[Ghost 许可](https://github.com/TryGhost/Ghost/blob/v6.69.0/LICENSE)、[Ghost 上传配置](https://github.com/TryGhost/Ghost/blob/v6.69.0/ghost/core/core/shared/config/overrides.json)、[Directus 仓库说明](https://github.com/directus/directus#license)及[数据模型指南](https://directus.com/docs/getting-started/data-model)。各项准备工作属于测试站点配置建议，不是已经存在的实例能力。

## Drupal：首选

### 已核实的官方事实

- **许可与部署。** Drupal 使用 GPL 2 或更高版本。Drupal 11 的 PHP 最低要求为 8.3，Composer 最低为 2.7.0；数据库可选 MySQL 8.0+、MariaDB 10.6+、PostgreSQL 16+ 或 SQLite 3.45+，具体扩展和配置依数据库而定。这是 PHP 网站及数据库的部署工作，不需要外部内容服务才能建立测试站点。[许可](https://www.drupal.org/about/licensing)、[PHP](https://www.drupal.org/docs/getting-started/system-requirements/php-requirements)、[Composer](https://www.drupal.org/docs/getting-started/system-requirements/composer-requirements)、[数据库](https://www.drupal.org/docs/getting-started/system-requirements/database-server-requirements)
- **附件是核心字段能力。** 管理员可在内容类型的 Manage fields 中添加 File 字段，配置扩展名、大小和显示方式。`11.4.9` 的 `FileItem` 默认仅允许 `txt`，并提供 Allowed file extensions 设置，因此不能把“支持 File 字段”写成“安装后任何文章都能直接上传 Excel”。需要给测试内容类型增加附件字段，并将 `xlsx` 加入其允许列表。[File 模块说明](https://www.drupal.org/docs/8/core/modules/file/overview)、[FileItem 源码](https://github.com/drupal/drupal/blob/11.4.9/core/modules/file/src/Plugin/Field/FieldType/FileItem.php)
- **附件可以作为网页链接呈现。** 核心 Generic file formatter 为文件生成 `file_link`。公共文件使用可直接下载的链接；私有文件通过 Drupal 路由及访问控制提供。公开附件测试可使用公共存储，但“文件 URL 能访问”本身不能证明所属文章已经发布。[formatter 源码](https://github.com/drupal/drupal/blob/11.4.9/core/modules/file/src/Plugin/Field/FieldFormatter/GenericFileFormatter.php)、[文件位置与访问](https://www.drupal.org/docs/8/core/modules/file/overview#s-managing-file-locations-and-access)
- **内容发布与分类均为原生能力。** 官方用户指南给出标题、摘要、正文、Published、Preview、Save 的内容创建过程；taxonomy 支持平面或分层词表，以及编辑时自由创建或只从固定词表选择的方式。关联普通内容的分类词条可有内容列表页。[创建内容](https://www.drupal.org/docs/user_guide/en/content-create.html)、[分类机制](https://www.drupal.org/docs/user_guide/en/structure-taxonomy.html)
- **源码证明这不只是文档设想。** 核心 Article recipe 配置了正文、标题和发布状态等独立表单组件；Article tags recipe 配置分类自动补全及可点击的分类显示。内容通常拥有 `/node/<id>` 路径，也可设置别名；分类路径可为 `/taxonomy/term/<id>`。[Article recipe](https://github.com/drupal/drupal/blob/11.4.9/core/recipes/article_content_type/recipe.yml)、[Article tags recipe](https://github.com/drupal/drupal/blob/11.4.9/core/recipes/article_tags/recipe.yml)、[路径与别名](https://www.drupal.org/docs/user_guide/en/content-paths.html)

File 模块说明页面仍标记为需要完善，因此本报告用当前版本的字段与 formatter 源码交叉核对关键结论；不会把旧页面中的截图或菜单位置视为 `11.4.9` 的实测结果。

### 推荐理由与原生能力边界（推论）

Drupal 的测试准备需要一次后台配置，但配置对象就是它的原生内容结构。独立的附件字段、分类引用控件和发布状态，比单纯更换编辑器品牌更能增加操作结构的变化；可用于检验流程是否从真实页面形成，而非依赖一种固定的文章编辑方式。

建议仅建立一个“日报”内容类型：标题、正文、一个附件字段，以及关联固定词表的“栏目”字段。测试字段名、词条和样本是站点测试数据；helpr 的源码不应包含这些字段名、后台路径或选择器。它们必须由首次任务形成的流程记录并在运行时复用。

**Excel 附件发布**需要 File 字段；**读取 Excel 后生成文章**只需要正文发布能力。后者不能以附件下载成功代替验收，也不能从 File 字段的存在推断 Drupal 会理解表格、组织文章或核对数据。无需为第二种任务安装 Excel 导入模块；应由任务执行方读取素材，经既定内容确认过程后操作正文编辑器。

### 待实测路径

1. 配好“日报”内容类型和“栏目”固定词表；附件允许 `xlsx`，使用 Generic file 显示。确认测试编辑账号可以创建、上传和发布，访问者可以查看选定的测试内容。
2. 从后台的内容创建入口进入表单，填写标题/正文，选择指定栏目，通过附件字段上传真实 `.xlsx`，检查上传完成提示与文件名，然后预览并发布。菜单和按钮以实例实际页面为准。
3. 从保存后的内容链接打开实际文章，核对标题、正文、栏目和附件链接；打开对应分类列表，核对该文章确实归属指定栏目。
4. 从文章中的链接下载附件，对源文件与下载文件做字节或 SHA-256 比较。不能用上传提示、后台记录存在或下载文件名相同代替这一项。
5. 对“生成文章”另用一份带已知关键数值的 Excel：在确认内容后发布，并在实际文章页核对关键数值、文章结构和栏目；附件是否存在按该任务要求单独判断。

仍需核对：真实 `.xlsx` 的扩展名校验、中文/空格文件名、PHP 与反向代理上传限制、附件字段是否被隐藏、实际编辑器的输入行为，以及未发布内容和已发布内容的可见性差别。

## Ghost：备选

### 已核实的官方事实

- **许可与部署。** Ghost 的核查发行版使用 MIT 许可。官方支持的常规部署栈列出 Ubuntu LTS、Node.js 22 LTS、MySQL 8.0 或 8.4、NGINX、systemd，服务器内存至少 1GB。官方配置文档还要求生产环境配置邮件服务，并说明新设备登录默认会发送验证邮件；因此需要为测试账号准备可用的登录验证路径。[许可](https://github.com/TryGhost/Ghost/blob/v6.69.0/LICENSE)、[自托管要求](https://docs.ghost.org/hosting#self-hosting-details-%26-configuration)、[邮件及登录配置](https://docs.ghost.org/config)
- **原生文件卡片。** 编辑器可以通过 `+` 或 `/` 打开卡片菜单。File card 用于在文章中提供下载文件，并允许修改展示名称与说明。帮助文档中的文件大小数字对应 Ghost(Pro) 套餐，不能直接用作自托管实例的上传上限。[编辑器卡片](https://ghost.org/help/cards/#file)
- **`.xlsx` 有明确源码依据。** `v6.69.0` 的 `uploads.files.extensions` 含 `.xlsx`；文件卡片上传处理器把文件名、大小与返回的 URL 写入卡片。上游 API 测试还覆盖 `.xlsx` 返回成功及 `/content/files/.../spreadsheet.xlsx` 路径，但测试使用的是伪造表格内容，不能作为真实 Excel 已经端到端通过的证据。白名单也说明“任意文件类型”的帮助文字不应解释为无限制接受任意扩展名。[上传配置](https://github.com/TryGhost/Ghost/blob/v6.69.0/ghost/core/core/shared/config/overrides.json)、[卡片处理器](https://github.com/TryGhost/Ghost/blob/v6.69.0/koenig/koenig-lexical/src/utils/fileUploadHandler.ts)、[上传测试](https://github.com/TryGhost/Ghost/blob/v6.69.0/ghost/core/test/e2e-api/admin/files.test.js)
- **文章、预览与分类路径齐全。** Ghost 原生支持文章预览和发布，可选择 Publish only。文章 URL 默认由标题产生，也可编辑 slug。标签可从文章设置选择；公开标签自动形成 `/tag/<slug>` 内容集合页。主题可能只显示主标签，所以应同时核对标签集合页，而非只看文章上的一个标签。[发布与预览](https://ghost.org/help/publishing-content/)、[Publish only](https://ghost.org/help/delivering-emails/)、[文章设置](https://ghost.org/help/post-settings/)、[标签](https://ghost.org/help/tags/)

### 适用性与限制（推论）

Ghost 适合希望减少内容结构配置、较快建立另一条完整文章与附件链路的情况。原生文件卡片和公开标签集合已经足够构造任务目标，无需另建文章 schema 或前台。

本轮可把“指定栏目”对应为一个明确的公开标签。这个映射是测试任务的约定，不能将其泛化成所有后台的栏目规则。若后续要专门验证固定分类列表、多个结构化业务字段或不同内容类型，Drupal 更有对照价值。

文件卡片负责提供下载入口，不能当作读取 Excel 并生成文章的机制。生成文章场景应将已确认的正文写入编辑器，再核对公开文章。自托管上传上限、邮件验证和实际主题展示均仍需实测。

### 待实测路径

1. 建好公开测试标签及测试账号，确认新设备登录可完成；选择可显示文章及文件卡片的原生主题。
2. 新建文章，通过 File card 上传真实 `.xlsx`，选择目标公开标签，预览；按测试发布约定选择网站发布（Publish only）并完成发布步骤。
3. 打开实际文章 URL 和 `/tag/<slug>` 页面核对结果，从文章的文件卡片下载文件并与源文件比较。
4. 另外发布由 Excel 内容生成的文章，核对经过确认的文本与关键数值。记录页面中的实际文章 URL，不能仅记录预览 URL。

## Directus：源码可用的边界对照，本轮不推荐

**许可事实。** `v12.5.0` 的许可证是 MSCL-1.0-GPL，包含竞争用途及许可证密钥相关限制，并规定该版本发布四周年后可按 GPL 使用；官方仓库把现行许可证称为 source-available。免费 Core tier 或特定组织可获得免费许可，不改变“当前版本不是本轮要求的开源候选”这个分类。不能沿用旧 BSL 资料，也不能把未来 GPL 授权当作现在已是 GPL。[当前版本许可证](https://github.com/directus/directus/blob/v12.5.0/license)、[官方仓库的许可说明](https://github.com/directus/directus#license)、[自托管说明](https://directus.com/docs/self-hosting/overview)

**能力事实。** 官方提供 Docker Compose 自托管示例，要求持久化数据库和上传目录。Data Studio 文件库支持选择本机文件或拖放上传；文件类型可由 MIME allow list 控制，文档默认值为 `*/*`。文件详情可下载，资产可经 `/assets/<file-id>` 访问并受权限控制。因此 `.xlsx` 作为文件入库有依据，但仍未实测。[创建项目](https://directus.com/docs/getting-started/create-a-project)、[上传文件](https://directus.com/docs/guides/files/upload)、[文件配置](https://directus.com/docs/configuration/files#upload-limits)、[文件详情](https://directus.com/docs/guides/files/manage)、[访问文件](https://directus.com/docs/guides/files/access)

**内容边界与推论。** 官方入门从创建 `posts` 集合开始，再添加标题、WYSIWYG 正文及关系字段；新集合起初只有主键。用它构造本轮任务，还需要定义文章、附件关系、分类及何为“已发布”，并配置读取权限。若验收要求像文章网站一样浏览公开文章，还需另行提供相应前台，不能把保存一条 Data Studio 记录视为文章发布完成。它适合今后明确要测试通用数据后台时重新评估，不值得本轮在许可和站点准备两方面增加工作。[数据模型指南](https://directus.com/docs/getting-started/data-model)、[官方产品说明](https://github.com/directus/directus)

## 实测完成的判定建议（尚未执行）

第二套后台先独立证明上传、公开发布、栏目归属及下载一致性，再用于 helpr 的跨后台实验。发布结果至少包括实际文章链接、栏目/分类证据、附件下载结果；生成文章任务另有正文与数据正确性证据。

后续更换素材与重启复用时，应核对新结果和已有结果，避免把旧附件、旧文章或重复发布当成成功。若用于两任务并行实验，应让两个真实页面同时推进，并分别核对结果；仅有两个后台可访问不构成并行执行能力的证据。

本轮推荐只确定测试环境候选。测试站点可以配置内容结构，平台相关网页步骤和字段映射仍应由运行时形成的流程保存；资料调查、站点配置和上游测试都不能替代这一跨后台能力的实测。
