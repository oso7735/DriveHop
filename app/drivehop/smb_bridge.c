// DriveHop bridge: forward one JSON request to the long-running SMB helper and
// put its complete reply in a file the React title can read.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define SMB_PORT 9184
#define REQUEST_MAX 4096
#define REPLY_MAX (512 * 1024)
#define DIR_PATH "/data/drivehop/smb"
#define TMP_PATH DIR_PATH "/reply.json.tmp"
#define OUT_PATH DIR_PATH "/reply.json"

static int send_all(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t sent = send(fd, p, n, 0);
        if (sent < 0 && errno == EINTR) continue;
        if (sent <= 0) return -1;
        p += sent;
        n -= (size_t)sent;
    }
    return 0;
}

int main(void) {
    char request[REQUEST_MAX + 2];
    size_t used = 0, total = 0;
    int sock = -1, out = -1, rc = 1;
    struct sockaddr_in address;
    struct timeval timeout = {10, 0};
    mkdir("/data/drivehop", 0777);
    mkdir(DIR_PATH, 0700);
    while (used < REQUEST_MAX && fgets(request + used, (int)(REQUEST_MAX + 1 - used), stdin)) {
        used = strlen(request);
        if (used && request[used - 1] == '\n') break;
    }
    if (!used) goto done;
    if (request[used - 1] != '\n') request[used++] = '\n';
    request[used] = '\0';
    sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) goto done;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    memset(&address, 0, sizeof address);
    address.sin_family = AF_INET;
    address.sin_port = htons(SMB_PORT);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(sock, (struct sockaddr *)&address, sizeof address) != 0 || send_all(sock, request, used) != 0) goto done;
    out = open(TMP_PATH, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (out < 0) goto done;
    for (;;) {
        char buffer[8192];
        ssize_t got = recv(sock, buffer, sizeof buffer, 0);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) break;
        if (total + (size_t)got > REPLY_MAX) goto done;
        for (ssize_t offset = 0; offset < got;) {
            ssize_t wrote = write(out, buffer + offset, (size_t)(got - offset));
            if (wrote < 0 && errno == EINTR) continue;
            if (wrote <= 0) goto done;
            offset += wrote;
        }
        total += (size_t)got;
        if (memchr(buffer, '\n', (size_t)got)) break;
    }
    if (!total || fsync(out) != 0 || close(out) != 0) { out = -1; goto done; }
    out = -1;
    if (rename(TMP_PATH, OUT_PATH) != 0) goto done;
    chmod(OUT_PATH, 0600);
    rc = 0;
done:
    memset(request, 0, sizeof request);
    if (out >= 0) close(out);
    if (sock >= 0) close(sock);
    if (rc) unlink(TMP_PATH);
    puts(rc ? "error" : "ok");
    fflush(stdout);
    return rc;
}
