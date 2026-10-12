#define NAPI_VERSION 8
#include <node_api.h>
#import <Cocoa/Cocoa.h>
#include <map>
#include <string>

static napi_env envRef;
static napi_ref callbackRef;
static id monitor;
static NSView *rootView;
static NSWindow *labWindow;
static std::map<std::string, NSView *> tagged;
static bool probeEvent=false;

static napi_value str(napi_env env, const char *text) {napi_value v;napi_create_string_utf8(env,text,NAPI_AUTO_LENGTH,&v);return v;}
static void prop(napi_env env,napi_value object,const char *key,napi_value value){napi_set_named_property(env,object,key,value);}
static void number(napi_env env,napi_value object,const char *key,double value){napi_value v;napi_create_double(env,value,&v);prop(env,object,key,v);}
static std::string ownerFor(NSResponder *target) {
  if(![target isKindOfClass:[NSView class]])return "unknown";
  NSView *view=(NSView *)target;
  for(NSView *cursor=view;cursor;cursor=cursor.superview)for(const auto& item:tagged)if(cursor==item.second)return item.first;
  return "unknown";
}
static napi_value install(napi_env env,napi_callback_info info) {
  size_t count=2;napi_value args[2];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  void *data;size_t bytes;napi_get_buffer_info(env,args[0],&data,&bytes);
  if(bytes!=sizeof(void*)){napi_throw_error(env,nullptr,"invalid NSView handle");return nullptr;}
  rootView=(__bridge NSView *)(*(void **)data);labWindow=rootView.window;envRef=env;
  if(!labWindow||![NSThread isMainThread]){napi_throw_error(env,nullptr,"native monitor requires live window on main thread");return nullptr;}
  napi_create_reference(env,args[1],1,&callbackRef);
  NSEventMask mask=NSEventMaskLeftMouseDown|NSEventMaskRightMouseDown|NSEventMaskOtherMouseDown|NSEventMaskKeyDown;
  monitor=[NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    if(event.window!=labWindow)return event;
    NSView *content=labWindow.contentView;
    NSPoint point=[content convertPoint:event.locationInWindow fromView:nil];
    bool keyboard=event.type==NSEventTypeKeyDown;
    if(!keyboard&&!NSPointInRect(point,content.bounds))return event;
    NSResponder *receiver=keyboard?labWindow.firstResponder:[content hitTest:point];
    std::string owner=ownerFor(receiver);
    napi_handle_scope scope;napi_open_handle_scope(envRef,&scope);
    napi_value row;napi_create_object(envRef,&row);
    prop(envRef,row,"owner",str(envRef,owner.c_str()));
    prop(envRef,row,"type",str(envRef,keyboard?"keyDown":"mouseDown"));
    prop(envRef,row,"receiverClass",str(envRef,NSStringFromClass([receiver class]).UTF8String?:""));
    number(envRef,row,"x",point.x);number(envRef,row,"y",content.isFlipped?point.y:content.bounds.size.height-point.y);
    number(envRef,row,"timestamp",event.timestamp);number(envRef,row,"eventNumber",keyboard?0:event.eventNumber);
    number(envRef,row,"modifiers",event.modifierFlags);if(keyboard)number(envRef,row,"keyCode",event.keyCode);
    napi_value injected;napi_get_boolean(envRef,probeEvent,&injected);prop(envRef,row,"testInjection",injected);
    napi_value callback,global,result;napi_get_reference_value(envRef,callbackRef,&callback);napi_get_global(envRef,&global);
    napi_call_function(envRef,global,callback,1,&row,&result);
    napi_close_handle_scope(envRef,scope);
    return event;
  }];
  return str(env,"installed");
}
static napi_value tag(napi_env env,napi_callback_info info) {
  size_t count=3;napi_value args[3];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  char label[80];size_t length;double x,y;napi_get_value_string_utf8(env,args[0],label,sizeof(label),&length);napi_get_value_double(env,args[1],&x);napi_get_value_double(env,args[2],&y);
  NSView *content=labWindow.contentView;NSPoint point=NSMakePoint(x,content.isFlipped?y:content.bounds.size.height-y);
  NSView *view=[content hitTest:point];if(!view){napi_throw_error(env,nullptr,"native view not found");return nullptr;}
  for(const auto& item:tagged)if(item.first!=label&&item.second==view){napi_throw_error(env,nullptr,"native view label collision");return nullptr;}
  tagged[label]=view;return str(env,NSStringFromClass([view class]).UTF8String);
}
static napi_value injectProbe(napi_env env,napi_callback_info info) {
  size_t count=2;napi_value args[2];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);double x,y;napi_get_value_double(env,args[0],&x);napi_get_value_double(env,args[1],&y);
  NSView *content=labWindow.contentView;NSPoint point=NSMakePoint(x,content.isFlipped?y:content.bounds.size.height-y);point=[content convertPoint:point toView:nil];
  NSEvent *event=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:labWindow.windowNumber context:nil eventNumber:9901 clickCount:1 pressure:1];
  probeEvent=true;[NSApp sendEvent:event];probeEvent=false;
  NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:labWindow.windowNumber context:nil eventNumber:9902 clickCount:1 pressure:0];[NSApp sendEvent:up];
  return str(env,"test-injected");
}
static napi_value injectKeyProbe(napi_env env,napi_callback_info info) {
  NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:labWindow.windowNumber context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
  probeEvent=true;[NSApp sendEvent:event];probeEvent=false;
  NSEvent *up=[NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:labWindow.windowNumber context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];[NSApp sendEvent:up];
  return str(env,"test-key-injected");
}
// 明确的诊断输出：只描述本实验窗口中的命中和焦点祖先，不读取其它应用。
static napi_value describe(napi_env env,napi_callback_info info) {
  size_t count=2;napi_value args[2];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);double x=0,y=0;
  if(count==2){napi_get_value_double(env,args[0],&x);napi_get_value_double(env,args[1],&y);}
  NSView *content=labWindow.contentView;
  NSResponder *receiver=count==2?[content hitTest:NSMakePoint(x,content.isFlipped?y:content.bounds.size.height-y)]:labWindow.firstResponder;
  napi_value result,chain;napi_create_object(env,&result);napi_create_array(env,&chain);
  prop(env,result,"owner",str(env,ownerFor(receiver).c_str()));
  uint32_t index=0;
  if([receiver isKindOfClass:[NSView class]])for(NSView *v=(NSView *)receiver;v;v=v.superview){
    napi_value row;napi_create_object(env,&row);
    prop(env,row,"identity",str(env,[[NSString stringWithFormat:@"%p",v] UTF8String]));
    prop(env,row,"class",str(env,NSStringFromClass([v class]).UTF8String));
    NSRect rect=[v convertRect:v.bounds toView:content];
    number(env,row,"x",rect.origin.x);number(env,row,"y",content.isFlipped?rect.origin.y:content.bounds.size.height-NSMaxY(rect));
    number(env,row,"width",rect.size.width);number(env,row,"height",rect.size.height);
    napi_set_element(env,chain,index++,row);
  }
  prop(env,result,"chain",chain);return result;
}
static napi_value stop(napi_env env,napi_callback_info info) {if(monitor){[NSEvent removeMonitor:monitor];monitor=nil;}tagged.clear();if(callbackRef){napi_delete_reference(env,callbackRef);callbackRef=nullptr;}return str(env,"stopped");}
static napi_value init(napi_env env,napi_value exports) {
  napi_property_descriptor methods[]={{"install",0,install,0,0,0,napi_default,0},{"tag",0,tag,0,0,0,napi_default,0},{"injectProbe",0,injectProbe,0,0,0,napi_default,0},{"injectKeyProbe",0,injectKeyProbe,0,0,0,napi_default,0},{"stop",0,stop,0,0,0,napi_default,0},{"describe",0,describe,0,0,0,napi_default,0}};
  napi_define_properties(env,exports,6,methods);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
