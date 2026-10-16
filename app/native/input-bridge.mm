#include <node_api.h>
#import <Cocoa/Cocoa.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <cmath>
#include <cerrno>
#include <map>
#include <string>

// 仅本应用的控制和网页宿主使用。文件是临时同步设施，不保存业务事实或输入内容。
struct Slot { char task[101]; uint64_t epoch; bool blocked; };
struct Shared { uint64_t magic; bool available; uint64_t serial; Slot slots[4096]; };
static constexpr uint64_t MAGIC = 0x48454c5052494e34;
static int gateFd = -1;
static Shared *gate = nullptr;
struct Lock {
  bool held;
  Lock() : held(false) {
    if (gateFd < 0) return;
    int result;
    do { result = flock(gateFd, LOCK_EX); } while (result != 0 && errno == EINTR);
    held = result == 0;
  }
  ~Lock() { if (held) flock(gateFd, LOCK_UN); }
};
static napi_value failure(napi_env env, const char *code) {
  napi_throw_error(env, nullptr, code); return nullptr;
}
static bool args(napi_env env, napi_callback_info info, size_t count, napi_value *values) {
  size_t found = count;
  return napi_get_cb_info(env, info, &found, values, nullptr, nullptr) == napi_ok && found == count;
}
static bool text(napi_env env, napi_value value, std::string &out, size_t maximum = 100) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || !length || length > maximum) return false;
  out.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, out.data(), out.size(), &length) != napi_ok) return false;
  out.resize(length); return out.find('\0') == std::string::npos;
}
static napi_value boolean(napi_env env, bool v) { napi_value result; napi_get_boolean(env, v, &result); return result; }
static void setNumber(napi_env env, napi_value object, const char *key, double value) {
  napi_value result; napi_create_double(env, value, &result); napi_set_named_property(env, object, key, result);
}
static void setText(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value result; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result); napi_set_named_property(env, object, key, result);
}
static Slot *slot(const std::string &task) {
  Slot *empty = nullptr;
  for (auto &row : gate->slots) {
    if (!row.task[0]) { if (!empty) empty = &row; }
    else if (task == row.task) return &row;
  }
  if (empty) { memcpy(empty->task, task.c_str(), task.size() + 1); empty->epoch = 1; empty->blocked = true; }
  return empty;
}
static void block(Slot &row) { row.epoch++; row.blocked = true; }
static void blockAll() { for (auto &row : gate->slots) if (row.task[0]) block(row); }
static napi_value openGate(napi_env env, napi_callback_info info) {
  napi_value values[2]; std::string file; bool create;
  if (gate || !args(env, info, 2, values) || !text(env, values[0], file, 4096) || napi_get_value_bool(env, values[1], &create) != napi_ok) return failure(env, "INPUT_GATE_ARGUMENT");
  int fd = open(file.c_str(), O_RDWR | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT | O_EXCL : 0), 0600);
  struct stat st;
  if (fd < 0) return failure(env, "INPUT_GATE_UNAVAILABLE");
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 0777) != 0600 || st.st_nlink != 1 || (create ? ftruncate(fd, sizeof(Shared)) != 0 : st.st_size != sizeof(Shared))) {
    close(fd); return failure(env, "INPUT_GATE_UNAVAILABLE");
  }
  void *memory = mmap(nullptr, sizeof(Shared), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (memory == MAP_FAILED) { close(fd); return failure(env, "INPUT_GATE_UNAVAILABLE"); }
  gateFd = fd; gate = static_cast<Shared *>(memory);
  Lock lock;
  if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  if (create) { memset(gate, 0, sizeof(Shared)); gate->magic = MAGIC; }
  if (gate->magic != MAGIC) return failure(env, "INPUT_GATE_UNAVAILABLE");
  return boolean(env, true);
}
static napi_value state(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string task;
  if (!gate || !args(env, info, 1, values) || !text(env, values[0], task)) return failure(env, "INPUT_GATE_ARGUMENT");
  Lock lock; if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  Slot *row = slot(task); if (!row) return failure(env, "INPUT_GATE_LIMIT");
  napi_value result; napi_create_object(env, &result); setNumber(env, result, "epoch", row->epoch);
  napi_set_named_property(env, result, "available", boolean(env, gate->available));
  napi_set_named_property(env, result, "blocked", boolean(env, row->blocked)); return result;
}
static napi_value trip(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string task;
  if (!gate || !args(env, info, 1, values) || !text(env, values[0], task)) return failure(env, "INPUT_GATE_ARGUMENT");
  Lock lock; if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  if (task == "*") blockAll();
  else { Slot *row = slot(task); if (!row) return failure(env, "INPUT_GATE_LIMIT"); block(*row); }
  return boolean(env, true);
}
static napi_value available(napi_env env, napi_callback_info info) {
  napi_value values[1]; bool value;
  if (!gate || !args(env, info, 1, values) || napi_get_value_bool(env, values[0], &value) != napi_ok) return failure(env, "INPUT_GATE_ARGUMENT");
  Lock lock; if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  if (!value) blockAll(); gate->available = value; return boolean(env, true);
}
static napi_value allow(napi_env env, napi_callback_info info) {
  napi_value values[2]; std::string task; double epoch;
  if (!gate || !args(env, info, 2, values) || !text(env, values[0], task) || napi_get_value_double(env, values[1], &epoch) != napi_ok) return failure(env, "INPUT_GATE_ARGUMENT");
  Lock lock; if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  Slot *row = slot(task); if (!row || !gate->available || row->epoch != epoch) return boolean(env, false);
  row->blocked = false; return boolean(env, true);
}
static napi_value permit(napi_env env, napi_callback_info info) {
  napi_value values[3]; std::string task; double epoch; napi_valuetype type;
  if (!gate || !args(env, info, 3, values) || !text(env, values[0], task) || napi_get_value_double(env, values[1], &epoch) != napi_ok || napi_typeof(env, values[2], &type) != napi_ok || type != napi_function) return failure(env, "INPUT_GATE_ARGUMENT");
  Lock lock; if (!lock.held) return failure(env, "INPUT_GATE_UNAVAILABLE");
  Slot *row = slot(task);
  if (!row || !gate->available || row->blocked || row->epoch != epoch) return failure(env, "INPUT_QUALIFICATION_REVOKED");
  napi_value global, result; napi_get_global(env, &global);
  // 同步回调只把一个包交给私有管道/网络发送入口；绝不持锁等待回执或数据库。
  if (napi_call_function(env, global, values[2], 0, nullptr, &result) != napi_ok) return nullptr;
  return result;
}

