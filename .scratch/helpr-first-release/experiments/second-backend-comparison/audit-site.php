<?php
// 独立只读服务端核对，不调用实体保存/删除或内容发布 API。
use Drupal\Core\DrupalKernel;
use Symfony\Component\HttpFoundation\Request;
chdir('/var/www/html');
$loader=require 'autoload.php';
$request=Request::create('http://home.ts-ali.internal:38081/');
$kernel=DrupalKernel::createFromRequest($request,$loader,'prod');
$kernel->boot();$kernel->preHandle($request);
$nodes=[];
foreach (\Drupal::entityTypeManager()->getStorage('node')->loadMultiple() as $node) {
  $nodes[]=['id'=>$node->id(),'type'=>$node->bundle(),'title'=>$node->label(),'published'=>$node->isPublished(),'owner'=>$node->getOwner()->getAccountName(),'url'=>$node->toUrl('canonical',['absolute'=>true])->toString(),'body'=>$node->get('body')->value,'section'=>$node->get('field_section')->entity?->label(),'fileId'=>$node->get('field_attachment')->target_id];
}
$files=[];
foreach (\Drupal::entityTypeManager()->getStorage('file')->loadMultiple() as $file) {
  $real=\Drupal::service('file_system')->realpath($file->getFileUri());
  $files[]=['id'=>$file->id(),'name'=>$file->getFilename(),'uri'=>$file->getFileUri(),'permanent'=>$file->isPermanent(),'bytes'=>$file->getSize(),'sha256'=>is_file($real)?hash_file('sha256',$real):null];
}
echo json_encode(['at'=>gmdate('c'),'version'=>\Drupal::VERSION,'php'=>PHP_VERSION,'sqlite'=>\Drupal::database()->query('select sqlite_version()')->fetchField(),'nodes'=>$nodes,'files'=>$files],JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES),PHP_EOL;
