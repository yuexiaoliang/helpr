#import <AppKit/AppKit.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

/* 只读已知自有应用进程的系统角色；不激活窗口，不发送输入。 */
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 4) return 1;
        NSString *bundle = [[NSString stringWithUTF8String:argv[1]] stringByResolvingSymlinksInPath];
        NSMutableArray *roles = [NSMutableArray array];
        for (int i = 2; i < 4; i++) {
            char *end;
            long pid = strtol(argv[i], &end, 10);
            if (*end || pid <= 1 || pid > INT_MAX) return 1;
            struct proc_bsdinfo info;
            if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) return 1;
            NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
            NSString *expected = i == 2 ? bundle : [bundle stringByAppendingPathComponent:@"Contents/Frameworks/helpr Workspace.app"];
            if (!app || ![[app.bundleURL.path stringByResolvingSymlinksInPath] isEqualToString:expected]) return 1;
            [roles addObject:@{ @"role": i == 2 ? @"controller" : @"host", @"pid": @(pid), @"bundleIdentifier": app.bundleIdentifier ?: @"", @"activationPolicy": @(app.activationPolicy) }];
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:roles options:0 error:NULL];
        if (!data) return 1;
        fwrite(data.bytes, 1, data.length, stdout);
        return 0;
    }
}
