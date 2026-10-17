#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/proc.h>

static volatile sig_atomic_t stopping;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static int info(pid_t pid, struct proc_bsdinfo *out) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, sizeof(*out)) == sizeof(*out);
}
/* 不以消息或超时证明清理：独立监督持有租约，直到两个自有运行组实际清空。 */
static int group_members(pid_t group, pid_t exclude) {
    const int capacity = proc_listallpids(NULL, 0) + 256;
    if (capacity <= 256) return -1;
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return -1;
    const int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    int found = 0;
    for (int i = 0; i < count; i++) {
        const pid_t pid = pids[i];
        if (pid > 1 && pid != exclude && getpgid(pid) == group) {
            struct proc_bsdinfo current;
            if (!info(pid, &current) || current.pbi_uid != getuid()) { found = -1; break; }
            if (current.pbi_status != SZOMB) found++;
        }
    }
    free(pids); return count < 0 || count >= capacity ? -1 : found;
}
/* 先建立独立监督，再创建宿主。安装目标只能是同包的固定宿主映像。 */
int main(int argc, char **argv) {
    const pid_t owner_pid = getppid(), group = getpgrp();
    if (owner_pid <= 1 || group != getpid()) return 1;
    int target_index = 1;
    const int runtime = argc > 1 && strcmp(argv[1], "--runtime-owner") == 0;
    if (runtime) target_index++;
    const int pause_before_exec = argc > target_index && strcmp(argv[target_index], "--pause-before-exec") == 0;
    if (pause_before_exec) target_index++;
    if (argc <= target_index) return 1;
    struct proc_bsdinfo owner, current;
    char owner_file[PROC_PIDPATHINFO_MAXSIZE], target_file[PROC_PIDPATHINFO_MAXSIZE];
    if (!info(owner_pid, &owner) || owner.pbi_uid != getuid() ||
        proc_pidpath(owner_pid, owner_file, sizeof(owner_file)) <= 0 ||
        !realpath(argv[target_index], target_file)) return 1;
    if (runtime) {
        struct stat lease;
        if (getpgid(owner_pid) != owner_pid || fstat(7, &lease) || !S_ISREG(lease.st_mode) || lease.st_uid != getuid() || (lease.st_mode & 0777) != 0600 || lease.st_nlink != 1) return 1;
    }
    if (strcmp(owner_file, target_file) != 0) {
        const char *suffix = "/Contents/MacOS/helpr";
        const size_t owner_length = strlen(owner_file), suffix_length = strlen(suffix);
        char expected[PROC_PIDPATHINFO_MAXSIZE], resolved[PROC_PIDPATHINFO_MAXSIZE];
        if (owner_length <= suffix_length ||
            strcmp(owner_file + owner_length - suffix_length, suffix) != 0) return 1;
        const int length = snprintf(expected, sizeof(expected), "%.*s/Contents/Frameworks/helpr Workspace.app/Contents/MacOS/helpr Workspace Helper", (int)(owner_length - suffix_length), owner_file);
        if (length < 0 || (size_t)length >= sizeof(expected) ||
            !realpath(expected, resolved) || strcmp(target_file, resolved) != 0) return 1;
    }
    signal(SIGTERM, stop);
    signal(SIGINT, stop);
    signal(SIGHUP, stop);
    signal(SIGPIPE, SIG_IGN);
    const pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
        if (runtime && setpgid(0, 0) != 0) _exit(1);
        close(6);
        if (runtime) close(7);
        if (pause_before_exec) raise(SIGSTOP);
        execv(target_file, &argv[target_index]);
        _exit(1);
    }
    if (dprintf(6, "%d\n", child) < 0) stopping = 1;
    close(3); close(4); close(5);
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000 };
    int exited = 0;
    int host_cleared = 0;
    for (;;) {
        int status = 0;
        int child_exited = 0, code = -1, signal_number = 0;
        if (runtime && !exited) {
            siginfo_t ended; memset(&ended, 0, sizeof(ended));
            if (waitid(P_PID, (id_t)child, &ended, WEXITED | WNOHANG | WNOWAIT) == 0 && ended.si_pid == child) {
                child_exited = 1;
                if (ended.si_code == CLD_EXITED) code = ended.si_status;
                else signal_number = ended.si_status;
            }
        } else if (!runtime && !exited && waitpid(child, &status, WNOHANG) == child) {
            child_exited = 1; code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            signal_number = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
        }
        if (child_exited) {
            exited = 1;
            dprintf(6, "exit:%d:%d\n", code, signal_number);
        }
        const int owner_gone = getppid() != owner_pid ||
            !info(owner_pid, &current) || current.pbi_uid != owner.pbi_uid ||
            current.pbi_start_tvsec != owner.pbi_start_tvsec ||
            current.pbi_start_tvusec != owner.pbi_start_tvusec;
        if (runtime && (stopping || exited || owner_gone)) {
            if (!host_cleared) {
                kill(-child, SIGKILL);
                if (group_members(child, 0) == 0) { host_cleared = 1; waitpid(child, &status, WNOHANG); }
            }
            const int owner_left = owner_gone ? group_members(owner_pid, 0) : -1;
            if (owner_left > 0) kill(-owner_pid, SIGKILL);
            if (owner_gone && host_cleared && owner_left == 0) return 0;
        } else if (stopping || owner_gone || exited) {
            kill(-group, SIGKILL);
            return 0;
        }
        nanosleep(&pause, NULL);
    }
}
