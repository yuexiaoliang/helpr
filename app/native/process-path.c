#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

/* 只读 OS 进程映像信息；不修改进程，也不读取参数、环境或凭据。 */
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    char *end;
    long pid = strtol(argv[1], &end, 10);
    if (*end || pid <= 1 || pid > INT_MAX) return 1;
    char file[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath((int)pid, file, sizeof(file)) <= 0) return 1;
    puts(file);
    return 0;
}