static napi_env monitorEnv;
static napi_ref callbackRef;
static id monitor;
static __weak NSView *rootRef;
static __weak NSWindow *windowRef;
struct Tagged { __weak NSView *view; };
static std::map<std::string, Tagged> tagged;
static std::string owner(NSResponder *responder) {
  if (![responder isKindOfClass:[NSView class]]) return "unknown";
  for (NSView *view = (NSView *)responder; view; view = view.superview)
    for (const auto &item : tagged) if (view == item.second.view && view.window == windowRef && !view.hiddenOrHasHiddenAncestor) return item.first;
  return "unknown";
}
static napi_value install(napi_env env, napi_callback_info info) {
  napi_value values[2]; void *data; size_t bytes; napi_valuetype type;
  if (!gate || monitor || !args(env, info, 2, values) || napi_get_buffer_info(env, values[0], &data, &bytes) != napi_ok || bytes != sizeof(void *) || napi_typeof(env, values[1], &type) != napi_ok || type != napi_function || !NSThread.isMainThread) return failure(env, "NATIVE_INPUT_UNAVAILABLE");
  NSView *root = (__bridge NSView *)(*static_cast<void **>(data)); rootRef = root; windowRef = root.window;
  if (!windowRef) return failure(env, "NATIVE_INPUT_UNAVAILABLE");
  monitorEnv = env; napi_create_reference(env, values[1], 1, &callbackRef);
  NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown | NSEventMaskKeyDown;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    windowRef = rootRef.window;
    if (event.window != windowRef) return event;
    NSView *content = windowRef.contentView;
    const bool keyboard = event.type == NSEventTypeKeyDown;
    NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
    if (!keyboard && !NSPointInRect(point, content.bounds)) return event;
    NSResponder *receiver = keyboard ? windowRef.firstResponder : [content hitTest:point];
    const std::string label = owner(receiver);
    if (label.rfind("ui:", 0) == 0) return event;
    uint64_t serial;
    {
      Lock lock;
      if (!lock.held) return event;
      if (label.rfind("web:", 0) == 0) { Slot *row = slot(label.substr(4)); if (row) block(*row); else { gate->available = false; blockAll(); } }
      else blockAll();
      serial = ++gate->serial;
    }
    // 先跨进程撤销资格，再通知 JS，最后才把原事件交回 AppKit；不读取字符或剪贴板。
    napi_handle_scope scope; napi_open_handle_scope(monitorEnv, &scope);
    napi_value callback, global, row, result;
    napi_create_object(monitorEnv, &row); setText(monitorEnv, row, "owner", label.c_str());
    setText(monitorEnv, row, "kind", !keyboard ? "mouse" : ((event.modifierFlags & NSEventModifierFlagCommand) && event.keyCode == 9 ? "paste" : "keyboard"));
    setNumber(monitorEnv, row, "serial", serial);
    napi_get_reference_value(monitorEnv, callbackRef, &callback); napi_get_global(monitorEnv, &global);
    if (napi_call_function(monitorEnv, global, callback, 1, &row, &result) != napi_ok) {
      napi_value exception; napi_get_and_clear_last_exception(monitorEnv, &exception);
      Lock lock; if (lock.held) { gate->available = false; blockAll(); }
    }
    napi_close_handle_scope(monitorEnv, scope); return event;
  }];
  if (!monitor) return failure(env, "NATIVE_INPUT_UNAVAILABLE");
  return boolean(env, true);
}
static napi_value tagRegion(napi_env env, napi_callback_info info) {
  windowRef = rootRef.window;
  napi_value values[7]; std::string label; double n[6];
  if (!windowRef || !NSThread.isMainThread || !args(env, info, 7, values) || !text(env, values[0], label)) return failure(env, "NATIVE_BINDING_UNAVAILABLE");
  for (size_t i = 0; i < 6; i++) if (napi_get_value_double(env, values[i + 1], &n[i]) != napi_ok || !std::isfinite(n[i])) return failure(env, "NATIVE_BINDING_UNAVAILABLE");
  NSView *content = windowRef.contentView;
  NSView *view = [content hitTest:NSMakePoint(n[4], content.isFlipped ? n[5] : content.bounds.size.height - n[5])];
  while (view && view.superview != content) view = view.superview;
  if (!view || view == content || view.window != windowRef || view.hiddenOrHasHiddenAncestor) return failure(env, "NATIVE_BINDING_UNAVAILABLE");
  NSRect rect = [view convertRect:view.bounds toView:content];
  double y = content.isFlipped ? rect.origin.y : content.bounds.size.height - NSMaxY(rect);
  if (fabs(rect.origin.x - n[0]) > 1 || fabs(y - n[1]) > 1 || fabs(rect.size.width - n[2]) > 1 || fabs(rect.size.height - n[3]) > 1) return failure(env, "NATIVE_BINDING_UNAVAILABLE");
  for (const auto &item : tagged) if (item.first != label && item.second.view == view) return failure(env, "NATIVE_BINDING_UNAVAILABLE");
  tagged[label] = {view}; return boolean(env, true);
}
static napi_value untag(napi_env env, napi_callback_info info) {
  napi_value values[1]; std::string label;
  if (!args(env, info, 1, values) || !text(env, values[0], label)) return failure(env, "INPUT_GATE_ARGUMENT");
  tagged.erase(label); return boolean(env, true);
}
static napi_value focused(napi_env env, napi_callback_info) {
  windowRef = rootRef.window;
  const std::string label = owner(windowRef.firstResponder);
  napi_value result; napi_create_string_utf8(env, label.c_str(), label.size(), &result); return result;
}
static void cleanup(void *) {
  if (monitor) { [NSEvent removeMonitor:monitor]; monitor = nil; }
  tagged.clear();
  if (gate) { munmap(gate, sizeof(Shared)); gate = nullptr; }
  if (gateFd >= 0) { close(gateFd); gateFd = -1; }
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"open", 0, openGate, 0, 0, 0, napi_default, 0}, {"state", 0, state, 0, 0, 0, napi_default, 0},
    {"trip", 0, trip, 0, 0, 0, napi_default, 0}, {"available", 0, available, 0, 0, 0, napi_default, 0},
    {"allow", 0, allow, 0, 0, 0, napi_default, 0}, {"permit", 0, permit, 0, 0, 0, napi_default, 0},
    {"install", 0, install, 0, 0, 0, napi_default, 0}, {"tagRegion", 0, tagRegion, 0, 0, 0, napi_default, 0},
    {"untag", 0, untag, 0, 0, 0, napi_default, 0}, {"focused", 0, focused, 0, 0, 0, napi_default, 0},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  napi_add_env_cleanup_hook(env, cleanup, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
