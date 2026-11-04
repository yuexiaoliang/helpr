#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// 独立进程只查SQLite PENDING_BYTE上的冲突锁，不取得锁、不读取库内容。
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char resolved[4096], prefix[128];
  snprintf(prefix, sizeof(prefix), "/private/tmp/helpr-workspace-validation-%u/upgrade09-offline-", getuid());
  if (!realpath(argv[1], resolved) || strncmp(resolved, prefix, strlen(prefix))) return 3;
  int fd = open(resolved, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 4;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid()) return 5;
  struct flock lock = {0};
  lock.l_start = 0x40000000;
  lock.l_len = 1;
  lock.l_whence = SEEK_SET;
  lock.l_type = F_RDLCK;
  if (fcntl(fd, F_GETLK, &lock) < 0) return 6;
  close(fd);
  printf("{\"writer\":%s,\"pid\":%d,\"start\":%lld,\"length\":%lld}\n",
    lock.l_type == F_WRLCK ? "true" : "false", lock.l_pid, lock.l_start, lock.l_len);
  return 0;
}
