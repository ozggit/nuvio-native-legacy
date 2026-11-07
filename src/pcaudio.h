#ifndef NV_PCAUDIO_H
#define NV_PCAUDIO_H
#include <stddef.h>

/* Opt-in, movie/episode only. Main-thread calls; networking uses one worker.
 * Pairing is stored only in pcaudio-local.txt, outside account/cloud settings. */
int pcaudio_configurar(const char *pairing);
const char *pcaudio_servidor(void); /* address only, never pairing token */
int pcaudio_configurado(void);
void pcaudio_armar(int movie);
int pcaudio_consumir(void);
int pcaudio_iniciar(const char *url, const char *headers, double start);
int pcaudio_buscar(double seconds);
void pcaudio_parar(void);
void pcaudio_falhar(const char *message);
int pcaudio_ativo(void); /* pending, converted, or error: suppress source fallback */
int pcaudio_pendente(void);
typedef struct {
  int pc; /* 0 = supported source, play original; 1 = copied video + PC audio */
  double duration, start;
  char url[4096], error[192];
} PcAudioResult;
int pcaudio_receber(PcAudioResult *result);
#endif
