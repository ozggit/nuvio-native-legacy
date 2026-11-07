#include "pcaudio.h"
static int armed;
void pcaudio_armar(int movie) { armed = movie; }
int pcaudio_consumir(void) { int yes = armed; armed = 0; return yes; }
#ifdef NV_WEBOS
#include "dados.h"
#include "rede.h"
#include "js.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>

typedef struct {
  unsigned long generation;
  char server[128], token[49], id[33], url[4096], headers[8192];
  double start;
} Request;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static unsigned long generation;
static int workerStarted, pending, active, resultReady, loaded;
static char server[128], token[49];
static Request wanted;
static PcAudioResult result;

static int parsePairing(const char *value, char *host, char *secret) {
  unsigned a,b,c,d,port; int consumed = 0;
  if (!value || sscanf(value, "http://%u.%u.%u.%u:%u#%n", &a,&b,&c,&d,&port,&consumed) != 5 ||
      !consumed || a > 255 || b > 255 || c > 255 || d > 255 || !port || port > 65535 ||
      !(a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31)) ||
      strlen(value + consumed) != 48 || strspn(value + consumed, "0123456789abcdef") != 48) return 0;
  snprintf(host, 128, "http://%u.%u.%u.%u:%u", a,b,c,d,port);
  memcpy(secret, value + consumed, 49); return 1;
}
static void load(void) {
  if (loaded) return;
  loaded = 1;
  char *text = dados_ler("pcaudio-local.txt");
  if (text) { text[strcspn(text,"\r\n")] = 0; parsePairing(text, server, token); free(text); }
}
int pcaudio_configurar(const char *pairing) {
  char address[128] = "", secret[49] = "";
  if (!pairing) return 0;
  if (*pairing && !parsePairing(pairing, address, secret)) return 0;
  if (!dados_gravar("pcaudio-local.txt", pairing)) return 0;
  char file[1024];
  if (dados_caminho(file,sizeof file,"pcaudio-local.txt") && chmod(file,0600)) return 0;
  pcaudio_parar(); loaded = 1;
  memcpy(server,address,sizeof server); memcpy(token,secret,sizeof token); return 1;
}
const char *pcaudio_servidor(void) { load(); return server; }
int pcaudio_configurado(void) { load(); return server[0] && token[0]; }
static int cancelled(void *ptr) {
  Request *r = ptr; int yes;
  pthread_mutex_lock(&lock); yes = r->generation != generation; pthread_mutex_unlock(&lock);
  return yes;
}
static int call(Request *r, const char *method, const char *body, char **text) {
  char url[240], auth[80]; RedeResposta response = {0};
  snprintf(url,sizeof url,"%s/v1/sessions/%s",r->server,r->id);
  snprintf(auth,sizeof auth,"Authorization: Bearer %s",r->token);
  const char *headers[] = { auth, "Content-Type: application/json", NULL };
  int deleting = !strcmp(method,"DELETE");
  RedePedido request = { .metodo = method, .url = url, .cabecalhos = headers,
    .corpo = body, .n_corpo = body ? strlen(body) : 0,
    .prazo_ms = deleting ? 3000 : 10000, .max_bytes = 8192,
    .parar = deleting ? NULL : cancelled, .parar_usuario = r };
  rede_pedir(&request,&response);
  int ok = response.erro == REDE_OK && response.status >= 200 && response.status < 300;
  if (ok && text) { *text = response.corpo; response.corpo = NULL; }
  rede_resposta_limpar(&response); return ok;
}
static int escape(const char *in, char *out, size_t size) {
  char *start = out;
  for (; *in; in++) {
    unsigned c = (unsigned char)*in;
    if ((size_t)(out-start) + 7 >= size) return 0;
    if (c < 32) { snprintf(out,7,"\\u%04x",c); out += 6; }
    else { if (c == '"' || c == '\\') *out++ = '\\'; *out++ = c; }
  }
  *out = 0; return 1;
}
static void publish(Request *r, PcAudioResult *value) {
  pthread_mutex_lock(&lock);
  if (r->generation == generation) { result = *value; resultReady = 1; pending = 0; }
  pthread_mutex_unlock(&lock);
}
static void *worker(void *unused) {
  (void)unused; unsigned long handled = 0;
  Request previous = {0};
  for (;;) {
    pthread_mutex_lock(&lock);
    while (handled == generation) pthread_cond_wait(&wake,&lock);
    Request r = wanted; handled = generation; r.generation = handled;
    pthread_mutex_unlock(&lock);
    // Serialized cleanup prevents an old PUT/DELETE racing a newer selection.
    if (previous.id[0]) { call(&previous,"DELETE",NULL,NULL); memset(&previous,0,sizeof previous); }
    if (!r.url[0] || cancelled(&r)) continue;
    PcAudioResult value = {0};
    char *body = malloc(80000), *url = malloc(25000), *headers = malloc(50000);
    if (!body || !url || !headers || !escape(r.url,url,25000) || !escape(r.headers,headers,50000)) {
      snprintf(value.error,sizeof value.error,"PC audio request is too large.");
    } else {
      snprintf(body,80000,"{\"url\":\"%s\",\"headers\":\"%s\",\"start\":%.3f}",url,headers,r.start);
      previous = r;
      if (!call(&r,"PUT",body,NULL)) snprintf(value.error,sizeof value.error,"PC audio is unavailable. Check pairing and the PC server.");
      else {
        const time_t deadline = time(NULL) + 100;
        while (!cancelled(&r) && time(NULL) < deadline) {
          char *text = NULL, state[24] = "", mode[16] = "", path[256] = "";
          if (!call(&r,"GET",NULL,&text)) {
            snprintf(value.error,sizeof value.error,"PC audio connection failed."); free(text); break;
          }
          js_texto_raiz(text,"state",state,sizeof state);
          if (!strcmp(state,"error")) {
            js_texto_raiz(text,"error",value.error,sizeof value.error);
            if (!value.error[0]) snprintf(value.error,sizeof value.error,"PC could not prepare this audio.");
            free(text); break;
          }
          if (!strcmp(state,"ready")) {
            js_texto_raiz(text,"mode",mode,sizeof mode);
            value.pc = !strcmp(mode,"pc");
            value.audio = (int)js_num(text,NULL,"audioOrdinal",-1);
            value.duration = js_num(text,NULL,"duration",0);
            value.start = js_num(text,NULL,"start",0);
            if (value.pc) {
              js_texto_raiz(text,"path",path,sizeof path);
              char prefix[64]; snprintf(prefix,sizeof prefix,"/v1/media/%s/",r.id);
              if (strncmp(path,prefix,strlen(prefix)) || strspn(path,"/abcdefghijklmnopqrstuvwxyz0123456789.") != strlen(path))
                snprintf(value.error,sizeof value.error,"PC returned an invalid playback address.");
              else snprintf(value.url,sizeof value.url,"%s%s",r.server,path);
            } else if (!strcmp(mode,"direct")) snprintf(value.url,sizeof value.url,"%s",r.url);
            else snprintf(value.error,sizeof value.error,"PC returned an unknown playback mode.");
            if (!isfinite(value.duration) || value.duration <= 0 || !isfinite(value.start) || value.start < 0)
              snprintf(value.error,sizeof value.error,"PC returned an invalid playback timeline.");
            free(text); break;
          }
          free(text);
          struct timespec wait = { .tv_sec = 0, .tv_nsec = 100000000 }; nanosleep(&wait,NULL);
        }
        if (!value.url[0] && !value.error[0]) snprintf(value.error,sizeof value.error,"PC audio preparation timed out.");
      }
    }
    free(body); free(url); free(headers);
    publish(&r,&value);
  }
  return NULL;
}
int pcaudio_iniciar(const char *url, const char *headers, double start) {
  if (!pcaudio_configurado() || !url || !isfinite(start) || start < 0 ||
      strlen(url) >= sizeof wanted.url || (headers && strlen(headers) >= sizeof wanted.headers)) return 0;
  unsigned char entropy[16]; FILE *random = fopen("/dev/urandom","rb");
  if (!random) return 0;
  size_t n = fread(entropy,1,sizeof entropy,random); fclose(random); if (n != sizeof entropy) return 0;
  pthread_mutex_lock(&lock);
  if (!workerStarted) {
    pthread_t thread;
    if (pthread_create(&thread,NULL,worker,NULL)) { pthread_mutex_unlock(&lock); return 0; }
    pthread_detach(thread); workerStarted = 1;
  }
  memset(&wanted,0,sizeof wanted);
  wanted.generation = ++generation; wanted.start = start;
  snprintf(wanted.server,sizeof wanted.server,"%s",server); snprintf(wanted.token,sizeof wanted.token,"%s",token);
  snprintf(wanted.url,sizeof wanted.url,"%s",url); snprintf(wanted.headers,sizeof wanted.headers,"%s",headers ? headers : "");
  for (unsigned i=0;i<sizeof entropy;i++) snprintf(wanted.id+2*i,3,"%02x",entropy[i]);
  active = pending = 1; resultReady = 0; pthread_cond_signal(&wake); pthread_mutex_unlock(&lock); return 1;
}
int pcaudio_buscar(double seconds) {
  Request r;
  pthread_mutex_lock(&lock); r = wanted; int yes = active; pthread_mutex_unlock(&lock);
  return yes && pcaudio_iniciar(r.url,r.headers,seconds);
}
void pcaudio_falhar(const char *message) {
  pcaudio_parar(); pthread_mutex_lock(&lock); active = resultReady = 1;
  memset(&result,0,sizeof result); snprintf(result.error,sizeof result.error,"%s",message);
  pthread_mutex_unlock(&lock);
}
void pcaudio_parar(void) {
  pthread_mutex_lock(&lock); ++generation; memset(&wanted,0,sizeof wanted);
  active = pending = resultReady = 0; pthread_cond_signal(&wake); pthread_mutex_unlock(&lock);
}
int pcaudio_ativo(void) { pthread_mutex_lock(&lock); int v = active; pthread_mutex_unlock(&lock); return v; }
int pcaudio_pendente(void) { pthread_mutex_lock(&lock); int v = pending; pthread_mutex_unlock(&lock); return v; }
int pcaudio_receber(PcAudioResult *out) {
  pthread_mutex_lock(&lock); int yes = resultReady;
  if (yes) { *out = result; resultReady = 0; }
  pthread_mutex_unlock(&lock); return yes;
}
#else
int pcaudio_configurar(const char *p) { (void)p; return 0; }
const char *pcaudio_servidor(void) { return ""; }
int pcaudio_configurado(void) { return 0; }
int pcaudio_iniciar(const char *u,const char *h,double s) { (void)u;(void)h;(void)s;return 0; }
int pcaudio_buscar(double s) { (void)s; return 0; }
void pcaudio_parar(void) {}
void pcaudio_falhar(const char *s) { (void)s; }
int pcaudio_ativo(void) { return 0; }
int pcaudio_pendente(void) { return 0; }
int pcaudio_receber(PcAudioResult *r) { (void)r; return 0; }
#endif
