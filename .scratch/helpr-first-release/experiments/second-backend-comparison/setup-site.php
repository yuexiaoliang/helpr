<?php
// 仅用于独立测试站点配置；不创建实验内容，不属于网页执行器。
use Drupal\Core\DrupalKernel;
use Symfony\Component\HttpFoundation\Request;
use Drupal\node\Entity\NodeType;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\field\Entity\FieldConfig;
use Drupal\taxonomy\Entity\Vocabulary;
use Drupal\taxonomy\Entity\Term;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\Core\Entity\Entity\EntityFormDisplay;
use Drupal\Core\Entity\Entity\EntityViewDisplay;

chdir('/var/www/html');
$loader = require 'autoload.php';
$request = Request::create('http://home.ts-ali.internal:38081/');
$kernel = DrupalKernel::createFromRequest($request, $loader, 'prod');
$kernel->boot();
$kernel->preHandle($request);

\Drupal::service('module_installer')->install(['node','text','file','taxonomy','options','filter']);
if (!NodeType::load('report')) NodeType::create(['type'=>'report','name'=>'日报','description'=>'仅限 helpr 虚构验证素材'])->save();
if (!FieldStorageConfig::loadByName('node','body')) FieldStorageConfig::create(['field_name'=>'body','entity_type'=>'node','type'=>'text_with_summary','cardinality'=>1])->save();
if (!FieldConfig::load('node.report.body')) FieldConfig::create(['field_name'=>'body','entity_type'=>'node','bundle'=>'report','label'=>'Body','settings'=>['display_summary'=>false]])->save();
if (!Vocabulary::load('sections')) Vocabulary::create(['vid'=>'sections','name'=>'栏目'])->save();
foreach (['Excel 验证','其他'] as $label) {
  $exists=\Drupal::entityTypeManager()->getStorage('taxonomy_term')->loadByProperties(['vid'=>'sections','name'=>$label]);
  if (!$exists) Term::create(['vid'=>'sections','name'=>$label])->save();
}
if (!FieldStorageConfig::loadByName('node','field_section')) FieldStorageConfig::create(['field_name'=>'field_section','entity_type'=>'node','type'=>'entity_reference','cardinality'=>1,'settings'=>['target_type'=>'taxonomy_term']])->save();
if (!FieldConfig::load('node.report.field_section')) FieldConfig::create(['field_name'=>'field_section','entity_type'=>'node','bundle'=>'report','label'=>'栏目','required'=>true,'settings'=>['handler'=>'default:taxonomy_term','handler_settings'=>['target_bundles'=>['sections'=>'sections'],'auto_create'=>false]]])->save();
if (!FieldStorageConfig::loadByName('node','field_attachment')) FieldStorageConfig::create(['field_name'=>'field_attachment','entity_type'=>'node','type'=>'file','cardinality'=>1,'settings'=>['uri_scheme'=>'public']])->save();
if (!FieldConfig::load('node.report.field_attachment')) FieldConfig::create(['field_name'=>'field_attachment','entity_type'=>'node','bundle'=>'report','label'=>'附件','required'=>true,'settings'=>['file_extensions'=>'xlsx','file_directory'=>'reports','max_filesize'=>'10 MB','description_field'=>false]])->save();
$form=EntityFormDisplay::load('node.report.default') ?: EntityFormDisplay::create(['targetEntityType'=>'node','bundle'=>'report','mode'=>'default','status'=>true]);
$form->setComponent('title',['type'=>'string_textfield','weight'=>-10])
  ->setComponent('body',['type'=>'text_textarea_with_summary','weight'=>0])
  ->setComponent('field_section',['type'=>'options_select','weight'=>5])
  ->setComponent('field_attachment',['type'=>'file_generic','weight'=>10])->save();
$view=EntityViewDisplay::load('node.report.default') ?: EntityViewDisplay::create(['targetEntityType'=>'node','bundle'=>'report','mode'=>'default','status'=>true]);
$view->setComponent('body',['type'=>'text_default','label'=>'hidden','weight'=>0])
  ->setComponent('field_section',['type'=>'entity_reference_label','label'=>'above','weight'=>5,'settings'=>['link'=>true]])
  ->setComponent('field_attachment',['type'=>'file_default','label'=>'above','weight'=>10])->save();
$role=Role::load('helpr_tester') ?: Role::create(['id'=>'helpr_tester','label'=>'helpr 测试编辑']);
foreach (['access content','access administration pages','access content overview','create report content','edit own report content','view own unpublished content','use text format basic_html','view the administration theme'] as $permission) $role->grantPermission($permission);
$role->save();
$users=\Drupal::entityTypeManager()->getStorage('user')->loadByProperties(['name'=>'helpr_tester']);
$tester=$users ? reset($users) : User::create(['name'=>'helpr_tester','mail'=>'helpr-tester@example.invalid','status'=>1]);
$tester->setPassword(trim(file_get_contents('/run/helpr-private/tester-password')))->addRole('helpr_tester')->save();
\Drupal::configFactory()->getEditable('system.site')->set('name','helpr Drupal validation - fictional data')->save();
\Drupal::service('router.builder')->rebuild();
drupal_flush_all_caches();
echo json_encode(['version'=>\Drupal::VERSION,'type'=>'report','fields'=>['body','field_section','field_attachment'],'user'=>$tester->getAccountName(),'nodes'=>\Drupal::entityQuery('node')->accessCheck(false)->count()->execute()],JSON_UNESCAPED_UNICODE),PHP_EOL;
