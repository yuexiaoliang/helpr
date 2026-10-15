#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static volatile sig_atomic_t stopping;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static int info(pid_t pid, struct proc_bsdinfo *out) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, sizeof(*out)) == sizeof(*out);
}
/* 先建立独立监督，再创建宿主。安装目标只能是同包的固定宿主映像。 */
int main(int argc, char **argv) {
    const pid_t owner_pid = getppid(), group = getpgrp();
    if (owner_pid <= 1 || group != getpid()) return 1;
    int target_index = 1;
    const int pause_before_exec = argc > 1 && strcmp(argv[1], "--pause-before-exec") == 0;
    if (pause_before_exec) target_index++;
    if (argc <= target_index) return 1;
    struct proc_bsdinfo owner, current;
    char owner_file[PROC_PIDPATHINFO_MAXSIZE], target_file[PROC_PIDPATHINFO_MAXSIZE];
    if (!info(owner_pid, &owner) || owner.pbi_uid != getuid() ||
        proc_pidpath(owner_pid, owner_file, sizeof(owner_file)) <= 0 ||
        !realpath(argv[target_index], target_file)) return 1;
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
        close(6);
        if (pause_before_exec) raise(SIGSTOP);
        execv(target_file, &argv[target_index]);
        _exit(1);
    }
    if (dprintf(6, "%d\n", child) < 0) stopping = 1;
    close(3); close(4); close(5);
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000 };
    for (;;) {
        int status = 0;
        const int child_exited = waitpid(child, &status, WNOHANG) == child;
        if (child_exited)
            dprintf(6, "exit:%d:%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
        if (stopping || getppid() != owner_pid ||
            !info(owner_pid, &current) || current.pbi_uid != owner.pbi_uid ||
            current.pbi_start_tvsec != owner.pbi_start_tvsec ||
            current.pbi_start_tvusec != owner.pbi_start_tvusec ||
            child_exited) {
            kill(-group, SIGKILL);
            return 0;
        }
        nanosleep(&pause, NULL);
    }
}
