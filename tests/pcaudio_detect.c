#include "pcaudio_detect.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  NvPcAudioDetection s = {0};
  /* The reported regression: loaded video, empty audio list, no error 200. */
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 0, 10000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 12000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 14999) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 15000) == NV_PC_AUDIO_INSPECT);
  /* A late AAC/AC-3/E-AC-3 track cancels the pending inspection. */
  assert(nv_pc_audio_detect(&s, 0, 1, 1, 0, 1, 15001) == NV_PC_AUDIO_WAIT);
  assert(!s.waiting);
  assert(nv_pc_audio_detect(&s, 0, 1, 1, 0, 1, 60000) == NV_PC_AUDIO_WAIT);
  /* Even explicit rejection of a known supported codec is not DTS/TrueHD. */
  assert(nv_pc_audio_detect(&s, 0, 1, 1, 1, 1, 61000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 1, 1, 1, 0, 0, 62000) == NV_PC_AUDIO_KNOWN);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 1, 0, 63000) == NV_PC_AUDIO_INSPECT);
  /* A track without a codec, but no rejection, must not be assumed silent. */
  assert(nv_pc_audio_detect(&s, 0, 1, 0, 0, 1, 64000) == NV_PC_AUDIO_WAIT);
  /* Pipeline reload resets the grace period; no stale timeout. */
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 65000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 0, 69000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 70000) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 73000) == NV_PC_AUDIO_INSPECT);
  /* SDL ticks wrap; elapsed time remains correct. */
  s = (NvPcAudioDetection){0};
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, UINT32_MAX-999u) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 1999) == NV_PC_AUDIO_WAIT);
  assert(nv_pc_audio_detect(&s, 0, 0, 0, 0, 1, 2000) == NV_PC_AUDIO_INSPECT);
  puts("PC audio detection: missing/late tracks, codec gating, reload and wrap passed");
  return 0;
}
