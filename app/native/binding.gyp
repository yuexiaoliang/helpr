{
  "targets": [{
    "target_name": "input_bridge",
    "sources": ["input-bridge.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "14.0",
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
      "OTHER_CFLAGS": ["-Wall", "-Wextra", "-Werror"]
    },
    "link_settings": { "libraries": ["-framework Cocoa"] }
  }]
}
