/* DriveHop offline installer payload archive. */
    .section .rodata
    .balign 16
    .global drivehop_payload
    .global drivehop_payload_end
drivehop_payload:
    .incbin DRIVEHOP_PAYLOAD_PATH
drivehop_payload_end:
    .section .note.GNU-stack,"",@progbits
