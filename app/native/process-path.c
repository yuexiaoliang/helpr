#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

/* 只读 OS 进程映像信息；不修改进程，也不读取参数、环境或凭据。 */
int main(int argc, char **argv) {
    const int parent = argc == 3 && strcmp(argv[1], "--parent-of") == 0;
    if (argc != 2 && !parent) return 1;
    char *end;
    long pid = strtol(argv[parent ? 2 : 1], &end, 10);
    if (*end || pid <= 1 || pid > INT_MAX) return 1;
    if (parent) {
        struct proc_bsdinfo info;
        if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 1;
        pid = info.pbi_ppid;
        if (pid <= 1) return 1;
    }
    char file[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath((int)pid, file, sizeof(file)) <= 0) return 1;
    puts(file);
    return 0;
}
