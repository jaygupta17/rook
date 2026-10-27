/* A container whose seccomp profile denies user namespace creation, which is
 * what Docker's default profile does to browsers on older kernels and what
 * Ubuntu 23.10+ does to unconfined binaries through AppArmor: unshare(2)
 * returns EPERM. sandbox-probe.sh compiles this and runs the host under it, so
 * the fallback decision and its warning are exercised on a machine where user
 * namespaces actually work.
 *
 * usage: deny-unshare <program> [args...]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdint.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: deny-unshare <program> [args...]\n");
    return 2;
  }

  /* Deny the two calls that could create or enter a namespace, allow the rest. */
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)__NR_unshare, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)__NR_setns, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
      .filter = filter,
  };

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("deny-unshare: PR_SET_NO_NEW_PRIVS");
    return 1;
  }
  if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0) {
    perror("deny-unshare: seccomp");
    return 1;
  }
  execvp(argv[1], &argv[1]);
  perror("deny-unshare: execvp");
  return 1;
}
