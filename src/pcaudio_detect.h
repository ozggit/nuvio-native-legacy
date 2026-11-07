#ifndef NV_PCAUDIO_DETECT_H
#define NV_PCAUDIO_DETECT_H
#include <stdint.h>

typedef struct { uint32_t since; int waiting; } NvPcAudioDetection;
enum { NV_PC_AUDIO_WAIT, NV_PC_AUDIO_KNOWN, NV_PC_AUDIO_INSPECT };

/* sourceInfo can omit every unsupported audio track. Allow late track events
 * three seconds after loadCompleted before asking the PC to inspect the file.
 * An explicit rejection with no codec is enough evidence to inspect sooner.
 * Inspection is not permission to convert: the companion still checks codecs.
 * The caller gates this on opt-in movie playback, with no converter active. */
static inline int nv_pc_audio_detect(NvPcAudioDetection *s, int unsupported,
                                    int hasTrack, int hasCodec, int rejected,
                                    int ready, uint32_t now) {
  if (unsupported) { s->waiting = 0; return NV_PC_AUDIO_KNOWN; }
  if (rejected && !hasCodec) { s->waiting = 0; return NV_PC_AUDIO_INSPECT; }
  if (!ready || hasTrack) { s->waiting = 0; return NV_PC_AUDIO_WAIT; }
  if (!s->waiting) { s->since = now; s->waiting = 1; }
  return (uint32_t)(now - s->since) >= 3000u ? NV_PC_AUDIO_INSPECT : NV_PC_AUDIO_WAIT;
}
#endif
