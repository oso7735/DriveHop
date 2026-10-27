/* DriveHop offline installer payload.
 *
 * Send DriveHop-Installer.elf to a PS5 ELF loader on port 9021. The complete
 * application is embedded in the ELF. Files are written to a staging folder,
 * checked by size and CRC-32, chmodded to 0777, and atomically swapped into
 * /data/homebrew/PPSA99777. A failed update restores the previous folder.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef DRIVEHOP_VERSION
#define DRIVEHOP_VERSION "development"
#endif

#define INSTALL_ROOT "/data/homebrew/PPSA99777"
#define STAGING_ROOT "/data/homebrew/.PPSA99777.drivehop-installing"
#define BACKUP_ROOT "/data/homebrew/.PPSA99777.drivehop-backup"
#define LOG_DIR "/data/drivehop"
#define LOG_FILE LOG_DIR "/installer.log"
#define PATH_LIMIT 1024
#define FLAG_STORED 1u

extern const unsigned char drivehop_payload[];
extern const unsigned char drivehop_payload_end[];
extern int sceKernelSendNotificationRequest(int, void *, size_t, int);

typedef struct __attribute__((packed)) {
    unsigned char unused[45];
    char message[3075];
} notification_request_t;

typedef struct {
    const unsigned char *cursor;
    const unsigned char *end;
    uint32_t count;
} archive_reader_t;

typedef struct {
    char path[PATH_LIMIT];
    uint16_t flags;
    uint64_t raw_size;
    uint64_t packed_size;
    uint32_t crc;
    const unsigned char *data;
} archive_entry_t;

static void notify(const char *format, ...)
{
    notification_request_t request;
    va_list args;
    memset(&request, 0, sizeof(request));
    va_start(args, format);
    vsnprintf(request.message, sizeof(request.message), format, args);
    va_end(args);
    sceKernelSendNotificationRequest(0, &request, sizeof(request), 0);
}

static void make_directory(const char *path)
{
    if (mkdir(path, 0777) != 0 && errno != EEXIST)
        return;
    chmod(path, 0777);
}

static void log_line(const char *format, ...)
{
    make_directory(LOG_DIR);
    FILE *file = fopen(LOG_FILE, "a");
    if (!file)
        return;
    va_list args;
    va_start(args, format);
    vfprintf(file, format, args);
    va_end(args);
    fputc('\n', file);
    fclose(file);
    chmod(LOG_FILE, 0777);
}

static bool path_exists(const char *path)
{
    struct stat info;
    return stat(path, &info) == 0;
}

static bool remove_tree(const char *path)
{
    struct stat info;
    if (stat(path, &info) != 0)
        return errno == ENOENT;
    if (!S_ISDIR(info.st_mode))
        return unlink(path) == 0;
    DIR *directory = opendir(path);
    if (!directory)
        return false;
    bool ok = true;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
            continue;
        char child[PATH_LIMIT];
        const int length = snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        if (length < 0 || (size_t)length >= sizeof(child) || !remove_tree(child))
            ok = false;
    }
    closedir(directory);
    return ok && rmdir(path) == 0;
}

static bool chmod_tree(const char *path)
{
    struct stat info;
    if (stat(path, &info) != 0 || chmod(path, 0777) != 0)
        return false;
    if (!S_ISDIR(info.st_mode))
        return true;
    DIR *directory = opendir(path);
    if (!directory)
        return false;
    bool ok = true;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
            continue;
        char child[PATH_LIMIT];
        const int length = snprintf(child, sizeof(child), "%s/%s", path, entry->d_name);
        if (length < 0 || (size_t)length >= sizeof(child) || !chmod_tree(child))
            ok = false;
    }
    closedir(directory);
    return ok;
}

static bool make_parent_directories(const char *path)
{
    char copy[PATH_LIMIT];
    const size_t length = strlen(path);
    if (length >= sizeof(copy))
        return false;
    memcpy(copy, path, length + 1);
    for (char *cursor = copy + 1; *cursor; ++cursor) {
        if (*cursor != '/')
            continue;
        *cursor = '\0';
        if (mkdir(copy, 0777) != 0 && errno != EEXIST)
            return false;
        if (chmod(copy, 0777) != 0)
            return false;
        *cursor = '/';
    }
    return true;
}

static uint16_t read_u16(const unsigned char *p)
{
    return (uint16_t)p[0] | (uint16_t)((uint16_t)p[1] << 8);
}

static uint32_t read_u32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t read_u64(const unsigned char *p)
{
    return (uint64_t)read_u32(p) | ((uint64_t)read_u32(p + 4) << 32);
}

static bool archive_open(archive_reader_t *reader)
{
    const size_t size = (size_t)(drivehop_payload_end - drivehop_payload);
    if (size < 16 || memcmp(drivehop_payload, "DHIPACK1", 8) != 0 || read_u32(drivehop_payload + 8) != 1)
        return false;
    reader->cursor = drivehop_payload + 16;
    reader->end = drivehop_payload_end;
    reader->count = read_u32(drivehop_payload + 12);
    return reader->count > 0 && reader->count < 4096;
}

static bool safe_relative_path(const char *path)
{
    if (!path[0] || path[0] == '/' || strchr(path, '\\') || strchr(path, ':'))
        return false;
    const char *part = path;
    while (*part) {
        const char *slash = strchr(part, '/');
        const size_t length = slash ? (size_t)(slash - part) : strlen(part);
        if (!length || (length == 1 && part[0] == '.') || (length == 2 && part[0] == '.' && part[1] == '.'))
            return false;
        if (!slash)
            break;
        part = slash + 1;
    }
    return true;
}

static bool archive_next(archive_reader_t *reader, archive_entry_t *entry)
{
    if ((size_t)(reader->end - reader->cursor) < 24)
        return false;
    const unsigned char *header = reader->cursor;
    const uint16_t path_length = read_u16(header);
    entry->flags = read_u16(header + 2);
    entry->raw_size = read_u64(header + 4);
    entry->packed_size = read_u64(header + 12);
    entry->crc = read_u32(header + 20);
    reader->cursor += 24;
    if (!path_length || path_length >= sizeof(entry->path) || entry->packed_size > (uint64_t)(reader->end - reader->cursor) ||
        path_length > (size_t)(reader->end - reader->cursor))
        return false;
    memcpy(entry->path, reader->cursor, path_length);
    entry->path[path_length] = '\0';
    reader->cursor += path_length;
    if (!safe_relative_path(entry->path) || entry->packed_size > (uint64_t)(reader->end - reader->cursor))
        return false;
    entry->data = reader->cursor;
    reader->cursor += (size_t)entry->packed_size;
    return true;
}

static uint32_t crc32_bytes(const unsigned char *data, size_t size)
{
    static uint32_t table[256];
    static bool ready = false;
    if (!ready) {
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t value = i;
            for (unsigned bit = 0; bit < 8; ++bit)
                value = (value & 1) ? 0xedb88320u ^ (value >> 1) : value >> 1;
            table[i] = value;
        }
        ready = true;
    }
    uint32_t value = 0xffffffffu;
    for (size_t i = 0; i < size; ++i)
        value = table[(value ^ data[i]) & 0xffu] ^ (value >> 8);
    return value ^ 0xffffffffu;
}

static bool lz4_decompress(const unsigned char *source, size_t source_size, unsigned char *output, size_t output_size)
{
    const unsigned char *input = source;
    const unsigned char *input_end = source + source_size;
    unsigned char *destination = output;
    unsigned char *destination_end = output + output_size;
    while (input < input_end) {
        const unsigned token = *input++;
        size_t literals = token >> 4;
        if (literals == 15) {
            unsigned extension;
            do {
                if (input >= input_end)
                    return false;
                extension = *input++;
                if (literals > SIZE_MAX - extension)
                    return false;
                literals += extension;
            } while (extension == 255);
        }
        if (literals > (size_t)(input_end - input) || literals > (size_t)(destination_end - destination))
            return false;
        memcpy(destination, input, literals);
        input += literals;
        destination += literals;
        if (input == input_end)
            return destination == destination_end;
        if ((size_t)(input_end - input) < 2)
            return false;
        const size_t offset = (size_t)input[0] | ((size_t)input[1] << 8);
        input += 2;
        if (!offset || offset > (size_t)(destination - output))
            return false;
        size_t match = (token & 15u) + 4u;
        if ((token & 15u) == 15u) {
            unsigned extension;
            do {
                if (input >= input_end)
                    return false;
                extension = *input++;
                if (match > SIZE_MAX - extension)
                    return false;
                match += extension;
            } while (extension == 255);
        }
        if (match > (size_t)(destination_end - destination))
            return false;
        unsigned char *match_source = destination - offset;
        for (size_t i = 0; i < match; ++i)
            destination[i] = match_source[i];
        destination += match;
    }
    return destination == destination_end;
}

static bool write_all(int file, const unsigned char *data, size_t size)
{
    size_t written = 0;
    while (written < size) {
        const ssize_t amount = write(file, data + written, size - written);
        if (amount < 0 && errno == EINTR)
            continue;
        if (amount <= 0)
            return false;
        written += (size_t)amount;
    }
    return true;
}

static bool file_matches(const char *path, uint64_t expected_size, uint32_t expected_crc)
{
    int file = open(path, O_RDONLY);
    if (file < 0)
        return false;
    uint32_t table[256];
    for (uint32_t i = 0; i < 256; ++i) {
        uint32_t value = i;
        for (unsigned bit = 0; bit < 8; ++bit)
            value = (value & 1) ? 0xedb88320u ^ (value >> 1) : value >> 1;
        table[i] = value;
    }
    uint32_t crc = 0xffffffffu;
    uint64_t total = 0;
    unsigned char buffer[65536];
    for (;;) {
        const ssize_t amount = read(file, buffer, sizeof(buffer));
        if (amount < 0 && errno == EINTR)
            continue;
        if (amount < 0) {
            close(file);
            return false;
        }
        if (!amount)
            break;
        total += (uint64_t)amount;
        for (ssize_t i = 0; i < amount; ++i)
            crc = table[(crc ^ buffer[i]) & 0xffu] ^ (crc >> 8);
    }
    close(file);
    return total == expected_size && (crc ^ 0xffffffffu) == expected_crc;
}

static bool unpack_archive(const char *root)
{
    archive_reader_t reader;
    if (!archive_open(&reader))
        return false;
    make_directory(root);
    for (uint32_t index = 0; index < reader.count; ++index) {
        archive_entry_t entry;
        if (!archive_next(&reader, &entry) || entry.raw_size > SIZE_MAX || entry.packed_size > SIZE_MAX)
            return false;
        char destination[PATH_LIMIT];
        const int length = snprintf(destination, sizeof(destination), "%s/%s", root, entry.path);
        if (length < 0 || (size_t)length >= sizeof(destination) || !make_parent_directories(destination))
            return false;
        unsigned char *raw = NULL;
        const unsigned char *bytes = entry.data;
        if (!(entry.flags & FLAG_STORED) && entry.raw_size) {
            raw = malloc((size_t)entry.raw_size);
            if (!raw || !lz4_decompress(entry.data, (size_t)entry.packed_size, raw, (size_t)entry.raw_size)) {
                free(raw);
                return false;
            }
            bytes = raw;
        } else if (entry.packed_size != entry.raw_size) {
            return false;
        }
        const bool memory_ok = crc32_bytes(bytes, (size_t)entry.raw_size) == entry.crc;
        int file = memory_ok ? open(destination, O_WRONLY | O_CREAT | O_TRUNC, 0777) : -1;
        bool ok = file >= 0 && write_all(file, bytes, (size_t)entry.raw_size) && fsync(file) == 0 && fchmod(file, 0777) == 0;
        if (file >= 0 && close(file) != 0)
            ok = false;
        free(raw);
        if (!ok || !file_matches(destination, entry.raw_size, entry.crc))
            return false;
        log_line("staged %u/%u %s", index + 1, reader.count, entry.path);
    }
    return reader.cursor == reader.end;
}

static bool verify_archive(const char *root)
{
    archive_reader_t reader;
    if (!archive_open(&reader))
        return false;
    for (uint32_t index = 0; index < reader.count; ++index) {
        archive_entry_t entry;
        char path[PATH_LIMIT];
        if (!archive_next(&reader, &entry))
            return false;
        const int length = snprintf(path, sizeof(path), "%s/%s", root, entry.path);
        if (length < 0 || (size_t)length >= sizeof(path) || !file_matches(path, entry.raw_size, entry.crc))
            return false;
    }
    return reader.cursor == reader.end;
}

static bool shadowmount_rescan(void)
{
    const char body[] = "{\"reset_attempts\":true}";
    char request[512];
    const int request_length = snprintf(request, sizeof(request),
        "POST /api/v1/scan HTTP/1.1\r\nHost: 127.0.0.1:10101\r\nContent-Type: application/json\r\n"
        "Content-Length: %zu\r\nConnection: close\r\n\r\n%s", strlen(body), body);
    if (request_length <= 0 || (size_t)request_length >= sizeof(request))
        return false;
    int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd < 0)
        return false;
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(10101);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bool ok = connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) == 0 &&
              write_all(socket_fd, (const unsigned char *)request, (size_t)request_length);
    char response[256] = {0};
    if (ok)
        ok = recv(socket_fd, response, sizeof(response) - 1, 0) > 0 && !strncmp(response, "HTTP/", 5);
    close(socket_fd);
    return ok;
}

static bool install(void)
{
    log_line("DriveHop installer %s started", DRIVEHOP_VERSION);
    if ((!remove_tree(STAGING_ROOT) && path_exists(STAGING_ROOT)) ||
        (!remove_tree(BACKUP_ROOT) && path_exists(BACKUP_ROOT))) {
        log_line("could not clear an old staging or backup folder (errno %d)", errno);
        return false;
    }
    if (!unpack_archive(STAGING_ROOT) || !chmod_tree(STAGING_ROOT)) {
        log_line("staging or permission verification failed (errno %d)", errno);
        remove_tree(STAGING_ROOT);
        return false;
    }

    const bool had_previous = path_exists(INSTALL_ROOT);
    if (had_previous && rename(INSTALL_ROOT, BACKUP_ROOT) != 0) {
        log_line("could not preserve the old installation (errno %d)", errno);
        remove_tree(STAGING_ROOT);
        return false;
    }
    if (rename(STAGING_ROOT, INSTALL_ROOT) != 0) {
        const int saved_errno = errno;
        if (had_previous)
            rename(BACKUP_ROOT, INSTALL_ROOT);
        log_line("could not activate the staged installation (errno %d)", saved_errno);
        remove_tree(STAGING_ROOT);
        return false;
    }
    if (!chmod_tree(INSTALL_ROOT) || !verify_archive(INSTALL_ROOT)) {
        log_line("installed-file verification failed; restoring the old version");
        remove_tree(INSTALL_ROOT);
        if (had_previous)
            rename(BACKUP_ROOT, INSTALL_ROOT);
        return false;
    }
    if (had_previous)
        remove_tree(BACKUP_ROOT);
    sync();
    log_line("DriveHop %s installed and verified", DRIVEHOP_VERSION);
    return true;
}

int main(void)
{
    notify("Installing DriveHop %s...", DRIVEHOP_VERSION);
    if (!install()) {
        notify("DriveHop installation failed. The previous version was kept. See %s", LOG_FILE);
        return 1;
    }
    if (shadowmount_rescan())
        notify("DriveHop %s installed. It will appear on the home screen shortly.", DRIVEHOP_VERSION);
    else
        notify("DriveHop %s installed. Start ShadowMountPlus to add it to the home screen.", DRIVEHOP_VERSION);
    return 0;
}
