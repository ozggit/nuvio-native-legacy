#ifndef NV_PCPAIR_H
#define NV_PCPAIR_H
#include <stddef.h>
/* Main-thread API; UDP discovery and PIN exchange run on one background worker. */
int pcpair_iniciar(const char *code);
void pcpair_cancelar(void);
int pcpair_pendente(void);
int pcpair_receber(char *pairing, size_t pairing_size, char *error, size_t error_size);
#endif
