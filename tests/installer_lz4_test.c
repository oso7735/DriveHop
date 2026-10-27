/* Host-side tests for the exact LZ4 decoder compiled into the PS5 installer. */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define main drivehop_installer_main
#include "../installer/installer.c"
#undef main

const unsigned char drivehop_payload[32] = {0};
const unsigned char drivehop_payload_end[] = {0};

int sceKernelSendNotificationRequest(int device, void *request, size_t size, int blocking)
{
    (void)device;
    (void)request;
    (void)size;
    (void)blocking;
    return 0;
}

static void expect_block(const unsigned char *packed, size_t packed_size, const char *expected)
{
    const size_t expected_size = strlen(expected);
    unsigned char output[128] = {0};
    assert(lz4_decompress(packed, packed_size, output, expected_size));
    assert(memcmp(output, expected, expected_size) == 0);
}

int main(void)
{
    const unsigned char literals[] = {0x50, 'h', 'e', 'l', 'l', 'o'};
    const unsigned char repeated[] = {0x11, 'a', 0x01, 0x00};
    const unsigned char patterned[] = {0x44, 'a', 'b', 'c', 'd', 0x04, 0x00};
    const unsigned char long_literals[] = {
        0xf0, 0x05, '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'
    };
    const unsigned char invalid_offset[] = {0x10, 'a', 0x02, 0x00};

    expect_block(literals, sizeof(literals), "hello");
    expect_block(repeated, sizeof(repeated), "aaaaaa");
    expect_block(patterned, sizeof(patterned), "abcdabcdabcd");
    expect_block(long_literals, sizeof(long_literals), "0123456789abcdefghij");
    assert(!lz4_decompress(invalid_offset, sizeof(invalid_offset), (unsigned char[6]){0}, 6));
    puts("DriveHop installer LZ4 tests passed");
    return 0;
}
